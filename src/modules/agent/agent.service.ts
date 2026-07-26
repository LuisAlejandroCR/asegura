import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import { INlpProvider, InsuranceIntent } from '../nlp/types';
import { TelegramAdapter } from '../channel/telegram-adapter.service';
import { ReminderService } from '../channel/reminder.service';
import { NormalizedMessage } from '../channel/types';
import { ConversationService } from './conversation.service';
import { ConversationState, ConversationContext, PetDetail, DocumentType } from './types';
import { STATE_RESPONSES, formatNameList } from './conversation-state.machine';
import { pickPersistentFields } from './persistent-context';
import { QuotingService } from '../quoting/quoting.service';
import { AffiliateLookupService } from '../quoting/affiliate-lookup.service';
import { PolicyService } from '../policy/policy.service';
import { WompiService } from '../payments/wompi.service';
import { AffiliateSignals, InsuranceProduct, InsuranceScore } from '../quoting/types';
import { PRODUCTS } from '../quoting/products.data';
import { computeTotalPremium } from '../quoting/pricing';
import { matchBreed } from './breed-matcher';

interface ProcessResult {
  text?: string;
  texts?: string[];  // send multiple sequential messages (e.g. greeting + authorization)
  nextState?: ConversationState;
  context?: ConversationContext;
  document?: { buffer: Buffer; filename: string };
  // When set, `text` is sent via the Telegram native contact-share button instead of a
  // plain message (2026-07-24 KYC feedback — see AgentService's phone-verification gate).
  requestContact?: boolean;
  // When set, reacts to the triggering message with this emoji (2026-07-24 feedback — a
  // lightweight "animated success" touch, e.g. on the selfie photo itself).
  reaction?: string;
  // Upgrades `reaction` to Telegram's "big" reaction (a much larger animated burst) —
  // used for the phone/contact-share confirmation.
  reactionBig?: boolean;
  // When set, sends this local video file as a Telegram animation (2026-07-24 feedback —
  // a real branded success-checkmark clip, used for the selfie-confirmed and
  // Tarjeta Colsubsidio moments — heavier than `reaction`, so only where explicitly asked).
  animation?: string;
  // 2026-07-26 hybrid buttons (Step 4) — when set, `text` is sent via a Telegram reply
  // keyboard offering these as tappable shortcuts. A tap arrives back as an ordinary text
  // message on the same webhook — free text/voice remain fully valid answers too; no
  // button is ever mandatory (rule #10).
  choices?: string[];
  // 2026-07-26 stuck-loop circuit breaker — set when this specific reply means "the agent
  // genuinely didn't understand / doesn't have the answer", never for a normal
  // acknowledgment or a deliberate polite decline. handleMessage tallies consecutive
  // occurrences (ConversationContext.consecutiveUnclearReplies) and escalates to a human
  // once the streak crosses the threshold — see applyCircuitBreaker.
  unclearReply?: boolean;
}

// Static brand assets — referenced relative to the project root (not __dirname) because
// nest-cli.json doesn't copy non-.ts assets into dist/, and the server runs `node dist/main`
// from the project root, so `src/assets/` is reachable at runtime via process.cwd()
// (same convention as pdf.service.ts's IMAGES_DIR). Each has its own baked-in text label
// (2026-07-24 feedback) — no separate "confirmed" text message needed alongside it.
const IDENTITY_ANIMATION_PATH = path.join(process.cwd(), 'src', 'assets', 'identity-confirmed.mp4');
const PAYMENT_ANIMATION_PATH = path.join(process.cwd(), 'src', 'assets', 'payment-received.mp4');

// 2026-07-26 Step 4 — F01 hybrid-filter buttons, presented once at AUTHORIZATION→
// isAffirmative. Only categories the real catalog can actually sell (rule #12): no
// vehículo/viaje/patrimonio/hogar product exists, so those spec categories are
// deliberately not offered as buttons (free text can still ask about them — see
// detectOutOfCatalogCategory's honest decline). Exported (not just a class constant) so
// the label→parser invariant test (groq-nlp.service.spec.ts) shares this exact array as
// its single source of truth — a label is a promise the parser must actually honor.
export const F01_CHOICES = ['❤️ Mi familia', '🏥 Mi salud', '🐾 Mi mascota', '🤕 Accidentes', '🤔 No estoy seguro'];

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    @Inject('INlpProvider')
    private readonly nlp: INlpProvider,
    private readonly telegram: TelegramAdapter,
    private readonly conversations: ConversationService,
    private readonly quoting: QuotingService,
    private readonly policy: PolicyService,
    private readonly wompi: WompiService,
    private readonly reminders: ReminderService,
    private readonly affiliateLookup: AffiliateLookupService,
    private readonly config: ConfigService,
  ) {}

  private static readonly TERMINAL_STATES = new Set([
    ConversationState.COMPLETED,
    ConversationState.ABANDONED,
    ConversationState.REJECTED,
  ]);

  // 2026-07-26 live-test bug: a meta-question about the quote already shown ("¿cuál es
  // mejor?", "cuéntame más de ellos", "explícame de qué se trata", "beneficios") carries
  // no affirmative/negative/alternative signal, so it used to fall through to a silent
  // re-show of the same product. Deterministic on purpose — this is a request for MORE
  // detail on what's already on screen, not a new category/product signal for the NLP
  // layer to classify.
  private static readonly MORE_INFO_PATTERN =
    /\b(cu[eé]ntame\s+m[aá]s|expl[ií]came|de\s+qu[eé]\s+se\s+trata|beneficios|cu[aá]l(?:\s+de\s+todos)?\s+es\s+mejor|mejor\s+para\s+m[ií])\b/i;

  // 2026-07-26 feature request: a COMPLETED customer asking about their OWN,
  // already-purchased policy ("¿qué cubre mi seguro de vida?", "cuéntame de mi póliza")
  // used to get the exact same generic "¡Todo listo!" text no matter what was actually
  // asked. Checked only in COMPLETED (processMessage's default: branch) — never confused
  // with MORE_INFO_PATTERN above, which answers about a product still being SHOPPED for.
  private static readonly POLICY_INQUIRY_PATTERN =
    /\b(mi p[oó]liza|mi seguro|lo que compr[eé]|lo que ya tengo|qu[eé]\s+cubre|c[oó]mo funciona mi|mi cobertura)\b/i;

  // 2026-07-26 live-test bug: "Prefiero la anterior.", "Quiero la primera opción que me
  // ofreciste.", "la que vale 16.800", "¿alguna más económica?" all reference a SPECIFIC
  // product already shown this conversation (or a cheaper one among them) — none of
  // these had a handler, so they either fell through to a blind re-show of the CURRENT
  // product, or worse, got matched as isAffirmative (confirming the wrong one — a bare
  // "quiero" substring match doesn't care that the price mentioned doesn't match what's
  // on screen). Checked deterministically, before isAffirmative/wantsAlternative, so an
  // explicit reference always wins over a probabilistic LLM guess — same override
  // philosophy as every other keyword trap already fixed in this file.
  private static readonly FIRST_OPTION_PATTERN = /\b(la primera(?:\s+opci[oó]n)?|el primero|primera opci[oó]n)\b/i;
  private static readonly PREVIOUS_OPTION_PATTERN = /\b(la anterior|el anterior|la de antes)\b/i;
  private static readonly CHEAPER_OPTION_PATTERN = /\b(m[aá]s econ[oó]mic\w*|m[aá]s barat\w*|m[aá]s accesible\w*|menos costos?)\b/i;

  // "16 mil algo" -> 16000, "$20.000" / "20000" -> 20000. Deliberately approximate (the
  // real live-test message was "la que valía 16 mil algo") — matched against shown
  // products within a tolerance in resolveProductReference, not required to be exact.
  private extractMentionedAmount(text: string): number | null {
    const milMatch = text.match(/\b(\d+)\s*mil\b/i);
    if (milMatch) return parseInt(milMatch[1], 10) * 1000;
    const digitsMatch = text.match(/\$?\s*(\d[\d.,]{3,})/);
    if (digitsMatch) {
      const cleaned = digitsMatch[1].replace(/[.,]/g, '');
      const n = parseInt(cleaned, 10);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  private resolveProductReference(
    text: string,
    context: ConversationContext,
  ): { product: InsuranceProduct; score: InsuranceScore } | null {
    const shownIds = context.shownProductIds ?? (context.quoteProductId ? [context.quoteProductId] : []);
    const shownProducts = shownIds
      .map((id) => PRODUCTS.find((p) => p.id === id))
      .filter((p): p is InsuranceProduct => !!p);
    if (shownProducts.length === 0) return null;

    // Cheap regex checks first, deciding WHICH product (if any) is referenced, before
    // ever calling the (comparatively expensive, and test-observable) scoring engine —
    // a message that matches none of these patterns must cost nothing extra.
    let resolved: InsuranceProduct | null = null;
    if (AgentService.FIRST_OPTION_PATTERN.test(text)) {
      resolved = shownProducts[0];
    } else if (AgentService.PREVIOUS_OPTION_PATTERN.test(text) && shownProducts.length >= 2) {
      resolved = shownProducts[shownProducts.length - 2];
    } else {
      const amount = this.extractMentionedAmount(text);
      if (amount !== null) {
        resolved = shownProducts.find((p) => Math.abs(p.basePremium - amount) <= 1000) ?? null;
      }
      if (!resolved && AgentService.CHEAPER_OPTION_PATTERN.test(text)) {
        const current = PRODUCTS.find((p) => p.id === context.quoteProductId);
        resolved = shownProducts
          .filter((p) => !current || p.basePremium < current.basePremium)
          .sort((a, b) => a.basePremium - b.basePremium)[0] ?? null;
      }
    }
    if (!resolved) return null;

    const allScores = this.quoting.score(context as AffiliateSignals);
    const score = allScores.find((s) => s.productId === resolved!.id)
      ?? { productId: resolved.id, matchScore: 0, reasons: [], monthlyPremium: resolved.basePremium, priority: 'low' as const };
    return { product: resolved, score };
  }


  async handleMessage(raw: unknown): Promise<void> {
    const msg: NormalizedMessage = await this.telegram.normalize(raw);

    if (msg.unsupportedInput) {
      const text = msg.unsupportedInput === 'audio_too_long'
        ? 'Solo puedo procesar audios cortos. Intenta de nuevo.'
        : 'No puedo leer imágenes, solo audio o texto. Intenta de nuevo.';
      await this.telegram.sendText(msg.userId, text);
      return;
    }

    // A contact-share (KYC) or a photo (cosmetic selfie-KYC) message carries no text at
    // all — let it through instead of the usual empty-text bail, since AgentService
    // needs to see it.
    if (!msg.text && !msg.contact && !msg.photo) return;

    this.logger.log(`Message from ${msg.userId}: "${msg.text.slice(0, 80)}"`);

    const conv = await this.conversations.getOrCreate(msg.userId, msg.channel);
    // 2026-07-25 feature request: any incoming message proves the user is still here —
    // cancel whatever "come back to chat" reminder was pending before scheduling a fresh
    // one below for the response about to go out.
    this.reminders.cancel(conv.id);
    const lowerText = msg.text.toLowerCase().trim().replace(/[.,!?¡¿:;]+$/, '').trim();
    const rawText = msg.text.trim().replace(/[.,!?¡¿:;]+$/, '').trim();
    const intent: InsuranceIntent = msg.text
      ? await this.nlp.extractIntent(msg.text, conv.context.lastMessages)
      : {
          productCategory: null, coverage: [], beneficiaries: 1, urgency: 'exploring',
          isAffirmative: false, isNegative: false, wantsAlternative: false, petResolution: null,
        };

    const rawResult = await this.processMessage(conv.id, conv.state, conv.context, lowerText, intent, msg.contact, msg.photo, rawText);
    const result = this.applyCircuitBreaker(conv.context, rawResult, msg, conv.state);

    // Maintain conversation history (last N exchanges, session-scoped). Read from the
    // context that will be persisted — on restart, result.context drops lastMessages via
    // pickPersistentFields, so old history is not carried across a restart.
    const lastMessages = [...((result.context ?? conv.context).lastMessages ?? [])];
    if (msg.text) {
      lastMessages.push({ role: 'user', text: msg.text });
    }
    const replyText = result.texts?.[0] ?? result.text;
    if (replyText) {
      lastMessages.push({ role: 'agent', text: replyText });
    }
    const MAX_EXCHANGES = 10;
    const trimmed = lastMessages.length > MAX_EXCHANGES * 2
      ? lastMessages.slice(-(MAX_EXCHANGES * 2))
      : lastMessages;

    // Persist state/context whenever either changes
    if (result.nextState || result.context) {
      await this.conversations.saveState(
        conv.id,
        result.nextState ?? conv.state,
        { ...(result.context ?? conv.context), lastMessages: trimmed },
      );
    }

    if (result.document) {
      await this.telegram.sendDocument(msg.userId, result.document.buffer, result.document.filename);
    }

    if (result.animation) {
      await this.telegram.sendAnimation(msg.userId, result.animation);
    }

    if (result.reaction && msg.messageId !== undefined) {
      await this.telegram.reactToMessage(msg.userId, msg.messageId, result.reaction, result.reactionBig);
    }

    if (result.requestContact && result.text) {
      await this.telegram.sendContactRequest(msg.userId, result.text);
    } else if (result.choices?.length && result.text) {
      await this.telegram.sendChoices(msg.userId, result.text, result.choices);
    } else if (result.texts?.length) {
      for (const t of result.texts) {
        await this.telegram.sendText(msg.userId, t);
      }
    } else if (result.text) {
      await this.telegram.sendText(msg.userId, result.text);
    }

    // Arm the "come back to chat" reminder for whatever state the conversation is in now
    // — skipped once it's actually over, since nudging someone who already finished (or
    // was rejected/abandoned) has no point.
    const finalState = result.nextState ?? conv.state;
    if (!AgentService.TERMINAL_STATES.has(finalState)) {
      // A real, still-unconfirmed Wompi link (checkoutUrl) means the conversation must
      // not auto-abandon on the regular 4-minute window — see PAYMENT_CLOSE_DELAY_MS.
      const finalContext = result.context ?? conv.context;
      this.reminders.schedule(conv.id, msg.userId, !!finalContext?.checkoutUrl);
    }
  }

  // 2026-07-26 live-test feedback: "if the agent doesn't have the info about the insurance
  // asked, redirect the chat to a human" — instead of repeating a variant of "no logré
  // entender" indefinitely. Counts ONLY turns a state handler explicitly flagged as
  // genuinely unclear (ProcessResult.unclearReply) — an answer that just needs a
  // follow-up question (e.g. DISCOVERY's madeProgress path) never counts, so a normal
  // multi-turn conversation never trips this.
  private static readonly UNCLEAR_REPLY_ESCALATION_THRESHOLD = 3;
  private static readonly ESCALATION_TEXT =
    'Parece que no te estoy ayudando bien, serás redirigido a mi líder de servicio 🙏';

  private applyCircuitBreaker(
    originalContext: ConversationContext,
    result: ProcessResult,
    msg: NormalizedMessage,
    currentState: ConversationState,
  ): ProcessResult {
    const priorCount = originalContext.consecutiveUnclearReplies ?? 0;

    if (!result.unclearReply) {
      // A genuinely understood reply resets the streak — only worth a context write when
      // there was actually a streak to clear.
      if (!priorCount) return result;
      return { ...result, context: { ...(result.context ?? originalContext), consecutiveUnclearReplies: 0 } };
    }

    const count = priorCount + 1;
    if (count >= AgentService.UNCLEAR_REPLY_ESCALATION_THRESHOLD) {
      this.notifyAdminEscalation(msg, currentState).catch((err) =>
        this.logger.warn(`Admin escalation notification failed: ${err}`),
      );
      return {
        text: AgentService.ESCALATION_TEXT,
        context: { ...(result.context ?? originalContext), consecutiveUnclearReplies: 0 },
      };
    }

    return { ...result, context: { ...(result.context ?? originalContext), consecutiveUnclearReplies: count } };
  }

  // Never blocks or breaks the real conversation flow if it fails or ADMIN_CHAT_ID isn't
  // configured — same optional-integration pattern as Wompi/Telegram/LLM elsewhere in
  // this codebase. Reuses telegram.sendText (a Telegram chat id IS just a numeric userId
  // to that adapter) instead of inventing a separate notification channel/integration.
  private async notifyAdminEscalation(msg: NormalizedMessage, state: ConversationState): Promise<void> {
    const adminChatId = this.config.get<string>('ADMIN_CHAT_ID');
    if (!adminChatId) return;
    const who = msg.username ? `@${msg.username} (id ${msg.userId})` : `id ${msg.userId}`;
    const text =
      `⚠️ *Escalación automática*\n\n` +
      `${who} lleva ${AgentService.UNCLEAR_REPLY_ESCALATION_THRESHOLD} turnos seguidos sin que el agente logre entenderlo.\n` +
      `Estado: ${state}\n` +
      `Último mensaje: "${msg.text.slice(0, 200)}"`;
    await this.telegram.sendText(adminChatId, text);
  }

  private async processMessage(
    convId: string,
    currentState: ConversationState,
    context: ConversationContext,
    text: string,
    intent: InsuranceIntent,
    contact?: NormalizedMessage['contact'],
    photo?: NormalizedMessage['photo'],
    rawText: string = text,
  ): Promise<ProcessResult> {
    if (
      intent.abandonIntent &&
      currentState !== ConversationState.GREETING &&
      currentState !== ConversationState.QUOTE_PRESENTED
    ) {
      // Real live-test bug (confirmed directly in the production Supabase conversations
      // table): two conversations that had ALREADY completed a real, Wompi-approved
      // purchase ended up with state='abandoned' after the customer later declined to buy
      // anything more — this check has no awareness a policy already exists.
      // "Abandoned before buying anything" and "bought something, then declined more"
      // must never share a conversation status.
      const terminalState = context.hasCompletedPurchase
        ? ConversationState.COMPLETED
        : ConversationState.ABANDONED;
      return {
        text: STATE_RESPONSES[terminalState](context),
        nextState: terminalState,
      };
    }

    switch (currentState) {
      case ConversationState.GREETING:
        // GREETING's own text already folds in the authorization ask (2026-07-24 — see
        // conversation-state.machine.ts) — sending AUTHORIZATION's text too would repeat it.
        return {
          text: STATE_RESPONSES[ConversationState.GREETING](context),
          nextState: ConversationState.AUTHORIZATION,
        };

      case ConversationState.AUTHORIZATION:
        // 2026-07-26 affiliate CSV lookup — one-shot question asked right after "sí",
        // before DISCOVERY starts. Handled first so a reply here is never re-interpreted
        // as a fresh yes/no answer to the Ley 1581 consent question below.
        if (context.awaitingAffiliateId) {
          return this.handleAffiliateId(context, text, rawText);
        }
        if (intent.isAffirmative) {
          return {
            // 2026-07-26 (feedback): the "puedes responder por texto o audio" reassurance
            // moved up into GREETING itself (conversation-state.machine.ts) — saying it
            // again here would be redundant two turns later.
            text: 'Ingresa tu ID si eres afiliado a Colsubsidio — así puedo ajustar mejor tu cotización. Si no lo eres, escríbeme *"no"*.',
            // discoveryFilter gates the new `dependents` question below (Step 3,
            // 2026-07-26) — set only here, on a fresh authorization, so a post-purchase
            // cross-sell (wompi-webhook.controller.ts, which never sets this field) keeps
            // quoting a returning buyer immediately, with no re-interrogation.
            context: { ...context, autorizado: true, discoveryFilter: true, awaitingAffiliateId: true },
          };
        }
        if (intent.isNegative) {
          return {
            text: STATE_RESPONSES[ConversationState.REJECTED](context),
            nextState: ConversationState.REJECTED,
            context: { ...context, autorizado: false },
          };
        }
        return {
          text: 'Para poder ayudarte necesito tu autorización. ¿Aceptas que consulte tu perfil de afiliado y te envíe cotizaciones?',
        };

      case ConversationState.DISCOVERY:
        return this.handleDiscovery(context, text, intent);

      case ConversationState.QUOTING:
      case ConversationState.QUOTE_PRESENTED:
        return this.handleQuotation(context, text, intent);

      case ConversationState.DATA_CAPTURE:
        return this.handleDataCapture(convId, context, text, intent, rawText, contact, photo);

      case ConversationState.PAYMENT:
        return this.handlePayment(convId, context, text, intent);

      default:
        // Real live-test bug (screenshot, 2026-07-26): ReminderService's auto-close
        // message explicitly promises "cuando quieras continuar, aquí estoy — 24/7" —
        // but ABANDONED/REJECTED only restarted on an EXACT hola/ayuda/inicio/start
        // match. Any real follow-up ("De todos los que me sugieres, ¿cuál es mejor?")
        // fell through to the static STATE_RESPONSES[currentState] text below with no
        // nextState returned, so the conversation stayed stuck on that same terminal
        // row forever — every later message got the identical canned reply. Restart
        // unconditionally here so the "aquí estoy" promise is actually true.
        //
        // COMPLETED is deliberately excluded: those conversations already hold real KYC
        // data (cédula/nombre/correo, hasCompletedPurchase) — blindly resetting context
        // would force a paying customer to redo verification. Left on the keyword-only
        // path; a proper "resume as returning customer" flow is separate future scope.
        if (currentState === ConversationState.ABANDONED || currentState === ConversationState.REJECTED) {
          // 2026-07-26 persistent memory (Diseño preguntas.docx: "la siguiente
          // conversación nunca debe empezar desde cero") -- carry forward the durable
          // profile facts (pets, dependents, budget, KYC, purchase history) instead of
          // wiping to {}. Session-scoped state (the quote in progress, one-shot KYC
          // gates, discoveryFilter, productCategory) still resets, since a fresh inquiry
          // may want something different this time.
          // Real live-test bug (2026-07-26, screenshot): this rendered the GREETING text
          // (which already folds in the authorization ask, same as case GREETING below)
          // but set nextState back to GREETING instead of AUTHORIZATION — so the user's
          // very next message (even an immediate "sí") got routed through case GREETING
          // again, which re-renders the IDENTICAL text a second time before finally
          // reaching AUTHORIZATION. Setting nextState: AUTHORIZATION here (matching case
          // GREETING's own one-shot pattern) shows the text exactly once, while still
          // requiring a fresh "sí" to re-confirm Ley 1581 consent (autorizado is
          // deliberately never carried over — see persistent-context.ts).
          const remembered = pickPersistentFields(context);
          return {
            text: STATE_RESPONSES[ConversationState.GREETING](remembered),
            nextState: ConversationState.AUTHORIZATION,
            context: remembered,
          };
        }
        // Checked BEFORE the hola/ayuda keyword restart below — "necesito ayuda con mi
        // póliza" is a real question about an existing purchase, not a request to start
        // over. Gated on purchasedProductIds (not policyId/policyIds, already cleared by
        // wompi-webhook.controller.ts for whatever purchase comes next in this
        // conversation) — see the field comment in types.ts.
        if (
          currentState === ConversationState.COMPLETED &&
          context.purchasedProductIds?.length &&
          AgentService.POLICY_INQUIRY_PATTERN.test(text)
        ) {
          return this.answerPolicyInquiry(context);
        }
        if (text.includes('hola') || text.includes('ayuda') || text.includes('inicio') || text === '/start') {
          // Same fix as the ABANDONED/REJECTED restart above: nextState: AUTHORIZATION
          // (not GREETING) so the greeting/authorization-ask text is shown exactly once,
          // not repeated verbatim on the next message.
          return {
            text: STATE_RESPONSES[ConversationState.GREETING](context),
            nextState: ConversationState.AUTHORIZATION,
          };
        }
        return {
          text: STATE_RESPONSES[currentState]?.(context) ?? STATE_RESPONSES[ConversationState.COMPLETED](context),
        };
    }
  }

  // ── Affiliate ID lookup ─────────────────────────────────────────────────────
  // 2026-07-26 — "nunca preguntar lo que ya sabemos" (Diseño preguntas.docx, Nivel 1)
  // for income: DISCOVERY's filter has no income question at all, so this is the one
  // signal Colsubsidio can supply directly if the user self-identifies with their
  // affiliate ID (looked up against SERIE in the synthetic affiliate CSV — see
  // AffiliateLookupService). A decline ("no"), an unrecognized-but-numeric ID, or the
  // lookup being disabled (missing CSV file) all proceed to DISCOVERY identically, just
  // without the rangoSalarial boost — same never-loop-forever contract as every other
  // one-shot gate in this file. A non-numeric, non-"no" answer does NOT proceed (see the
  // digit-shape guard below) — that's the one thing this gate actually rejects.
  //
  // 2026-07-26 — SERIE is a plain row number into the real affiliate CSV (1..500000,
  // matching its ~500K rows), NOT a document-length check like cédula's 6-10 digits.
  private static readonly MAX_SERIE = 500_000;

  private handleAffiliateId(context: ConversationContext, text: string, rawText: string): ProcessResult {
    const baseContext: ConversationContext = { ...context, awaitingAffiliateId: undefined };
    const declines = /^no\b/i.test(text.trim()) || !rawText.trim();

    if (!declines) {
      // Reuses the same digit-extraction convention as cédula (joinSpokenDigits handles
      // a number dictated one digit at a time by voice, e.g. "1, 2, 3, 4, 5, 6, 7, 8, 9.").
      const serie = this.joinSpokenDigits(rawText).replace(/\D/g, '');

      // Real live-test bug (2026-07-26): a non-numeric, non-"no" answer ("Juan" — either
      // a misheard voice transcription or a genuine misunderstanding of the question)
      // used to be silently treated as an implicit decline, advancing to DISCOVERY
      // without ever telling the user their answer didn't make sense. Only digits or an
      // explicit "no" may pass this gate now — same "never silently guess" contract as
      // cédula's own digit-shape validation a few turns later in this same flow. Range
      // is 1–MAX_SERIE (not a digit-count check like cédula's 6-10 — SERIE is a plain
      // sequential row number, 1..500000, matching the real CSV's row count, so most
      // real values are far shorter than 6 digits; a length-based check would reject
      // the majority of genuine SERIE values). Returns neither `context` nor
      // `nextState`, so handleMessage persists nothing — the conversation stays exactly
      // where it was and this same gate re-fires on the user's next message, never
      // silently letting them continue past an invalid answer.
      const serieNum = serie ? Number(serie) : NaN;
      if (!serie || !Number.isFinite(serieNum) || serieNum < 1 || serieNum > AgentService.MAX_SERIE) {
        return {
          text: `Tu ID de afiliado debe ser un número entre 1 y ${AgentService.MAX_SERIE.toLocaleString('es-CO')}. Si no eres afiliado, escríbeme "no".`,
        };
      }

      if (this.affiliateLookup.isEnabled()) {
        const record = this.affiliateLookup.findBySerie(serie);
        // 2026-07-26 feature request: "capture the complete row... so the agent will
        // know all about the registered user" — any match at all (not just one with
        // rangoSalarial/dependents) is enriched now; affiliateProfile carries the FULL
        // row forward (see types.ts), even the fields nothing else reads yet.
        if (record) {
          const enriched: ConversationContext = {
            ...baseContext,
            serieId: serie,
            cedula: serie,
            documentType: 'CC',
            affiliateProfile: record,
            ...(record.segmentoGrupoFamiliar !== undefined ? { segmentoGrupoFamiliar: record.segmentoGrupoFamiliar } : {}),
            ...(record.rangoSalarial !== undefined ? { rangoSalarial: record.rangoSalarial } : {}),
            // 2026-07-26: pre-fill dependents with askedDependents=true only for the
            // confidently-mapped known-zero case (AFILLIADO SIN GRUPO_FAMILIAR → 0 is
            // a precise signal from Colsubsidio's registration system). For family-segment
            // minimums (FAMILIA MONOPARENTAL → 1, FAMILIA NUCLEAR INTEGRAL → 1), the
            // value lives in affiliateProfile.dependents as a conservative fallback — the
            // live question is still asked so a real user answer wins when available.
            ...(record.segmentoGrupoFamiliar === 'AFILLIADO SIN GRUPO_FAMILIAR' && baseContext.dependents === undefined
              ? { dependents: 0, askedDependents: true }
              : {}),
            ...(record.petCount !== undefined && baseContext.petCount === undefined
              ? { petCount: record.petCount }
              : {}),
          };
          return {
            text: `¡Encontré tu perfil! Esto me ayuda a personalizar mejor tu cotización.\n\n${STATE_RESPONSES[ConversationState.DISCOVERY](enriched)}`,
            nextState: ConversationState.DISCOVERY,
            context: enriched,
            choices: F01_CHOICES,
          };
        }
      }
    }

    return {
      text: STATE_RESPONSES[ConversationState.DISCOVERY](baseContext),
      nextState: ConversationState.DISCOVERY,
      context: baseContext,
      choices: F01_CHOICES,
    };
  }

  // ── Discovery ────────────────────────────────────────────────────────────────

  private handleDiscovery(
    context: ConversationContext,
    text: string,
    intent: InsuranceIntent,
  ): ProcessResult {
    const newContext: ConversationContext = { ...context };

    // Real live-test bug: after a purchase, wompi-webhook.controller.ts asks "¿Quieres
    // proteger algo más?" and resets to DISCOVERY — a decline ("No, está bien así.") fell
    // through to DISCOVERY's generic "no entendí" acknowledgment below, reading as the
    // agent ignoring a clear, polite "I'm done" right after a purchase. Only fires when
    // the reply is a genuine decline with no new category named in the same breath (e.g.
    // "no, quiero vida" still proceeds to quote vida, not end the conversation) — always
    // clears the flag either way so it can never linger and hijack an unrelated later "no".
    if (context.awaitingCrossSellResponse) {
      // Real live-test bug: Groq's isNegative classification has no prompt example
      // covering elliptical negations ("No, ningún otro. Gracias.", "No, no estoy
      // interesado en ningún.") — both were misclassified as isNegative=false, so the
      // decline went unrecognized, the one-shot flag was consumed anyway, and the
      // conversation kept cycling instead of ending on the very first "no". A message
      // that starts with the standalone word "no" is an unambiguous decline regardless
      // of what the LLM extracted.
      const clearlyDeclines = intent.isNegative || /^no\b/i.test(text.trim());
      // Real live-test bug (2026-07-26): this used to trust `intent.productCategory`
      // directly — but Groq occasionally hallucinates SOME category from a decline that
      // names no product at all ("No, la póliza está mal." has zero category words).
      // That silently defeated the decline check, cleared the one-shot flag, and let the
      // conversation fall through into a fresh quote for the stale `quoteProductId` still
      // sitting in context — which is how a customer who said their policy was WRONG
      // ended up with a second Wompi payment link for the exact same product. Requiring
      // real textual evidence (the same deterministic check handleQuotation's own
      // cross-sell trigger already uses) means only an actual "no, quiero vida" — not a
      // guess with no textual basis — can override the decline.
      const mentionsRealCategory = this.detectAllMentionedCategories(text).length > 0;
      const declining = clearlyDeclines && !mentionsRealCategory;
      if (declining) {
        return {
          text: '¡Perfecto! Si más adelante quieres proteger algo más, aquí estoy 24/7. ¡Que tengas un excelente día! 👋',
          nextState: ConversationState.COMPLETED,
          context: { ...newContext, awaitingCrossSellResponse: undefined },
        };
      }
      newContext.awaitingCrossSellResponse = undefined;
    }

    // Real live-test bug: a user answering plain "no" to the opening question ("¿Tienes
    // familia o personas que dependen de ti?...") got the exact same question repeated
    // verbatim (the generic "no logré entender" fallback below) instead of a warm pivot —
    // "no dependents" is a valid, common answer, not unclear input that needs re-asking.
    // Scoped to early/fresh DISCOVERY only (nothing gathered yet, and not the post-purchase
    // cross-sell path handled above) so it never hijacks a later "no" mid-conversation.
    if (
      !context.awaitingCrossSellResponse &&
      intent.isNegative &&
      !intent.productCategory &&
      !context.productCategory &&
      !context.coverage?.length &&
      !context.petType
    ) {
      return {
        text: 'No hay problema — igual puedes protegerte a ti mismo. ¿Qué es lo que más te preocupa: tu salud, tu ingreso, tu hogar o tus mascotas?',
        context: newContext,
      };
    }

    // Real live-test bug (2026-07-26): the symmetric case was missing — a user answering
    // "Sí?" (or any other plain affirmative) to "¿Tienes familia o personas que dependen
    // de ti?" got no acknowledgment at all: "yes" alone names no category, so it fell
    // through everything below to the generic "No logré entender bien eso." fallback,
    // which then just repeats the ENTIRE compound question verbatim — reading as the
    // agent ignoring a clear answer. A follow-up free-text reply (e.g. "1 millón",
    // mistaking "tu ingreso" — a category to protect — for a request to state an income
    // figure) carries no category either, so the loop could repeat indefinitely with no
    // acknowledgment and no clearer ask. Same scoping as the negative pivot above: only
    // fresh/early DISCOVERY, never mid-conversation.
    if (
      !context.awaitingCrossSellResponse &&
      intent.isAffirmative &&
      !intent.productCategory &&
      !context.productCategory &&
      !context.coverage?.length &&
      !context.petType
    ) {
      return {
        text: '¡Perfecto! ¿Qué es lo que más te preocupa proteger — tu salud, tu ingreso, tu hogar o tus mascotas?',
        context: newContext,
      };
    }

    if (!context.productCategory && intent.productCategory) newContext.productCategory = intent.productCategory;
    // Handle clarification response when we already know it's a mixed-pet household
    if (context.petType === 'mixto') {
      if (intent.petResolution === 'gato') {
        newContext.petType = 'gato';
      } else if (intent.petResolution === 'perro') {
        newContext.petType = 'perro';
      } else if (intent.petResolution === 'all') {
        newContext.petType = null;
      } else if (intent.petType && intent.petType !== 'mixto') {
        newContext.petType = intent.petType;
      } else {
        return {
          text: '¿Para cuál mascota? Escríbeme "el gato", "los perros" o "para todos".',
          context,
        };
      }
      if (!newContext.coverage?.length) newContext.coverage = ['medicina veterinaria'];

      // Real live-test bug: "para todos" for a genuinely mixed household (a real gato
      // AND perro count both known) must quote BOTH species-specific products at their
      // own price, not fall through to bestQuote's single-product pick (previously
      // always won by whichever product happened to tie-break first in the catalog,
      // multiplied by the combined total — charging the wrong species the wrong price).
      if (intent.petResolution === 'all' && context.petSpeciesCounts?.gato && context.petSpeciesCounts?.perro) {
        return this.buildMixedSpeciesQuote(newContext);
      }
    } else {
      if (!context.petType && intent.petType) {
        // Guard: if coverage is already set, pet was resolved in a previous turn.
        // Re-setting petType to 'mixto' here would restart the clarification loop
        // when context.petType was lost (e.g., after a server restart).
        if (intent.petType === 'mixto' && newContext.coverage?.length) {
          // skip — treat as already-resolved; let hasEnoughInfo + bestQuote handle it
        } else {
          newContext.petType = intent.petType;
        }
      }
      // Real live-test bug: "Tengo dos perros, una gata y yo." quoted a SINGLE product
      // (whichever won bestQuote's tie-break) multiplied by the TOTAL pet count, charging
      // the dogs at the cat rate. Capture the per-species breakdown right now, while the
      // original message naming both species is still available — it's gone by the time
      // "para todos" answers the clarification question below.
      if (newContext.petType === 'mixto') {
        const counts = this.extractSpeciesCounts(text);
        if (counts.gato > 0 || counts.perro > 0) newContext.petSpeciesCounts = counts;
      }
    }

    if (!context.coverage && intent.coverage?.length) newContext.coverage = intent.coverage;
    if (!context.beneficiaries && intent.beneficiaries > 0) newContext.beneficiaries = intent.beneficiaries;
    if (!context.budget && intent.budget) newContext.budget = intent.budget;
    if (!context.petCount && intent.petCount && intent.petCount > 0) newContext.petCount = intent.petCount;
    // 2026-07-26 (Matriz 2, C05) — "immediate" always wins over a stale "exploring" from
    // an earlier turn in the same conversation; a later message signaling real urgency
    // must not be silently ignored just because an earlier one didn't.
    if (intent.urgency === 'immediate') newContext.urgency = 'immediate';
    else if (!newContext.urgency && intent.urgency) newContext.urgency = intent.urgency;
    // Step 3 (2026-07-26): capture the answer to the new "¿cuántas personas dependen de
    // ti?" question. `=== undefined` (not falsy) so a real answer of 0 ("vivo solo") is
    // still captured, not treated as "never asked".
    if (newContext.dependents === undefined && intent.dependents !== null && intent.dependents !== undefined) {
      newContext.dependents = intent.dependents;
      // Wakes the existing "Cubre a N personas" family reason (quoting.service.ts) too,
      // without a separate beneficiaries question — the dependents answer already
      // implies a household size. `<= 1` (not just falsy) because Groq's OWN JSON schema
      // shows "beneficiaries": 1 as an example value the LLM often defaults to with no
      // real signal (see the comment on this elsewhere in this file) — that spurious
      // default must not block the real, deliberately-answered dependents signal from
      // taking over. A genuinely-stated larger beneficiaries count (>1) is left alone.
      if (intent.dependents > 0 && (!newContext.beneficiaries || newContext.beneficiaries <= 1)) {
        newContext.beneficiaries = intent.dependents + 1;
      }
    }

    // 2026-07-26: CSV fallback when the dependents question was asked but the user
    // didn't give a parseable answer. affiliateProfile.dependents carries a conservative
    // minimum from the CSV's SEGMENTO_GRUPO_FAMILIAR (e.g. FAMILIA MONOPARENTAL → 1).
    // Only fires when askedDependents === true (question was actually asked) — never
    // for the AFILLIADO SIN GRUPO_FAMILIAR / dependents=0 case which already pre-filled
    // above in handleAffiliateId. Also fires on user-provided 0 ("vivo solo") because
    // the live answer of 0 IS parsed and captured at line 715 already — the fallback
    // only activates when dependents is STILL undefined after probing.
    if (newContext.dependents === undefined && newContext.askedDependents) {
      const fallback = newContext.affiliateProfile?.dependents;
      if (fallback !== undefined) {
        newContext.dependents = fallback;
        if (fallback > 0 && (!newContext.beneficiaries || newContext.beneficiaries <= 1)) {
          newContext.beneficiaries = fallback + 1;
        }
      }
    }

    // Infer productCategory when NLP didn't extract it explicitly
    if (!newContext.productCategory) {
      if (newContext.petType === 'gato' || newContext.petType === 'perro') {
        newContext.productCategory = 'mascotas';
      } else {
        // Coverage-based inference: 'medicina veterinaria' → mascotas (set in mixto resolution)
        const cov = (newContext.coverage ?? []).join(' ').toLowerCase();
        if (['veterinar', 'mascota'].some(k => cov.includes(k))) {
          newContext.productCategory = 'mascotas';
        }
        // Original context petType before it was cleared by 'all' resolution
        if (!newContext.productCategory && (context.petType === 'mixto' || context.petType === 'gato' || context.petType === 'perro')) {
          newContext.productCategory = 'mascotas';
        }
      }
    }

    // Catalog-honesty bridge (2026-07-26): "quiero asegurar mi carro" during DISCOVERY had
    // no branch at all — no vehicular/empresa product exists, so it silently extracted no
    // category and looped on the generic tier-1 question forever. QUOTE_PRESENTED already
    // has this exact check (detectOutOfCatalogCategory); DISCOVERY never did. Guarded on
    // productCategory still being unresolved so a real life story like "tengo dos hijos y
    // una empresa" isn't hijacked by the 'empresa' keyword once vida/mascotas/etc. already
    // matched something above.
    if (!newContext.productCategory) {
      const outOfCatalog = this.detectOutOfCatalogCategory(text);
      if (outOfCatalog) {
        return {
          text: `Por ahora no tengo seguros de ${outOfCatalog}, pero sí tengo vida, accidentes, asistencia médica y mascotas. ¿Te interesa alguno de estos?`,
          context: newContext,
        };
      }
    }

    // First time detecting mixed pets — ask clarification before quoting
    if (newContext.petType === 'mixto') {
      return {
        text: '¡Qué bonita familia de mascotas! 🐱🐶 ¿Para cuál quieres el seguro? ¿Solo los gatos, solo los perros, o quieres cotizar para todos por separado?',
        context: newContext,
      };
    }

    // Must know the species before quoting mascotas — the real catalog has cat-only and
    // dog-only products (medicina-prepagada-gatos / medicina-prepagada-perros) alongside
    // a generic one; quoting blind risks missing the more specific, better-matching
    // product and skips exactly the per-profile personalization judges look for. Real
    // live-test gap: "Tengo dos mascotas y yo." went straight to a quote without the
    // agent ever learning cat/dog/mixed.
    //
    // Gated on `!newContext.coverage?.length` too, reusing the same "coverage already set
    // means pet resolution already happened" signal used elsewhere in this method — the
    // mixto clarification's "para todos" answer deliberately resolves petType back to
    // null (quote generically, don't filter by species) and always sets coverage, so
    // this must not re-ask in that case or after the coverage-survived-a-restart path.
    if (newContext.productCategory === 'mascotas' && !newContext.petType && !newContext.coverage?.length) {
      return {
        text: '¿Tus mascotas son gatos, perros, o tienes de ambos? Así te muestro la cobertura correcta.',
        context: newContext,
      };
    }

    // Step 3 (2026-07-26 hiperperfilamiento subset): ask about dependents ONCE, only in
    // the new hybrid-filter flow (`discoveryFilter` — see AUTHORIZATION), and only when
    // it could actually change the recommendation. Dependents don't affect a mascotas
    // recommendation (spec Principle #3: "formular únicamente preguntas que cambien la
    // recomendación"), so that category is excluded here. `askedDependents` is set in
    // THIS SAME return, so the next turn always proceeds to quote regardless of whether
    // the answer parsed — the same never-loop-forever contract every KYC gate in this
    // file already carries.
    if (
      newContext.discoveryFilter &&
      !newContext.askedDependents &&
      newContext.dependents === undefined &&
      newContext.productCategory &&
      newContext.productCategory !== 'mascotas'
    ) {
      return {
        text: '¿Cuántas personas dependen de ti económicamente? (pareja, hijos, papás a cargo...)',
        context: { ...newContext, askedDependents: true },
      };
    }

    // coverage is NOT required to score a product — QuotingService.evaluateProduct only
    // needs productCategory to return a matchScore > 0; coverage is a bonus there, not a
    // gate. Requiring it here used to strand every non-mascota quote in an infinite
    // DISCOVERY loop whenever GroqNlpService.fallbackIntent() ran (it never fills
    // coverage at all — real live-test bug, e.g. "vida, accidentes y asistencia médica").
    const hasEnoughInfo = !!newContext.productCategory;

    // Dead-end guard: STATE_RESPONSES[DISCOVERY]'s third tier ("¿En qué rango de edades
    // están?") fires once coverage AND beneficiaries are both known — but no field in the
    // NLP intent schema captures a human beneficiary's age (only petAge, for pets), and
    // QuotingService never uses ages at all. If productCategory still never got extracted
    // by this point, that question is permanently unanswerable — every reply loops back to
    // it forever (real live-test bug: repeated indefinitely across "todos", ages, etc. with
    // productCategory never set). Attempt a best-effort quote instead of asking it.
    const stuckWithoutCategory = !hasEnoughInfo && !!newContext.coverage?.length && !!newContext.beneficiaries;

    if (hasEnoughInfo || stuckWithoutCategory) {
      const quote = this.quoting.bestQuote(newContext as AffiliateSignals);
      if (quote) {
        newContext.quoteProductId = quote.product.id;
        // Append to (not replace) shownProductIds — a pet product shown before a
        // cross-sell reset must stay in history for a later "los dos" reference.
        newContext.shownProductIds = [...new Set([...(context.shownProductIds ?? []), quote.product.id])];
        return {
          text: this.formatQuote(quote.product, quote.score, newContext),
          nextState: ConversationState.QUOTE_PRESENTED,
          context: newContext,
        };
      }
      // No match for this profile — reset category/coverage and let user redirect
      return {
        text: 'No encontré una opción exacta para ese perfil en el catálogo actual. ¿Quieres que busquemos algo diferente — vida, accidentes, asistencia médica?',
        context: { ...newContext, productCategory: undefined, coverage: undefined },
      };
    }

    // No new signal extracted this turn (e.g. unclear/short voice transcription) —
    // acknowledge instead of silently repeating the exact same question, which reads
    // as the agent ignoring the user. `beneficiaries` is excluded: Groq's JSON schema
    // shows "beneficiaries": 1 as an example value, so the LLM often defaults to 1
    // even when the message carries no real signal — it's not a reliable progress marker.
    const madeProgress =
      newContext.productCategory !== context.productCategory ||
      newContext.petType !== context.petType ||
      (newContext.coverage?.length ?? 0) !== (context.coverage?.length ?? 0) ||
      newContext.budget !== context.budget ||
      newContext.petCount !== context.petCount;

    const question = STATE_RESPONSES[ConversationState.DISCOVERY](newContext);
    return {
      text: madeProgress ? question : `No logré entender bien eso. ${question}`,
      context: newContext,
      // Only the genuinely-stuck branch counts toward the escalation circuit breaker —
      // `madeProgress` means real signal WAS extracted this turn, just not enough to quote
      // yet, which is normal conversation flow, not confusion.
      unclearReply: !madeProgress,
    };
  }

  // ── Quotation ────────────────────────────────────────────────────────────────

  private handleQuotation(context: ConversationContext, text: string, intent: InsuranceIntent): ProcessResult {
    const currentProduct = PRODUCTS.find((p) => p.id === context.quoteProductId);

    // Real live-test bug (screenshot, 2026-07-25): "salir" then "terminar", sent right
    // after a quote was shown, got the IDENTICAL quote card re-shown verbatim both times
    // — no branch below ever checked intent.abandonIntent. The top-level check in
    // processMessage explicitly excludes QUOTE_PRESENTED (it has its own richer
    // isAffirmative/isNegative/wantsAlternative branching), so an unambiguous exit word
    // fell through everything to the neutral catch-all, which just re-shows the quote.
    if (intent.abandonIntent) {
      const terminalState = context.hasCompletedPurchase
        ? ConversationState.COMPLETED
        : ConversationState.ABANDONED;
      return {
        text: STATE_RESPONSES[terminalState](context),
        nextState: terminalState,
      };
    }

    // Real live-test bug (screenshot, 2026-07-25/26): "No, pero no tengo gatos. No sé
    // por qué pensaste que tenía gatos..." while a gato-specific quote was showing got
    // the IDENTICAL quote re-shown verbatim — this multi-clause correction didn't trip
    // Groq's own isNegative/isAffirmative/wantsAlternative classification (none of the
    // branches below fired), so it fell through to the generic re-show at the bottom.
    // An explicit "no tengo <the exact species just quoted>" is unambiguous regardless
    // of what the LLM extracted — same override policy as abandonIntent above. Resets
    // petType/coverage/the quote itself so DISCOVERY re-asks cleanly instead of
    // insisting on an assumption the user just corrected.
    if (currentProduct?.category === 'mascotas' && context.petType && this.deniesCurrentPetType(text, context.petType)) {
      return {
        text: '¡Perdón por la confusión! Cuéntame — ¿qué mascota tienes entonces?',
        nextState: ConversationState.DISCOVERY,
        context: {
          ...context,
          petType: undefined,
          petSpeciesCounts: undefined,
          coverage: undefined,
          quoteProductId: undefined,
          shownProductIds: undefined,
        },
      };
    }

    // 2026-07-24 "restore the flow": a quote in progress is never interrupted by a
    // mention of a DIFFERENT category anymore — it's deferred until after this purchase
    // is fully paid and the policy is issued (see wompi-webhook.controller.ts
    // notifyPoliciesIssued, which reads context.pendingCrossSell). Real live-test bug:
    // "para mí, qué hay" / naming a different category mid-quote used to immediately
    // replace the current quote, so an unconfirmed mascotas purchase was silently
    // abandoned before ever reaching payment — "continue offering products when I
    // already chose". Close one deal at a time, then offer the next.
    if (currentProduct?.category === 'mascotas' && this.mentionsPersonalCoverage(text)) {
      const deferred = (intent.productCategory && intent.productCategory !== 'mascotas')
        ? intent.productCategory
        : this.detectAllMentionedCategories(text).find((c) => c !== 'mascotas') ?? null;
      return this.deferCrossSell(context, currentProduct, deferred);
    }

    if (
      intent.productCategory &&
      currentProduct &&
      intent.productCategory !== currentProduct.category &&
      this.detectAllMentionedCategories(text).includes(intent.productCategory)
    ) {
      return this.deferCrossSell(context, currentProduct, intent.productCategory);
    }

    // Real live-test bug (2026-07-26): "Prefiero la anterior.", "Quiero la primera opción
    // que me ofreciste.", "la que vale 16.800" all reference a SPECIFIC already-shown
    // product — checked before isAffirmative so "quiero la que vale 16.800" can't get
    // matched as a blind confirmation of whatever DIFFERENTLY-priced product happens to
    // be on screen (the real live-test bug: a customer naming the $16.800 option ended up
    // confirming a $20.000 purchase instead). Only fires when the reference resolves to a
    // DIFFERENT product than what's already showing — otherwise falls through normally.
    const referenced = this.resolveProductReference(text, context);
    if (referenced && referenced.product.id !== context.quoteProductId) {
      const shown = context.shownProductIds ?? (context.quoteProductId ? [context.quoteProductId] : []);
      return {
        text: this.formatQuote(referenced.product, referenced.score, context),
        nextState: ConversationState.QUOTE_PRESENTED,
        context: { ...context, quoteProductId: referenced.product.id, shownProductIds: [...new Set([...shown, referenced.product.id])] },
      };
    }

    if (intent.isAffirmative) {
      // 2026-07-24 KYC feedback: "know the user is real" before collecting cédula/nombre/
      // correo — Telegram's native request_contact button verifies the phone in one tap,
      // no separate SMS/Twilio provider. Fires once per conversation; a returning customer
      // on a second purchase (phoneVerified already true) skips straight to the real prompt.
      if (!context.phoneVerified) {
        return {
          text: 'Antes de continuar, confirmemos que eres tú — toca el botón para compartir tu número de Telegram (ya verificado, no necesitas escribir nada) 👇',
          nextState: ConversationState.DATA_CAPTURE,
          context: { ...context, awaitingPhoneVerification: true },
          requestContact: true,
        };
      }
      return {
        text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](context),
        nextState: ConversationState.DATA_CAPTURE,
      };
    }

    if (intent.wantsAlternative) {
      // Real live-test bug (2026-07-26): "otro" during an active mixed-species purchase
      // (context.selectedProductIds has BOTH medicina-prepagada products, from
      // buildMixedSpeciesQuote) used to search for a totally unrelated THIRD product
      // (e.g. asistencia-veterinaria) and price it against the raw cross-species
      // petCount — a wildly wrong total, AND a real consent mismatch: saying "sí" right
      // after would have confirmed the ORIGINAL 2-product purchase (this branch never
      // touched selectedProductIds), not the different product just shown. There's no
      // single "next best" alternative to a combined multi-species quote, so just
      // re-anchor on the one already active instead of hunting for a swap-in.
      if (context.selectedProductIds && context.selectedProductIds.length > 1) {
        return { text: this.formatMixedSpeciesQuote(context) };
      }

      const allScores = this.quoting.score(context as AffiliateSignals);
      const seen = context.shownProductIds ?? (context.quoteProductId ? [context.quoteProductId] : []);
      const nextProduct = allScores.find((s) => !seen.includes(s.productId));

      if (nextProduct) {
        const altProduct = PRODUCTS.find((p) => p.id === nextProduct.productId);
        if (altProduct) {
          return {
            text: this.formatQuote(altProduct, nextProduct, context),
            nextState: ConversationState.QUOTE_PRESENTED,
            context: { ...context, quoteProductId: altProduct.id, shownProductIds: [...seen, altProduct.id] },
          };
        }
      }

      // Real live-test bug (2026-07-26): this used to reset productCategory to undefined
      // and transition to DISCOVERY — the NEXT message (often something vague like
      // "quiero la primera opción que me ofreciste", naming no real category at all)
      // could then get a HALLUCINATED productCategory from the LLM and silently start a
      // brand-new, unrelated quote (an "asistencia" shopper ended up with "vida" this
      // way). Staying anchored in QUOTE_PRESENTED means resolveProductReference above and
      // the cross-sell-defer check both keep working on the next turn — a genuine new
      // category still switches correctly (it requires a real keyword match via
      // detectAllMentionedCategories), but an ambiguous non-answer can no longer hijack
      // the conversation into a different category.
      return {
        text: 'No tengo más opciones en esta categoría. ¿Quieres que busquemos en otra?',
      };
    }

    // Real live-test bug: a PLAIN decline ("No, está bien.") — no explicit request to see
    // another option — was treated exactly like wantsAlternative, cycling through every
    // remaining product in the category instead of ever letting the user go. AGENTS.md's
    // own UX rule ("respetar y ofrecer alternativa O cierre educado") always had a polite
    // close as a valid response to "no" — only the alternative half was ever built. A bare
    // decline now ends the conversation politely instead of pushing another product.
    if (intent.isNegative && !intent.isAffirmative) {
      // 2026-07-25 live-test bug: same class as the top-level abandonIntent check's
      // hasCompletedPurchase branch above — but that check explicitly skips
      // QUOTE_PRESENTED, so it never covered THIS branch. A customer who already has an
      // active, paid policy and simply declines a post-purchase cross-sell quote was
      // still getting the conversation marked ABANDONED instead of staying COMPLETED.
      const terminalState = context.hasCompletedPurchase
        ? ConversationState.COMPLETED
        : ConversationState.ABANDONED;
      return {
        text: STATE_RESPONSES[terminalState](context),
        nextState: terminalState,
      };
    }

    // Real live-test bug (2026-07-26): "¿Cuál es mejor?" / "Me interesan todos, cuéntame
    // más de ellos" / "Explícame de qué se trata" had no branch at all — none of these
    // carry an isAffirmative/isNegative/wantsAlternative signal, so they fell through to
    // the neutral re-show below, which is always the SAME single product (bestQuote only
    // ever returns the top-scored one) — read by the user as "va como por el más
    // completo" no matter what was actually asked. Answer with the real product detail
    // (full coverage list + persuasive reason) instead of a silent re-show.
    if (currentProduct && AgentService.MORE_INFO_PATTERN.test(text)) {
      return { text: this.formatProductDetail(currentProduct, context) };
    }

    // Real bug found 2026-07-24 (confirmed independently by a live test session and a
    // teammate's findings report): asking for a category we don't sell ("vehicular",
    // "seguro vehicular") silently re-showed the unrelated, already-quoted product
    // verbatim, identically, twice — the agent never acknowledged the request was for
    // something else entirely. Must check this BEFORE falling through to the
    // neutral-message re-show below.
    const outOfCatalog = this.detectOutOfCatalogCategory(text);
    if (outOfCatalog && !this.mentionsAlreadyCoveredTopic(text, context)) {
      return {
        text: `Por ahora no tengo seguros de ${outOfCatalog}, pero sí tengo vida, accidentes, asistencia médica y mascotas. ¿Te interesa alguno de estos?`,
      };
    }

    // Neutral/unclear message (e.g. a follow-up question) — re-show the actual quoted
    // product instead of the generic STATE_RESPONSES placeholder, which has no real
    // product name or price and reads as a broken response.
    //
    // Real live-test bug: a genuinely unparseable message ("2+2", sent live by two
    // different users) silently got this same quote card re-shown with zero
    // acknowledgment — indistinguishable from a legitimate follow-up question like "¿Ese
    // es el único plan?". Only prefix a clarification when the raw text has NO letters at
    // all — a real Spanish question always has plenty of them and must keep getting the
    // plain, unprefixed re-show.
    // Real live-test bug (2026-07-26): an unclear turn during an active mixed-species
    // purchase re-showed the single currentProduct (context.quoteProductId — arbitrarily
    // just ONE of the two active products) priced against the raw cross-species
    // petCount, instead of the actual combined 2-product quote the user was looking at.
    // Checked before the single-product branch below so it takes priority.
    if (context.selectedProductIds && context.selectedProductIds.length > 1) {
      const quoteText = this.formatMixedSpeciesQuote(context);
      const noRealWords = !/[a-zA-ZÀ-ÖØ-öø-ÿ]/.test(text);
      return {
        text: noRealWords ? `No entendí ese mensaje, ¿puedes intentarlo de nuevo?\n\n${quoteText}` : quoteText,
        unclearReply: true,
      };
    }

    if (currentProduct) {
      const quoteText = this.formatQuote(
        currentProduct,
        { reasons: [], monthlyPremium: currentProduct.basePremium },
        context,
      );
      const noRealWords = !/[a-zA-ZÀ-ÖØ-öø-ÿ]/.test(text);
      // Counts toward the stuck-loop circuit breaker either way — a plain re-show, with
      // or without the clarification prefix, means none of the branches above understood
      // what was actually being asked.
      return {
        text: noRealWords ? `No entendí ese mensaje, ¿puedes intentarlo de nuevo?\n\n${quoteText}` : quoteText,
        unclearReply: true,
      };
    }

    return { text: STATE_RESPONSES[ConversationState.QUOTE_PRESENTED](context), unclearReply: true };
  }

  private mentionsPersonalCoverage(text: string): boolean {
    // "también"/"tambien" alone is too generic here — could just mean "I also have a
    // dog" mid-pet-conversation. Anchor on phrases that specifically mean "for me".
    const personalPhrases = ['para mí', 'para mi', 'y yo'];
    const humanCategories = ['vida', 'accidentes', 'accidente', 'salud', 'hogar'];
    return personalPhrases.some((p) => text.includes(p)) || humanCategories.some((c) => text.includes(c));
  }

  // "no tengo gatos" (or perros) explicitly denies the species the CURRENT quote
  // assumes — checked against whichever species that actually is, not a fixed list, so
  // it only fires when it's actually relevant to what's on screen right now. `text` is
  // already lowercased (handleMessage passes lowerText in), so no case-folding needed.
  private deniesCurrentPetType(text: string, petType: 'gato' | 'perro' | 'mixto'): boolean {
    if (petType === 'mixto') return false;
    const words = petType === 'gato' ? ['gato', 'gatos', 'gata', 'gatas'] : ['perro', 'perros', 'perra', 'perras'];
    return text.includes('no tengo') && words.some((w) => text.includes(w));
  }

  // Scans the raw text for EVERY category keyword group present, not just the first
  // match (unlike GroqNlpService.fallbackIntent, which breaks on the first hit) — needed
  // to detect messages naming two products at once, e.g. "mascotas y vida". Mascota
  // keywords are checked first and "asistencia veterinaria" is stripped before the
  // asistencia check so a pet-related "asistencia" doesn't also register as the
  // unrelated personal "asistencia médica" category.
  private detectAllMentionedCategories(text: string): NonNullable<InsuranceIntent['productCategory']>[] {
    const categories: NonNullable<InsuranceIntent['productCategory']>[] = [];
    if (['mascota', 'perro', 'canino', 'gato', 'gata', 'gatic', 'michi', 'minino', 'veterinar'].some((k) => text.includes(k))) {
      categories.push('mascotas');
    }
    const withoutVetAsistencia = text.replace(/asistencia\s+veterinaria/g, '');
    if (['asistencia', 'salud'].some((k) => withoutVetAsistencia.includes(k))) categories.push('asistencia');
    if (text.includes('vida')) categories.push('vida');
    if (text.includes('accidente')) categories.push('accidentes');
    if (['hogar', 'casa'].some((k) => text.includes(k))) categories.push('hogar');
    return [...new Set(categories)];
  }

  // Real catalog covers vida, accidentes, asistencia, mascotas (hogar cross-sells into
  // asistencia — see QuotingService.isRelatedCategory). Vehículos and empresas are NOT
  // in the real Colsubsidio catalog this hackathon uses (AGENTS.md rule 12: only real
  // colsubsidio.com/seguros prices) — a mention of one must get an honest "we don't
  // offer that" instead of silently reusing whatever was quoted before.
  private static readonly OUT_OF_CATALOG_KEYWORDS: Record<string, string> = {
    vehicular: 'vehículos', vehiculo: 'vehículos', vehículo: 'vehículos',
    carro: 'vehículos', moto: 'vehículos', motocicleta: 'vehículos',
    empresa: 'empresas', negocio: 'empresas', compañía: 'empresas', compania: 'empresas',
  };

  private detectOutOfCatalogCategory(text: string): string | null {
    for (const [keyword, label] of Object.entries(AgentService.OUT_OF_CATALOG_KEYWORDS)) {
      if (text.includes(keyword)) return label;
    }
    return null;
  }

  // Real live-test bug: asistencias-multiples genuinely covers "Asistencia vehículo" —
  // a question about THAT coverage while it's already on screen ("¿la asistencia también
  // cubre mi carro?") got the same "no tengo seguros de vehículos" denial as someone
  // asking for a dedicated car-insurance policy that genuinely doesn't exist. Checked
  // against every product actually in this purchase (selectedProductIds, or the single
  // quoteProductId) — coverage text only ever comes from the real catalog (rule #12), so
  // this can never manufacture a false "yes we cover that."
  private mentionsAlreadyCoveredTopic(text: string, context: ConversationContext): boolean {
    const productIds = context.selectedProductIds?.length ? context.selectedProductIds : (context.quoteProductId ? [context.quoteProductId] : []);
    const coverageText = productIds
      .map((id) => PRODUCTS.find((p) => p.id === id))
      .filter((p): p is InsuranceProduct => !!p)
      .flatMap((p) => p.coverages)
      .join(' ')
      .toLowerCase();
    return Object.keys(AgentService.OUT_OF_CATALOG_KEYWORDS).some((keyword) => text.includes(keyword) && coverageText.includes(keyword));
  }

  // buildMultiQuote (removed 2026-07-24) used to set productCategory to the FIRST
  // selected product's category, so a strict `productCategory === 'mascotas'` check
  // would skip per-pet data collection whenever mascotas isn't first. Kept general in
  // case selectedProductIds is ever populated by something other than the live agent
  // flow (e.g. directly via DB) — the multi-policy/one-payment backend still works.
  private isPetSelected(context: ConversationContext): boolean {
    if (context.productCategory === 'mascotas') return true;
    if (!context.selectedProductIds?.length) return false;
    return context.selectedProductIds.some((id) => PRODUCTS.find((p) => p.id === id)?.category === 'mascotas');
  }

  // Acknowledges interest in a different category without abandoning the quote already
  // on screen — the deferred category is followed up on only once this purchase is paid
  // and the policy is issued (see wompi-webhook.controller.ts notifyPoliciesIssued).
  private deferCrossSell(
    context: ConversationContext,
    currentProduct: InsuranceProduct,
    deferredCategory: string | null,
  ): ProcessResult {
    const nextStep = deferredCategory ? `el de ${deferredCategory}` : 'lo que necesites para ti';
    return {
      text: (
        `¡Anotado! Primero cerremos tu *${currentProduct.name}* — en cuanto quede lista tu póliza, ` +
        `seguimos con ${nextStep}.\n\n` +
        `¿Confirmamos este? Escríbeme *"sí"* para continuar.`
      ),
      context: { ...context, pendingCrossSell: deferredCategory },
    };
  }

  // Common backchannel/acknowledgment words a voice transcription can produce in
  // response to the bot's OWN previous message — never a real person's full name.
  private static readonly FILLER_WORDS = ['gracias', 'ok', 'okay', 'vale', 'listo', 'dale', 'bueno', 'ya'];

  // A human/pet name is letters only (incl. Spanish accents/ñ), one or more words
  // separated by spaces, apostrophes or hyphens — never digits or other symbols. Real
  // bug: a saved conversation context showed "nombre": "2+2" accepted as a valid full
  // name, since the field was previously stored verbatim with zero shape validation.
  private static readonly NAME_REGEX = /^[a-zA-ZÀ-ÖØ-öø-ÿ]+(?:['’\-][a-zA-ZÀ-ÖØ-öø-ÿ]+|\s+[a-zA-ZÀ-ÖØ-öø-ÿ]+)*$/;

  // Real bug confirmed live in the production Supabase policies table: a policy's
  // nombre column literally contained "Mi nombre es Michelle Gómez Gómez" — NAME_REGEX
  // allows it (it's all letters/spaces, no digits/symbols) so the whole phrase passed
  // validation and was stored verbatim. A user answering "¿Cuál es tu nombre completo?"
  // naturally often restates the question as a lead-in — strip it before validating.
  private static readonly NAME_PREAMBLE_REGEX = /^(mi nombre completo es|mi nombre es|me llamo|yo soy|soy)\s*/i;

  private stripNamePreamble(text: string): string {
    return text.trim().replace(AgentService.NAME_PREAMBLE_REGEX, '').trim();
  }

  // Real live-test bug: dictating a cédula digit-by-digit by voice ("uno, dos, tres...")
  // gets transcribed with a comma between each individual digit ("1, 2, 3, 4, 5, 6, 7,
  // 8, 9") — the cédula regex needs a CONTIGUOUS \d{6,10} run, so this never matched at
  // all. Only join when EVERY comma-separated token is a single lone digit (6+ of them)
  // — a typed, intentionally-formatted number like "12.345.678" (period-separated
  // multi-digit groups) or "1234 5678" (space-separated groups) must still be rejected
  // as before; those aren't voice-digit dictation and have no commas at all.
  private joinSpokenDigits(text: string): string {
    const tokens = text.split(',').map((t) => t.trim());
    if (tokens.length >= 6 && tokens.every((t) => /^\d$/.test(t))) {
      return tokens.join('');
    }
    return text;
  }

  // Real live-test bug: a genuinely mixed household (2 dogs + 1 cat) was quoted a SINGLE
  // product (medicina-prepagada-gatos, cat-only) multiplied by the TOTAL pet count (3) —
  // charging the 2 dogs at the cat rate. The catalog has separate species-restricted
  // products with different prices; a mixto household needs its OWN per-species count,
  // not just a combined total, to quote/charge each product correctly.
  private static readonly SPECIES_NUMBER_WORDS: Record<string, number> = {
    un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
    seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  };

  private extractSpeciesCounts(lower: string): { gato: number; perro: number } {
    const pattern = /\b(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(perr(?:os?|itos?|itas?|as?)|gat(?:os?|itos?|itas?|icos?|icas?|as?))\b/g;
    let gato = 0;
    let perro = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lower)) !== null) {
      const raw = match[1];
      const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : AgentService.SPECIES_NUMBER_WORDS[raw];
      if (match[2].startsWith('gat')) gato += n;
      else perro += n;
    }
    return { gato, perro };
  }

  // The right per-pet count for THIS product's own price — a species-restricted product
  // (medicina-prepagada-gatos/perros) uses its own species' count from a mixto
  // household's breakdown when known, never the combined total of every pet.
  private petCountForProduct(context: ConversationContext, product: InsuranceProduct): number | null | undefined {
    if (context.petSpeciesCounts && product.eligibility.pet === 'gato') return context.petSpeciesCounts.gato ?? context.petCount;
    if (context.petSpeciesCounts && product.eligibility.pet === 'perro') return context.petSpeciesCounts.perro ?? context.petCount;
    // Real live-test bug (2026-07-26): a mixto household ("1 gato + 1 perro") that then
    // narrows to "solo gato" sets context.petType to the single species, but leaves
    // context.petCount at the OLD combined total (2) — correctly bypassed above for a
    // gato/perro-restricted product via petSpeciesCounts, but a product with
    // eligibility.pet === 'any' (e.g. asistencia veterinaria) matched neither branch above
    // and fell through to the stale combined petCount, pricing "solo gato" (1 pet) as if
    // it were still both pets (2). An 'any' product must respect the same narrowing.
    if (context.petSpeciesCounts && (context.petType === 'gato' || context.petType === 'perro')) {
      return context.petSpeciesCounts[context.petType] ?? context.petCount;
    }
    return context.petCount;
  }

  private isValidHumanName(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.length >= 2 && trimmed.length <= 80 && AgentService.NAME_REGEX.test(trimmed);
  }

  // Voice dictation of an email in Spanish spells out the symbols as words ("arroba" for
  // @, "punto" for .) instead of saying them literally — a message like "Juan arroba
  // gmail punto com" has neither symbol and fails any @/. shape check as-is.
  private normalizeSpokenEmail(text: string): string {
    return text
      .replace(/\s+arroba\s+/gi, '@')
      .replace(/\s+punto\s+/gi, '.')
      .replace(/\s+/g, '');
  }

  // True if ANY product in this purchase (single or multi-product) requires conditional
  // underwriting (2026-07-24 business feedback: vida, medicina-prepagada-gatos/perros).
  private requiresUnderwritingInfo(context: ConversationContext): boolean {
    const productIds = context.selectedProductIds?.length
      ? context.selectedProductIds
      : (context.quoteProductId ? [context.quoteProductId] : []);
    return productIds.some((id) => PRODUCTS.find((p) => p.id === id)?.requiresUnderwriting);
  }

  // 2026-07-24 clarification: the generic "edad, enfermedad, historial clínico" question
  // only fully fits a HUMAN product (vida) — a human's age is never captured anywhere
  // else in the flow. A PET product (medicina-prepagada-gatos/perros) already has the
  // pet's age from the Step-0 per-pet loop by the time this gate is reached, so re-asking
  // it is redundant, and there's no "historial clínico" concept for a pet — only whether
  // it has a preexisting illness. Must name the actual pet(s), not speak generically.
  private buildUnderwritingQuestion(context: ConversationContext): string {
    if (this.isPetSelected(context) && context.pets?.length) {
      const names = formatNameList(context.pets.map((p) => p.name));
      const plural = context.pets.length > 1;
      return `Para emitir la póliza de ${names} necesito saber si ${plural ? 'tienen' : 'tiene'} alguna enfermedad preexistente (o escribe "ninguna" si no aplica).`;
    }
    return 'Para este seguro necesito un par de datos adicionales: tu edad, si tienes alguna enfermedad preexistente, y un breve historial clínico (o escribe "ninguna" si no aplica).';
  }

  // Single source for the Wompi payment link's expiry — was duplicated as two separate
  // literal `30`s (the API call and the user-facing message text), risking drift if one
  // changed without the other.
  private static readonly PAYMENT_LINK_EXPIRY_MINUTES = 30;

  // Below this width/height, a "photo" is more likely an icon/sticker-shaped file than
  // an actual camera photo — a real phone selfie is always at least a few hundred px on
  // its shortest side. Not real face detection, just a sanity floor.
  private static readonly MIN_SELFIE_DIMENSION = 80;

  private isFillerWord(text: string): boolean {
    const normalized = text.trim().toLowerCase().replace(/[.,!¡¿?]/g, '');
    return AgentService.FILLER_WORDS.includes(normalized);
  }

  // The real first DATA_CAPTURE question once identity verification (phone + selfie)
  // is done — per-pet details for a mascotas purchase, otherwise cédula.
  private firstDataCaptureQuestion(context: ConversationContext): string {
    const totalPets = context.petCount ?? 1;
    return this.isPetSelected(context)
      ? `Para emitir la póliza necesito los datos de cada mascota (puedes contarme de todas a la vez o una por una). Mascota 1 de ${totalPets}: ¿nombre, edad y raza?`
      : STATE_RESPONSES[ConversationState.DATA_CAPTURE](context);
  }

  private formatPetsSummary(pets: PetDetail[]): string {
    const lines = pets.map((p, i) => `${i + 1}. ${p.name} — ${p.age} — ${p.breed}`).join('\n');
    return (
      `📋 *Resumen de tus mascotas:*\n\n${lines}\n\n` +
      `¿Todo correcto? Escríbeme *"sí"* para continuar, o dime qué corregir (ej: "Bruna tiene 8 años").`
    );
  }

  // Lets a pets-summary correction reference a pet by position ("el tercero", "la
  // segunda") instead of only by name — needed because a name alone is ambiguous when
  // two pets share it, and the position is unambiguous by construction.
  private static readonly ORDINAL_WORDS: Record<string, number> = {
    primero: 0, primera: 0, primer: 0,
    segundo: 1, segunda: 1,
    tercero: 2, tercera: 2,
    cuarto: 3, cuarta: 3,
    quinto: 4, quinta: 4,
  };

  private extractOrdinalIndex(text: string): number | null {
    const lower = text.toLowerCase();
    for (const [word, idx] of Object.entries(AgentService.ORDINAL_WORDS)) {
      if (new RegExp(`\\b${word}\\b`).test(lower)) return idx;
    }
    return null;
  }

  // Not everyone has a CC (cédula de ciudadanía) — CE (extranjería), TI (tarjeta de
  // identidad, minors), NIP/NUIP also identify a real person. Defaults to CC, the most
  // common case, when no other type is named — matches prior behavior for plain numbers.
  private detectDocumentType(text: string): DocumentType {
    if (text.includes('extranjer')) return 'CE';
    if (text.includes('tarjeta de identidad') || /\bti\b/.test(text)) return 'TI';
    if (/\bnuip\b/.test(text)) return 'NUIP';
    if (/\bnip\b/.test(text)) return 'NIP';
    if (/\bce\b/.test(text)) return 'CE';
    return 'CC';
  }

  // ── Data capture ─────────────────────────────────────────────────────────────

  private async handleDataCapture(
    convId: string,
    context: ConversationContext,
    text: string,
    intent: InsuranceIntent,
    rawText: string = text,
    contact?: NormalizedMessage['contact'],
    photo?: NormalizedMessage['photo'],
  ): Promise<ProcessResult> {
    const newContext: ConversationContext = { ...context };

    // Step -1 — identity verification (2026-07-24 KYC feedback). Set up by
    // handleQuotation's isAffirmative branch, which shows the contact-share button
    // exactly once. A contact share marks the phone verified and moves on to the
    // cosmetic selfie step below.
    //
    // Real bug found 2026-07-24 (confirmed independently by a live test session and a
    // teammate's findings report): this used to re-show the same "toca el botón" prompt
    // forever for ANY typed reply — a genuine demo-killing infinite loop with zero
    // escape route ("no me interesa" / random text / anything got the identical
    // response, permanently). This is a cosmetic KYC step and must never be allowed to
    // block a real sale — if the user's very next message still isn't a contact-share,
    // treat it as declined and move on immediately instead of asking again.
    if (context.awaitingPhoneVerification && !context.phoneVerified) {
      if (contact) {
        const verifiedContext: ConversationContext = {
          ...context,
          phoneVerified: true,
          verifiedPhone: contact.phoneNumber,
          awaitingPhoneVerification: undefined,
          awaitingSelfie: true,
        };
        return {
          text: 'Identidad verificada ✅\n\n📸 Por último, toca el clip 📎 y envíame una selfie ahora mismo para confirmar tu identidad.',
          context: verifiedContext,
          // 2026-07-24 feedback: a "big" reaction (Telegram's is_big flag, a much larger
          // animated burst) on the shared-contact message itself. '✅' is NOT one of
          // Telegram's allowed reaction emoji (grammy's ReactionTypeEmoji union — see
          // telegram-adapter.service.ts's reactToMessage) — using it silently failed with
          // `REACTION_INVALID` in production (confirmed via the .catch() logging added
          // 2026-07-24). '🤝' is in the allowed set and fits "verified/connected" here.
          reaction: '🤝',
          reactionBig: true,
        };
      }
      const skippedContext: ConversationContext = {
        ...context,
        awaitingPhoneVerification: undefined,
        phoneVerified: false,
        awaitingSelfie: true,
      };
      return {
        text: 'Sin problema, seguimos así.\n\n📸 Por último, toca el clip 📎 y envíame una selfie ahora mismo para confirmar tu identidad.',
        context: skippedContext,
      };
    }

    // Step -0.5 — cosmetic selfie confirmation (2026-07-24 feedback). This is a
    // SIMULATION, not a real identity check — no face matching, no liveness detection,
    // any photo received counts as "confirmed". It's a placeholder to demonstrate the
    // concept; a real deployment would swap this for an actual third-party
    // identity-verification provider to guard against a false identity. Same
    // never-loop-forever fix as phone verification above — skips and moves on if the
    // very next message isn't a photo.
    if (context.awaitingSelfie && !context.selfieProvided) {
      if (photo) {
        // 2026-07-24 feedback: "confirm the image is a selfie, is ok if is not high
        // resolution" — no real face detection (stays a cosmetic simulation), just a
        // width/height sanity check against an icon/sticker-shaped file. Asked at most
        // once, same never-loop-forever guarantee as every other KYC gate: a SECOND
        // tiny image (or anything else) is accepted anyway.
        const isTinyImage = photo.width < AgentService.MIN_SELFIE_DIMENSION || photo.height < AgentService.MIN_SELFIE_DIMENSION;
        if (isTinyImage && !context.selfieRetryAsked) {
          return {
            text: 'Esa imagen se ve muy pequeña para confirmar tu identidad 📸 ¿puedes enviarla de nuevo?',
            context: { ...context, selfieRetryAsked: true },
          };
        }
        const confirmedContext: ConversationContext = {
          ...context,
          selfieProvided: true,
          awaitingSelfie: undefined,
          selfieRetryAsked: undefined,
        };
        return {
          // 2026-07-24 feedback: the "¡Identidad confirmada!" label is now baked into the
          // video itself (IDENTITY_ANIMATION_PATH) — repeating it as text read as redundant.
          text: this.firstDataCaptureQuestion(confirmedContext),
          context: confirmedContext,
          animation: IDENTITY_ANIMATION_PATH,
        };
      }
      const skippedContext: ConversationContext = {
        ...context,
        awaitingSelfie: undefined,
        selfieProvided: false,
      };
      return {
        text: `Sin problema, seguimos así.\n\n${this.firstDataCaptureQuestion(skippedContext)}`,
        context: skippedContext,
      };
    }

    // Step 0 — collect per-pet details (name, age, breed) before the human's own data.
    // Accepts either one pet per message (petName/petAge/petBreed) or several at once
    // (pets[]) — the user can describe all their pets in one turn if they want to.
    if (this.isPetSelected(context)) {
      const totalPets = context.petCount ?? 1;
      const pets = context.pets ?? [];
      if (pets.length < totalPets) {
        const extracted = (intent.pets && intent.pets.length > 0)
          ? intent.pets
          : (intent.petName ? [{ name: intent.petName, age: intent.petAge ?? null, breed: intent.petBreed ?? null }] : []);

        if (extracted.length > 0) {
          const updatedPets = [...pets];
          // Real live-test bug: the NLP extraction dropped a pet from a 3-pet message
          // (fixed separately in groq-nlp.service.ts), and the user's next message —
          // believing all 3 were already given — re-stated an already-collected pet
          // instead of the actually-missing one. That got pushed as a literal duplicate,
          // corrupting the final paid, issued policy. Second line of defense: an exact
          // name match against an already-collected pet is never pushed again.
          let duplicateName: string | null = null;
          for (const p of extracted) {
            if (updatedPets.length >= totalPets) break;
            // A pet name goes on the final policy PDF just like a human nombre — reject
            // the same digit/symbol garbage (e.g. NLP mis-extracting "2" as a pet name).
            if (!p.name || !this.isValidHumanName(p.name)) continue;
            if (updatedPets.some((existing) => existing.name.toLowerCase() === p.name!.toLowerCase())) {
              duplicateName = p.name;
              continue;
            }
            updatedPets.push({
              name: p.name,
              age: p.age ?? 'no especificada',
              // Voice transcription regularly mangles breed names (e.g. "Cocker" ->
              // "caken") — normalize against a dictionary of common breeds.
              breed: matchBreed(p.breed),
            });
          }
          if (updatedPets.length < totalPets) {
            const text = duplicateName
              ? `Ya tengo a ${duplicateName} registrada. Cuéntame de una mascota diferente: ¿nombre, edad y raza?`
              : `Perfecto. Ahora cuéntame de tu mascota ${updatedPets.length + 1} de ${totalPets}: ¿nombre, edad y raza?`;
            return {
              text,
              context: { ...context, pets: updatedPets },
            };
          }
          // All pets collected — show a confirmation summary before moving to cédula,
          // so the user can catch a wrong field (e.g. a mis-transcribed age or breed)
          // without redoing the whole per-pet loop.
          const petsCompleteContext = { ...context, pets: updatedPets, petsAwaitingConfirmation: true };
          return {
            text: this.formatPetsSummary(updatedPets),
            context: petsCompleteContext,
          };
        } else {
          const petNum = pets.length + 1;
          const prefix = pets.length === 0
            ? 'Para emitir la póliza necesito los datos de cada mascota (puedes contarme de todas a la vez o una por una). '
            : 'No logré entender eso. ';
          return {
            text: `${prefix}Mascota ${petNum} de ${totalPets}: ¿nombre, edad y raza?`,
            context,
          };
        }
      }
    }

    // Handle the pets confirmation summary — "sí" proceeds, a correction naming a pet
    // updates just that pet's field instead of restarting the whole per-pet loop.
    if (context.petsAwaitingConfirmation) {
      if (intent.isAffirmative) {
        const confirmedContext = { ...context, petsAwaitingConfirmation: undefined };
        return {
          text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](confirmedContext),
          context: confirmedContext,
        };
      }

      const hasUpdateData = !!(intent.petName || intent.petAge || intent.petBreed);
      const pets = context.pets ?? [];
      let targetIndex = -1;

      // Real live-test bug (2026-07-24): a 3-pet message came back with one name
      // duplicated and another pet dropped entirely. Every correction attempt by name
      // always matched the FIRST occurrence, silently editing the wrong entry, and an
      // explicit positional reference ("el tercero es...") was not understood at all —
      // the corrupted pets list made it all the way into the final, paid, issued policy.
      // An ordinal reference is checked FIRST and wins outright: it's unambiguous by
      // construction, whereas the name it's paired with (e.g. "Ramón") may also
      // legitimately match a different, already-correct pet elsewhere in the list.
      const ordinalIndex = this.extractOrdinalIndex(rawText);
      if (hasUpdateData && ordinalIndex !== null && ordinalIndex < pets.length) {
        targetIndex = ordinalIndex;
      } else if (hasUpdateData && intent.petName) {
        const matches = pets.reduce<number[]>(
          (acc, p, i) => (p.name.toLowerCase() === intent.petName!.toLowerCase() ? [...acc, i] : acc),
          [],
        );
        if (matches.length === 1) {
          targetIndex = matches[0];
        } else if (matches.length > 1) {
          // Ambiguous — never guess which duplicate was meant. Ask instead.
          return {
            text: `Tienes ${matches.length} mascotas llamadas "${intent.petName}". ¿Cuál corriges? Dime "la primera", "la segunda"${matches.length > 2 ? ', "la tercera"' : ''}, etc.`,
            context,
          };
        }
      }
      if (hasUpdateData && targetIndex === -1 && pets.length === 1) {
        targetIndex = 0;
      }

      if (!hasUpdateData || targetIndex === -1) {
        return {
          text: '¿Cuál mascota quieres corregir? Dime su nombre y el dato correcto (ej: "Bruna tiene 8 años").',
          context,
        };
      }

      const updatedPets = [...pets];
      const current = updatedPets[targetIndex];
      // Same digit/symbol guard as the initial capture — a garbage-shaped petName
      // (e.g. NLP mis-extracting "2") must never overwrite an already-valid pet name.
      const newName = intent.petName && this.isValidHumanName(intent.petName) ? intent.petName : current.name;
      updatedPets[targetIndex] = {
        name: newName,
        age: intent.petAge ?? current.age,
        breed: intent.petBreed ? matchBreed(intent.petBreed) : current.breed,
      };

      return {
        text: this.formatPetsSummary(updatedPets),
        context: { ...context, pets: updatedPets },
      };
    }

    // Step 3.5 — conditional underwriting info (2026-07-24 business feedback). Set by
    // the email step below once cédula/nombre/correo are all in and the quoted product
    // requires it. Accepts ANY reply verbatim — this is informational (age, illnesses,
    // clinical history), not a structural gate, so it must never loop: the very next
    // message is stored as-is and the flow proceeds to the final confirmation.
    if (context.awaitingMedicalInfo) {
      newContext.medicalInfo = rawText;
      newContext.medicalInfoProvided = true;
      newContext.awaitingMedicalInfo = undefined;
      return {
        text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](newContext),
        context: newContext,
      };
    }

    // Step 1 — collect número de documento. Not everyone has a CC (cédula de
    // ciudadanía) — detect CE/TI/NIP/NUIP from keywords and extract the digit run
    // regardless of a spoken-out prefix ("CE 123456789", "mi tarjeta de identidad es...").
    if (!context.cedula) {
      const digitsMatch = this.joinSpokenDigits(text).match(/\b\d{6,10}\b/);
      if (!digitsMatch) {
        return { text: 'El número de documento debe tener entre 6 y 10 dígitos. Intenta de nuevo.' };
      }
      newContext.cedula = digitsMatch[0];
      newContext.documentType = this.detectDocumentType(text);
      return {
        text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](newContext),
        context: newContext,
      };
    }

    // Step 2 — collect nombre. Reject common filler/acknowledgment words a voice
    // transcription might produce in response to the bot's own prior message (e.g.
    // "Gracias.") — accepting these verbatim as the customer's name previously
    // corrupted the rest of the flow (the real name then landed in the NEXT field).
    if (!context.nombre) {
      if (this.isFillerWord(rawText)) {
        return { text: '¿Cuál es tu nombre completo?' };
      }
      const cleanedName = this.stripNamePreamble(rawText);
      if (!this.isValidHumanName(cleanedName)) {
        return { text: 'Ese no parece un nombre válido — solo letras y espacios, sin números ni símbolos. ¿Cuál es tu nombre completo?' };
      }
      newContext.nombre = cleanedName;
      return {
        text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](newContext),
        context: newContext,
      };
    }

    // Step 3 — collect email. Requires a basic email shape (user@domain.tld) — accepting
    // any text unconditionally previously let an unrelated phrase (e.g. a name captured
    // here after nombre was wrongly filled by a filler word) silently become the "email".
    // Real live-test bug: a voice message dictating an email says "arroba" for @ and
    // "punto" for . (standard Spanish spoken-email convention) — normalize those to the
    // literal symbols before validating, or a perfectly clear spoken email never passes.
    if (!context.email) {
      const normalizedEmail = this.normalizeSpokenEmail(rawText);
      if (!/\S+@\S+\.\S+/.test(normalizedEmail)) {
        // Real live-test bug (2026-07-26): a user dictated an email by voice WITHOUT
        // ever saying "arroba" ("juan gmail punto com") — normalizeSpokenEmail can't
        // invent an @ that was never said, so this failed 3 times in a row with no hint
        // as to why. Only shown when there's no @ at all (a genuine missing-symbol case,
        // not just a malformed one) so a real typo doesn't get a confusing generic tip.
        const hint = normalizedEmail.includes('@')
          ? ''
          : ' Si lo dictas por voz, recuerda decir *"arroba"* donde va el @ (ej: "juan arroba gmail punto com").';
        return { text: `¿Cuál es tu correo electrónico? Ahí recibirás la póliza.${hint}` };
      }
      newContext.email = normalizedEmail;
      // 2026-07-24 business feedback: vida and medicina-prepagada-gatos/perros need
      // conditional underwriting info before the final confirmation — everything else
      // is direct-sell and goes straight to it.
      if (this.requiresUnderwritingInfo(newContext) && !newContext.medicalInfoProvided) {
        return {
          text: this.buildUnderwritingQuestion(newContext),
          context: { ...newContext, awaitingMedicalInfo: true },
        };
      }
      return {
        text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](newContext),
        context: newContext,
      };
    }

    // Answering a pending "¿qué dato quieres corregir?" — reset only the named field
    // instead of the blanket cédula+nombre+correo reset this replaced.
    if (context.awaitingCorrectionField) {
      const mentionsCedula = text.includes('cédula') || text.includes('cedula');
      const mentionsNombre = text.includes('nombre');
      const mentionsCorreo = text.includes('correo') || text.includes('email');

      if (mentionsCedula) {
        return {
          text: 'Escríbeme tu cédula de nuevo (solo dígitos, sin puntos ni espacios).',
          context: { ...context, cedula: undefined, awaitingCorrectionField: undefined },
        };
      }
      if (mentionsNombre) {
        return {
          text: '¿Cuál es tu nombre completo?',
          context: { ...context, nombre: undefined, awaitingCorrectionField: undefined },
        };
      }
      if (mentionsCorreo) {
        return {
          text: '¿Cuál es tu correo electrónico? Ahí recibirás la póliza.',
          context: { ...context, email: undefined, awaitingCorrectionField: undefined },
        };
      }
      return {
        text: 'No identifiqué cuál dato corregir. Dime: cédula, nombre o correo.',
        context,
      };
    }

    // Step 4.5 — payment method choice (2026-07-24 feedback). "Tarjeta Colsubsidio" and
    // "link de pago" route to the exact SAME real Wompi checkout link (Wompi already
    // accepts card payments) — this is a wording/framing choice, not a second payment
    // rail, and createPaymentLinkFlow reads context.paymentMethodChoice to theme the
    // copy. Deliberately never claims the payment already succeeded before it has.
    //
    // Real bug found 2026-07-24, same root cause as the KYC infinite-loop fixes above:
    // an unrecognized answer used to re-ask this question forever. Defaults to the
    // plain link de pago (always unambiguous) instead — a payment-method preference
    // must never be allowed to strand an otherwise-ready purchase.
    if (context.awaitingPaymentMethodChoice) {
      const lower = text.toLowerCase();
      const choice: ConversationContext['paymentMethodChoice'] =
        (lower.includes('tarjeta') || lower.includes('colsubsidio')) ? 'tarjeta_colsubsidio' : 'link_pago';

      return this.createPaymentLinkFlow(convId, {
        ...context,
        paymentMethodChoice: choice,
        awaitingPaymentMethodChoice: undefined,
      });
    }

    // Step 4 — confirmation ("sí" → create pending policy record, ask how the user wants
    // to pay). No extra "¿listo para generar tu link?" re-confirmation — the user already
    // confirmed by saying "sí" here — but the payment-method question below is a
    // genuine, distinct choice, not the same redundant friction. No PDF is sent here —
    // the only PDF the user receives is generated and sent by
    // wompi-webhook.controller.ts once Wompi reports the transaction as APPROVED.
    if (intent.isAffirmative) {
      // Multi-product purchase — issue one policy per selected product; they'll share a
      // single combined Wompi payment link, created next in createPaymentLinkFlow.
      const productIds = newContext.selectedProductIds?.length
        ? newContext.selectedProductIds
        : (newContext.quoteProductId ? [newContext.quoteProductId] : []);
      const hasResolvableProduct = productIds.some((id) => PRODUCTS.find((p) => p.id === id));

      const policyIds: string[] = [];
      for (const productId of productIds) {
        // A mixto household's species-restricted products must each be issued against
        // their OWN per-species count (petCountForProduct), not the combined total —
        // otherwise both policies store/charge the wrong pet_count (real bug: 2 dogs + 1
        // cat both stored as petCount 3).
        const product = PRODUCTS.find((p) => p.id === productId);
        const petCountOverride = product ? this.petCountForProduct(newContext, product) : newContext.petCount;
        const { policyId } = await this.policy.issue(convId, { ...newContext, quoteProductId: productId, petCount: petCountOverride });
        policyIds.push(policyId);
      }
      newContext.policyId = policyIds[0];
      newContext.policyIds = policyIds;
      // Accumulates permanently, unlike policyId/policyIds — see the field comment in
      // types.ts. Deduped in case the same product is ever bought again in a later
      // cross-sell within this same conversation.
      newContext.purchasedProductIds = [...new Set([...(context.purchasedProductIds ?? []), ...productIds])];

      // No resolvable product at all — nothing to ask a payment method for. Let
      // createPaymentLinkFlow's own guard abort cleanly instead of asking a pointless
      // question first.
      if (!hasResolvableProduct) {
        return this.createPaymentLinkFlow(convId, newContext);
      }

      return {
        text: '¿Cómo prefieres pagar: con tu *Tarjeta Colsubsidio* o con el *link de pago*?',
        context: { ...newContext, awaitingPaymentMethodChoice: true },
      };
    }

    const correctionTriggered = intent.isNegative ||
      ['corregir', 'corrig', 'cambiar', 'cambia', 'editar', 'está mal', 'esta mal', 'equivocad', 'falta', 'falda el']
        .some((k) => text.includes(k));

    if (correctionTriggered) {
      // Targeted correction: if the message names exactly one field, only reset that
      // one — resetting all three (the old behavior) forced the user to redo cédula
      // and correo just to fix a one-word typo in their name.
      const mentionsCedula = text.includes('cédula') || text.includes('cedula');
      const mentionsNombre = text.includes('nombre');
      const mentionsCorreo = text.includes('correo') || text.includes('email');
      const mentionedFields = [mentionsCedula, mentionsNombre, mentionsCorreo].filter(Boolean).length;

      if (mentionedFields === 1 && mentionsNombre) {
        return {
          text: '¿Cuál es tu nombre completo?',
          nextState: ConversationState.DATA_CAPTURE,
          context: { ...context, nombre: undefined },
        };
      }
      if (mentionedFields === 1 && mentionsCorreo) {
        return {
          text: '¿Cuál es tu correo electrónico? Ahí recibirás la póliza.',
          nextState: ConversationState.DATA_CAPTURE,
          context: { ...context, email: undefined },
        };
      }
      if (mentionedFields === 1 && mentionsCedula) {
        return {
          text: 'Escríbeme tu cédula de nuevo (solo dígitos, sin puntos ni espacios).',
          nextState: ConversationState.DATA_CAPTURE,
          context: { ...context, cedula: undefined },
        };
      }

      // No specific field named — ask which one instead of blanket-resetting all three
      // (the old behavior forced redoing cédula+nombre+correo for a one-field typo).
      return {
        text: '¿Qué dato quieres corregir — cédula, nombre o correo?',
        context: { ...context, awaitingCorrectionField: true },
      };
    }

    // Genuinely unclear message (not a confirmation, not a correction request) —
    // acknowledge instead of silently repeating the same summary card, which reads as
    // the agent ignoring the user.
    return { text: `No logré entender eso. ${STATE_RESPONSES[ConversationState.DATA_CAPTURE](context)}` };
  }

  // Creates the Wompi payment link and returns the message showing it — shared by the
  // DATA_CAPTURE confirmation (generates the link immediately, no extra "listo?" ask)
  // and handlePayment's isConfirm branch (used for retries after a decline/manual-link
  // failure, where the conversation is already sitting in PAYMENT with no checkoutUrl).
  private async createPaymentLinkFlow(convId: string, context: ConversationContext): Promise<ProcessResult> {
    const productIds = context.selectedProductIds?.length
      ? context.selectedProductIds
      : (context.quoteProductId ? [context.quoteProductId] : []);
    const products = productIds
      .map((id) => PRODUCTS.find((p) => p.id === id))
      .filter((p): p is InsuranceProduct => !!p);

    if (products.length === 0) {
      // Real gap found in a hardcoded-values audit: this used to silently fall back to
      // charging an arbitrary flat $20.000 COP via Wompi when no product could be
      // resolved (e.g. a stale/invalid quoteProductId) — a real customer could be
      // charged an amount unrelated to anything they were ever quoted. Abort instead: no
      // policy is issued in this state either, so there is nothing legitimate to charge
      // for. Reset back to DISCOVERY so the user can restart cleanly rather than getting
      // stuck confirming a purchase that no longer resolves to anything.
      this.logger.error(`createPaymentLinkFlow: no resolvable product for conversation ${convId} — aborting payment link creation`);
      return {
        text: 'Tuve un problema retomando tu cotización. Escríbeme de nuevo qué seguro te interesa y lo resolvemos.',
        nextState: ConversationState.DISCOVERY,
        context: { ...context, quoteProductId: undefined, selectedProductIds: undefined, policyId: undefined, policyIds: undefined },
      };
    }

    // Real bug: a mixto household's species-restricted products were both charged
    // against the COMBINED pet count (2 dogs + 1 cat both billed as 3) — the real Wompi
    // charge amount itself was wrong, not just the on-screen quote. Each product bills
    // against its own per-species count (petCountForProduct) when known.
    const amountCOP = products.reduce((sum, p) => sum + computeTotalPremium(p, this.petCountForProduct(context, p)), 0);
    const productName = products.length > 1
      ? `${products.length} seguros Colsubsidio`
      : (products[0]?.name ?? 'Seguro Colsubsidio');

    try {
      const { checkoutUrl, paymentLinkId } = await this.wompi.createPaymentLink({
        policyId: context.policyId ?? convId,
        productName,
        amountCOP,
        expiresInMinutes: AgentService.PAYMENT_LINK_EXPIRY_MINUTES,
      });

      // Persist immediately on EVERY policy in this purchase — the webhook can only find
      // them via payment_link_id (Wompi's Payment Links API has no "reference"
      // create-parameter), and a multi-product purchase shares one link across all of them.
      const policyIds = context.policyIds?.length ? context.policyIds : (context.policyId ? [context.policyId] : []);
      for (const id of policyIds) {
        await this.policy.updateStatus(id, 'pending_payment', { wompi_link_id: paymentLinkId });
      }

      const amountStr = `$${amountCOP.toLocaleString('es-CO')}`;
      // "Tarjeta Colsubsidio" and "link de pago" (2026-07-24 feedback) route to this
      // EXACT same real Wompi link — Wompi already accepts card payments, so this is
      // themed copy, not a second payment rail. Deliberately does not claim the payment
      // already succeeded before the user has actually paid via the link below.
      const intro = context.paymentMethodChoice === 'tarjeta_colsubsidio'
        ? `🎉 ¡Coincidencia encontrada! Ya emparejamos tu *Tarjeta Colsubsidio* con esta compra.\n\n`
        : '';
      const msg = (
        `${intro}🔒 Tu pago es 100% seguro a través de Wompi — plataforma oficial de Bancolombia.\n\n` +
        `🔗 [Pagar ${amountStr} — Link seguro Wompi](${checkoutUrl})\n\n` +
        `Acepta tarjeta débito/crédito, Nequi y PSE.\n\n` +
        `⏱️ El link vence en ${AgentService.PAYMENT_LINK_EXPIRY_MINUTES} minutos.\n\n` +
        `En cuanto tu pago sea confirmado, te aviso aquí automáticamente con tu póliza. ` +
        `Puedes cerrar esta conversación y volver cuando quieras — se mantiene disponible mientras tu pago esté pendiente.`
      );

      return {
        text: msg,
        nextState: ConversationState.PAYMENT,
        context: { ...context, checkoutUrl },
        // 2026-07-24 feedback: Tarjeta Colsubsidio has no real API/sandbox of its own —
        // precisely because there's nothing real to show for it, the "match found"
        // moment gets the real branded success-checkmark video. Still the exact same
        // real Wompi link, never a faked/instant "paid" claim.
        ...(context.paymentMethodChoice === 'tarjeta_colsubsidio' && { animation: PAYMENT_ANIMATION_PATH }),
      };
    } catch (error) {
      this.logger.error(`Failed to create payment link: ${error}`);
      return {
        text: (
          `El monto a pagar es *$${amountCOP.toLocaleString('es-CO')}*.\n\n` +
          `Por ahora no puedo generar el link de pago automático. Realiza la transferencia a la cuenta indicada por tu asesor y comparte el comprobante aquí.` +
          `\n\n¿Ya realizaste el pago? Escríbeme "sí" cuando esté listo.`
        ),
        nextState: ConversationState.PAYMENT,
        context,
      };
    }
  }

  // ── Payment ─────────────────────────────────────────────────────────────────

  private async handlePayment(
    convId: string,
    context: ConversationContext,
    text: string,
    intent: InsuranceIntent,
  ): Promise<ProcessResult> {
    const isConfirm = intent.isAffirmative;

    // Payment confirmation is no longer trust-based: the user's word was never actually
    // verified against Wompi, so anyone could type "sí" and get a policy issued without
    // paying. The Wompi webhook (wompi-webhook.controller.ts) is now the sole source of
    // truth — it confirms and notifies the user proactively once Wompi reports the
    // transaction as APPROVED.
    if (context.checkoutUrl && intent.isNegative) {
      return {
        text: 'Entendido. Si quieres intentar de nuevo más tarde, escríbeme cuando gustes.',
        nextState: ConversationState.ABANDONED,
        context,
      };
    }

    if (context.checkoutUrl) {
      return {
        text: `Tu link de pago sigue activo: [Pagar aquí](${context.checkoutUrl})\n\nEn cuanto Wompi confirme tu pago, te aviso automáticamente aquí mismo — no necesitas escribirme de nuevo. Esta conversación se mantiene disponible mientras tanto.`,
        context,
      };
    }

    if (isConfirm) {
      return this.createPaymentLinkFlow(convId, context);
    }

    if (intent.isNegative) {
      return {
        text: 'Entendido. Si quieres intentar de nuevo más tarde, escríbeme cuando gustes.',
        nextState: ConversationState.ABANDONED,
        context,
      };
    }

    return { text: STATE_RESPONSES[ConversationState.PAYMENT](context) };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private formatQuote(
    product: InsuranceProduct,
    score: { reasons: string[]; monthlyPremium: number },
    context?: ConversationContext,
  ): string {
    const cov = product.coverages.slice(0, 3).map((c) => `✅ ${c}`).join('\n');
    const reason = score.reasons[0] ?? 'se ajusta a lo que buscas';
    const isPet = product.category === 'mascotas';
    // Real live-test bug (2026-07-26): a mixed household (e.g. 1 gato + 2 perros) got a
    // re-shown single product priced against the RAW cross-species context.petCount (3),
    // not its own species' count — e.g. medicina-prepagada-gatos × 3 instead of × 1. Uses
    // the same species-aware helper buildMixedSpeciesQuote already relies on, so ANY call
    // site (fallback re-show, back-reference, this one) prices a species-restricted
    // product correctly even outside the dedicated mixed-species flow.
    const effectivePetCount = context ? this.petCountForProduct(context, product) : context?.petCount;
    const petCount = (isPet && effectivePetCount && effectivePetCount > 0) ? effectivePetCount : null;
    const pricePerUnit = product.basePremium;
    const total = computeTotalPremium(product, effectivePetCount ?? undefined);

    let priceBlock: string;
    if (isPet && petCount && petCount > 1) {
      priceBlock =
        `💰 *$${pricePerUnit.toLocaleString('es-CO')}/mes por mascota*\n` +
        `📊 *Total para ${petCount} mascotas: $${total.toLocaleString('es-CO')}/mes*`;
    } else if (isPet) {
      priceBlock = `💰 *$${pricePerUnit.toLocaleString('es-CO')}/mes por mascota*`;
    } else {
      priceBlock = `💰 *Desde $${pricePerUnit.toLocaleString('es-CO')}/mes*`;
    }

    const petNote = isPet
      ? '\n\n_Este seguro cubre a tus mascotas. Para ti también tenemos seguros de salud y accidentes — cuéntame si los quieres ver._'
      : '';

    return (
      `📋 *Tu cotización personalizada*\n\n` +
      `🛡️ *${product.name}* con ${product.insurer}\n${cov}\n\n` +
      `Te lo recomiendo porque: ${reason}.\n\n` +
      `👉 Ver detalles: ${product.url}\n\n` +
      `${priceBlock}${petNote}\n\n` +
      `¿Te interesa o prefieres que busquemos otra opción?`
    );
  }

  // 2026-07-26 live-test bug: answers a follow-up meta-question ("¿cuál es mejor?",
  // "cuéntame más", "explícame de qué se trata") with the FULL coverage list (formatQuote
  // truncates to top-3) plus the persuasive reason, instead of the same truncated card
  // being silently re-shown. When more than one product was already shown this turn,
  // names the other(s) so the user can ask to switch — no invented data, only fields
  // already in products.data.ts (rule #12).
  private formatProductDetail(product: InsuranceProduct, context: ConversationContext): string {
    const cov = product.coverages.map((c) => `✅ ${c}`).join('\n');
    const scored = this.quoting.score(context as AffiliateSignals).find((s) => s.productId === product.id);
    const reason = scored?.reasons[0] ?? 'se ajusta a lo que buscas';
    const others = (context.shownProductIds ?? [])
      .filter((id) => id !== product.id)
      .map((id) => PRODUCTS.find((p) => p.id === id))
      .filter((p): p is InsuranceProduct => !!p);
    const othersLine = others.length
      ? `\n\nTambién te mostré ${others.map((p) => p.name).join(' y ')} — dime si prefieres que profundice en ese en vez.`
      : '';

    return (
      `🛡️ *${product.name}* con ${product.insurer}\n${cov}\n\n` +
      `Te lo recomiendo porque: ${reason}.\n\n` +
      `👉 Ver detalles: ${product.url}\n` +
      `💰 Desde $${product.basePremium.toLocaleString('es-CO')}/mes${othersLine}\n\n` +
      `¿Te interesa o prefieres que busquemos otra opción?`
    );
  }

  // 2026-07-26 feature request: answers a COMPLETED customer's question about their OWN,
  // already-purchased policy — never a sales pitch (no "¿te interesa?", no persuasive
  // "reason" — that would read as re-selling something already bought). Falls back to
  // the generic COMPLETED text if none of the recorded ids still resolve to a real
  // product (shouldn't happen, but products.data.ts is hand-edited — rule #12 means
  // never fabricate a detail card for a product that no longer exists).
  private answerPolicyInquiry(context: ConversationContext): ProcessResult {
    const products = (context.purchasedProductIds ?? [])
      .map((id) => PRODUCTS.find((p) => p.id === id))
      .filter((p): p is InsuranceProduct => !!p);
    if (products.length === 0) {
      return { text: STATE_RESPONSES[ConversationState.COMPLETED](context) };
    }
    return { text: products.map((p) => this.formatPurchasedProductDetail(p)).join('\n\n') };
  }

  private formatPurchasedProductDetail(product: InsuranceProduct): string {
    const cov = product.coverages.map((c) => `✅ ${c}`).join('\n');
    return (
      `🛡️ *${product.name}* con ${product.insurer}\n${cov}\n\n` +
      `💰 $${product.basePremium.toLocaleString('es-CO')}/mes\n` +
      `👉 Más detalles: ${product.url}\n\n` +
      `¿Tienes alguna otra duda sobre tu póliza?`
    );
  }

  // Extracted from buildMixedSpeciesQuote (2026-07-26) so a RE-SHOW of an already-active
  // mixed-species purchase (wantsAlternative "otro", an unclear neutral fallback) can
  // reuse the exact same species-correct summary instead of falling through to a
  // single-product re-show priced against the raw cross-species petCount. Pure text
  // builder — never mutates context, since a re-show must not touch the purchase state.
  private formatMixedSpeciesQuote(context: ConversationContext): string {
    const gatoProduct = PRODUCTS.find((p) => p.id === 'medicina-prepagada-gatos')!;
    const perroProduct = PRODUCTS.find((p) => p.id === 'medicina-prepagada-perros')!;
    const gatoCount = this.petCountForProduct(context, gatoProduct) ?? 1;
    const perroCount = this.petCountForProduct(context, perroProduct) ?? 1;
    const gatoTotal = computeTotalPremium(gatoProduct, gatoCount);
    const perroTotal = computeTotalPremium(perroProduct, perroCount);
    const grandTotal = gatoTotal + perroTotal;

    const productBlock = (product: InsuranceProduct, count: number, total: number) =>
      `🛡️ *${product.name}* con ${product.insurer}\n` +
      product.coverages.slice(0, 3).map((c) => `✅ ${c}`).join('\n') + '\n' +
      `💰 *$${product.basePremium.toLocaleString('es-CO')}/mes por mascota* (${count} ${count === 1 ? 'mascota' : 'mascotas'}): *$${total.toLocaleString('es-CO')}/mes*\n` +
      `👉 Ver detalles: ${product.url}`;

    return (
      `📋 *Tu cotización personalizada*\n\n` +
      `${productBlock(gatoProduct, gatoCount, gatoTotal)}\n\n` +
      `${productBlock(perroProduct, perroCount, perroTotal)}\n\n` +
      `💰 *Total para tu familia: $${grandTotal.toLocaleString('es-CO')}/mes*\n\n` +
      `¿Te interesa o prefieres que busquemos otra opción?`
    );
  }

  // Real live-test bug: a mixed household (e.g. 2 dogs + 1 cat) was quoted a SINGLE
  // species-restricted product multiplied by the TOTAL pet count, silently charging the
  // other species at the wrong rate. Quotes BOTH medicina-prepagada products together,
  // each priced against its own species count — reuses the existing multi-product
  // (selectedProductIds) purchase machinery, so confirmation/payment/policy issuance
  // downstream needs no special-casing.
  private buildMixedSpeciesQuote(context: ConversationContext): ProcessResult {
    const selectedProductIds = ['medicina-prepagada-gatos', 'medicina-prepagada-perros'];
    return {
      text: this.formatMixedSpeciesQuote(context),
      nextState: ConversationState.QUOTE_PRESENTED,
      context: {
        ...context,
        quoteProductId: selectedProductIds[0],
        selectedProductIds,
        shownProductIds: [...new Set([...(context.shownProductIds ?? []), ...selectedProductIds])],
      },
    };
  }
}
