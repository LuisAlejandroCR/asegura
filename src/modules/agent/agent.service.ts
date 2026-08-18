// agent.service.ts: the conversation orchestrator — routes every inbound message
// through the state machine, asks the NLP layer for intent, and lets the rules engine
// decide product and price. Most comments below record a specific live-test bug and
// why the fix is shaped the way it is; they are the reason the flow looks like this.

import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import { INlpProvider, InsuranceIntent } from '../nlp/types';
import { TelegramAdapter } from '../channel/telegram-adapter.service';
import { ChannelRegistry } from '../channel/channel-registry.service';
import { ReminderService } from '../channel/reminder.service';
import { DocumentCacheService } from '../channel/document-cache.service';
import { WebSessionTokenService } from './web-session-token.service';
import { WebLinkCodeService } from './web-link-code.service';
import { NormalizedMessage } from '../channel/types';
import { ConversationService } from './conversation.service';
import { ConversationState, ConversationContext, Conversation, PetDetail, DocumentType } from './types';
import { STATE_RESPONSES, formatNameList, progressFor } from './conversation-state.machine';
import { pickPersistentFields } from './persistent-context';
import { QuotingService } from '../quoting/quoting.service';
import { AffiliateLookupService } from '../quoting/affiliate-lookup.service';
import { PolicyService } from '../policy/policy.service';
import { WompiService } from '../payments/wompi.service';
import { AffiliateSignals, InsuranceProduct, InsuranceScore, IProductRepository } from '../quoting/types';
import { ProductCatalog } from '../quoting/product-catalog.service';
import { computeTotalPremium } from '../quoting/pricing';
import { matchBreed } from './breed-matcher';

// The AseguraWeb (texto.html/voz.html) reply shape — handleWebMessage's return value,
// mirrored 1:1 from ProcessResult's dispatch branches in handleMessage/computeReply, just
// serialized instead of pushed through an IChannelAdapter. `quote` matches
// src/voice-agent/cotizar-tool.ts's CotizarResult shape on purpose — same product/price/
// reason data, same source (QuotingService), whether the session is voice or text.
// Split unit price from count so the UI never has to guess whether a number is per-pet
// or already multiplied — the ambiguity behind the understated card.
export interface WebQuoteLine {
  producto: string;
  aseguradora: string;
  precioUnitario: number;
  cantidad: number;
  subtotal: number;
  coberturas: string[];
  razon: string;
}

export interface WebReply {
  texts: string[];
  state: ConversationState;
  progress: { step: number; totalSteps: number; label: string };
  choices?: string[];
  quote?: { producto: string; aseguradora: string; precioMensual: number; coberturas: string[]; razon: string };
  // A mixed-species household is TWO products, and `quote` can only hold one — the card
  // showed the cat price as the whole premium. Every line, each priced by its own count.
  quotes?: WebQuoteLine[];
  totalMensual?: number;
  document?: { filename: string; downloadUrl: string };
  checkoutUrl?: string;
  expectedInput: 'text' | 'selfie';
}

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

// 2026-07-26 Step 4 — F01 buttons at AUTHORIZATION→isAffirmative. Only categories the
// catalog can sell (rule #12) — no vehículo/viaje/patrimonio/hogar product exists, so free
// text can still ask about them (detectOutOfCatalogCategory), but no button offers them.
// Exported so the label→parser invariant test shares this exact array as its source of truth.
export const F01_CHOICES = ['❤️ Mi familia', '🏥 Mi salud', '🐾 Mi mascota', '🤕 Accidentes', '🤔 No estoy seguro'];

// Live bug (2026-07-26): tapping "❤️ Mi familia" quoted a wrong category first. Not a
// scoring bug — no realistic input lets a related category outscore an exact match.
// Cause: Groq can misclassify a short emoji label, and the existing null-only guardrail
// never corrects a confident wrong answer. A button tap has zero ambiguity, so it's keyed
// deterministically here instead. "🤔 No estoy seguro" is absent on purpose — no forcing.
const F01_CATEGORY_MAP: Record<string, NonNullable<InsuranceIntent['productCategory']>> = {
  '❤️ mi familia': 'vida',
  '🏥 mi salud': 'asistencia',
  '🐾 mi mascota': 'mascotas',
  '🤕 accidentes': 'accidentes',
};

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    @Inject('INlpProvider')
    private readonly nlp: INlpProvider,
    // Admin escalation/lead notifications (below) are deliberately hardcoded to
    // Telegram, not resolved via `channels` — ops always monitors there regardless of
    // which channel the customer used.
    private readonly telegram: TelegramAdapter,
    private readonly channels: ChannelRegistry,
    private readonly conversations: ConversationService,
    private readonly quoting: QuotingService,
    private readonly policy: PolicyService,
    private readonly wompi: WompiService,
    private readonly reminders: ReminderService,
    private readonly affiliateLookup: AffiliateLookupService,
    private readonly config: ConfigService,
    // Reused as-is from the Twilio media-URL workaround (document-cache.service.ts) — a
    // web-session reply needs a fetchable download link too, same reason Twilio does.
    // Defaulted for the same test-helper convenience as `catalog` below.
    private readonly documentCache: DocumentCacheService = new DocumentCacheService(),
    // Mints the texto.html/voz.html links offered at DISCOVERY entry (plan-17 §11).
    // Defaulted to a fresh instance built from the SAME config param above — matches the
    // other optional-integration defaults in this constructor.
    private readonly webSessionTokens: WebSessionTokenService = new WebSessionTokenService(config),
    // Shortens those links before they hit the chat, so the session token isn't sitting in
    // plain sight in a message that gets screenshotted or forwarded. Defaulted like the
    // services above so the test helper keeps working without passing one.
    private readonly webLinkCodes: WebLinkCodeService = new WebLinkCodeService(),
    // Default keeps buildService() in agent.service.test-helpers.ts working unchanged
    // when it doesn't pass one — Nest's DI still injects the real shared singleton.
    @Inject('IProductRepository')
    private readonly catalog: IProductRepository = new ProductCatalog(),
  ) {}

  private static readonly TERMINAL_STATES = new Set([
    ConversationState.COMPLETED,
    ConversationState.ABANDONED,
    ConversationState.REJECTED,
  ]);

  // Live bug: "¿cuál es mejor?"/"cuéntame más"/"beneficios" carry no yes/no/alternative
  // signal and used to fall through to a silent re-show. Deterministic: it's a request for
  // more detail on the current product, not a new category for the NLP to classify.
  private static readonly MORE_INFO_PATTERN =
    /\b(cu[eé]ntame\s+m[aá]s|expl[ií]came|de\s+qu[eé]\s+se\s+trata|beneficios|cu[aá]l(?:\s+de\s+todos)?\s+es\s+mejor|mejor\s+para\s+m[ií])\b/i;

  // A COMPLETED customer asking about their OWN policy used to get the generic "¡Todo
  // listo!" no matter what they asked. Only checked in COMPLETED — never confused with
  // MORE_INFO_PATTERN above, which answers about a product still being shopped for.
  private static readonly POLICY_INQUIRY_PATTERN =
    /\b(mi p[oó]liza|mi seguro|lo que compr[eé]|lo que ya tengo|qu[eé]\s+cubre|c[oó]mo funciona mi|mi cobertura)\b/i;

  // Live bug: "la primera opción", "la anterior", "¿alguna más económica?" reference a
  // SPECIFIC already-shown product but had no handler — fell through to a blind re-show,
  // or worse got matched as isAffirmative (confirming the wrong one). Checked
  // deterministically before isAffirmative/wantsAlternative: an explicit reference always
  // wins over a probabilistic LLM guess.
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
      .map((id) => this.catalog.getProduct(id))
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
        const current = this.catalog.getProduct(context.quoteProductId);
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


  // `channel` picks which adapter normalizes the raw payload and sends the reply — the
  // Telegram/Twilio webhook controllers each know which one they are, so it's passed in
  // rather than guessed from the payload shape. Admin notifications below (escalation,
  // leads) stay hardcoded to Telegram regardless — ops always monitors there.
  // Default 'telegram' keeps every existing `handleMessage(raw)` call in the spec files
  // working unchanged — Telegram was the only channel before this parameter existed.
  async handleMessage(raw: unknown, channel: 'telegram' | 'whatsapp' = 'telegram'): Promise<void> {
    const adapter = this.channels.get(channel);
    const msg: NormalizedMessage = await adapter.normalize(raw);

    if (msg.unsupportedInput) {
      const text = msg.unsupportedInput === 'audio_too_long'
        ? 'Solo puedo procesar audios cortos. Intenta de nuevo.'
        : 'No puedo leer imágenes, solo audio o texto. Intenta de nuevo.';
      await adapter.sendText(msg.userId, text);
      return;
    }

    // A contact-share (KYC) or a photo (cosmetic selfie-KYC) message carries no text at
    // all — let it through instead of the usual empty-text bail, since AgentService
    // needs to see it.
    if (!msg.text && !msg.contact && !msg.photo) return;

    this.logger.log(`Message from ${msg.userId}: "${msg.text.slice(0, 80)}"`);

    const { result } = await this.computeReply(msg);

    if (result.document) {
      await adapter.sendDocument(msg.userId, result.document.buffer, result.document.filename);
    }

    if (result.animation) {
      await adapter.sendAnimation(msg.userId, result.animation);
    }

    if (result.reaction && msg.messageId !== undefined) {
      await adapter.reactToMessage(msg.userId, msg.messageId, result.reaction, result.reactionBig);
    }

    if (result.requestContact && result.text) {
      await adapter.sendContactRequest(msg.userId, result.text);
    } else if (result.choices?.length && result.text) {
      await adapter.sendChoices(msg.userId, result.text, result.choices);
    } else if (result.texts?.length) {
      for (const t of result.texts) {
        await adapter.sendText(msg.userId, t);
      }
    } else if (result.text) {
      await adapter.sendText(msg.userId, result.text);
    }
  }

  // Shared core between handleMessage (Telegram/WhatsApp, dispatches the result through an
  // IChannelAdapter above) and handleWebMessage (AseguraWeb, returns the result as JSON
  // instead — see web-session.controller.ts). Both entry points build their own
  // NormalizedMessage and call this; conversation identity is resolved purely from
  // msg.userId + msg.channel, so a web-originated message carrying the ORIGINAL
  // Telegram/WhatsApp userId+channel lands on the exact same conversation row
  // (unique index on (user_id, channel)) — no separate "web channel" conversation ever
  // gets created.
  private async computeReply(msg: NormalizedMessage): Promise<{ conv: Conversation; result: ProcessResult }> {
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

    return { conv, result };
  }

  // AseguraWeb (texto.html/voz.html) entry point — see web-session.controller.ts. The
  // token only ever carries a conversationId (plan-17 §11); everything else (channel,
  // userId) is resolved fresh from the DB here, never trusted from client input, so a
  // web-originated message lands on the exact same conversation the chat link was minted
  // from (computeReply's getOrCreate resolves by that SAME user_id+channel).
  async handleWebMessage(
    conversationId: string,
    input: { text?: string; photo?: { width: number; height: number } },
  ): Promise<WebReply> {
    const existing = await this.conversations.findById(conversationId);
    if (!existing) {
      throw new NotFoundException('Web session no longer valid');
    }

    const conv = await this.conversations.getOrCreate(existing.user_id, existing.channel);

    const msg: NormalizedMessage = {
      channelId: conv.user_id,
      channel: conv.channel as 'telegram' | 'whatsapp',
      userId: conv.user_id,
      text: input.text ?? '',
      timestamp: new Date(),
      // The signed token itself is proof of possession of the original chat identity —
      // only that specific Telegram/WhatsApp conversation could have received the link.
      // No browser equivalent of Telegram's request_contact button exists, so this
      // mirrors twilio-whatsapp-adapter.service.ts's own pattern EXACTLY: attach `contact`
      // unconditionally so AgentService's existing phoneVerified gate (built for
      // Telegram's opt-in contact share, reused as-is by WhatsApp's WaId) is satisfied for
      // free here too — no new special-casing in the DATA_CAPTURE handler itself.
      contact: { phoneNumber: conv.user_id, firstName: '' },
      ...(input.photo && { photo: input.photo }),
    };

    const { result } = await this.computeReply(msg);
    return this.toWebReply(result, conv);
  }

  private toWebReply(result: ProcessResult, conv: Conversation): WebReply {
    const finalState = result.nextState ?? conv.state;
    const finalContext = result.context ?? conv.context;
    const texts = result.texts?.length ? result.texts : (result.text ? [result.text] : []);

    const reply: WebReply = {
      texts,
      state: finalState,
      progress: progressFor(finalState),
      expectedInput: finalContext.awaitingSelfie ? 'selfie' : 'text',
    };

    if (result.choices?.length) {
      reply.choices = result.choices;
    }

    if (finalContext.checkoutUrl) {
      reply.checkoutUrl = finalContext.checkoutUrl;
    }

    // Same shape/source as src/voice-agent/cotizar-tool.ts's CotizarResult — the resumen
    // sheet reads structured data, never the markdown-formatted `.text` meant for chat.
    if (finalState === ConversationState.QUOTE_PRESENTED && finalContext.quoteProductId) {
      // selectedProductIds holds every product of a multi-product quote (mixed-species
      // households); it's absent for an ordinary single-product one.
      const quotedIds = finalContext.selectedProductIds?.length
        ? finalContext.selectedProductIds
        : [finalContext.quoteProductId];
      const allScores = this.quoting.score(finalContext as AffiliateSignals);

      const lines = quotedIds
        .map((id) => this.catalog.getProduct(id))
        .filter((p): p is InsuranceProduct => !!p)
        .map((product) => {
          // Same per-species count the chat text prices with — never the combined total.
          const cantidad = this.petCountForProduct(finalContext, product) ?? 1;
          return {
            producto: product.name,
            aseguradora: product.insurer,
            precioUnitario: product.basePremium,
            cantidad,
            subtotal: computeTotalPremium(product, cantidad),
            coberturas: product.coverages.slice(0, 3),
            razon: allScores.find((s) => s.productId === product.id)?.reasons?.[0] ?? '',
          };
        });

      if (lines.length) {
        reply.quotes = lines;
        reply.totalMensual = lines.reduce((sum, l) => sum + l.subtotal, 0);

        const first = this.catalog.getProduct(finalContext.quoteProductId);
        if (first) {
          const score = allScores.find((s) => s.productId === first.id);
          reply.quote = {
            producto: first.name,
            aseguradora: first.insurer,
            precioMensual: score?.monthlyPremium ?? computeTotalPremium(first, finalContext.petCount),
            coberturas: first.coverages.slice(0, 3),
            razon: score?.reasons?.[0] ?? '',
          };
        }
      }
    }

    if (result.document) {
      const token = this.documentCache.put(result.document.buffer, result.document.filename);
      reply.document = { filename: result.document.filename, downloadUrl: `/downloads/${token}` };
    }

    return reply;
  }

  // Live-test feedback: escalate to a human instead of repeating "no logré entender"
  // forever. Counts only turns explicitly flagged unclear (ProcessResult.unclearReply) —
  // a follow-up question in a normal multi-turn conversation never trips this.
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

  // 2026-07-26 — a lead captured after every product in a category ran out (the
  // "¿te interesa que te avise?" waitlist offer). Same optional-integration pattern as
  // notifyAdminEscalation above: degrades silently with no ADMIN_CHAT_ID configured,
  // reuses telegram.sendText instead of a dedicated leads store — this app has none.
  private async notifyAdminLead(context: ConversationContext): Promise<void> {
    const adminChatId = this.config.get<string>('ADMIN_CHAT_ID');
    if (!adminChatId) return;
    const text =
      `📋 *Nuevo lead — sin oferta disponible*\n\n` +
      `Nombre: ${context.contactName}\n` +
      `Correo: ${context.contactEmail}\n` +
      `Teléfono: ${context.contactPhone}\n` +
      `Categoría de interés: ${context.productCategory ?? 'no especificada'}`;
    await this.telegram.sendText(adminChatId, text);
  }

  // Live bug: a returning customer with nombre/email already known still got asked from
  // scratch when accepting the waitlist offer — violates "nunca preguntar lo que ya
  // sabemos". Pre-fills from whatever's known, asks only what's missing; skips straight to
  // finalizing if everything's already known.
  private beginLeadCapture(context: ConversationContext): ProcessResult {
    const filled: ConversationContext = {
      ...context,
      awaitingContactConsent: undefined,
      contactName: context.contactName ?? context.nombre,
      contactEmail: context.contactEmail ?? context.email,
      contactPhone: context.contactPhone ?? context.verifiedPhone,
    };
    if (!filled.contactName) {
      return {
        text: 'Genial, ¿cuál es tu nombre?',
        nextState: ConversationState.DATA_CAPTURE,
        context: { ...filled, awaitingContactName: true },
      };
    }
    if (!filled.contactEmail) {
      return {
        text: 'Gracias. ¿Cuál es tu correo electrónico?',
        nextState: ConversationState.DATA_CAPTURE,
        context: { ...filled, awaitingContactEmail: true },
      };
    }
    if (!filled.contactPhone) {
      return {
        text: 'Perfecto. Por último, ¿cuál es tu número de teléfono?',
        nextState: ConversationState.DATA_CAPTURE,
        context: { ...filled, awaitingContactPhone: true },
      };
    }
    return this.finalizeLead(filled);
  }

  // Extracted so both the "everything already known" fast path (beginLeadCapture above)
  // and the "just finished asking for the phone number" path (handleDataCapture below)
  // share the exact same notify+end logic instead of duplicating it.
  private finalizeLead(context: ConversationContext): ProcessResult {
    const terminalState = context.hasCompletedPurchase
      ? ConversationState.COMPLETED
      : ConversationState.ABANDONED;
    // Fire-and-forget, same pattern as notifyAdminEscalation — never blocks or breaks
    // the real response if it fails or ADMIN_CHAT_ID isn't configured.
    this.notifyAdminLead(context).catch((err) =>
      this.logger.warn(`Admin lead notification failed: ${err}`),
    );
    return {
      text: 'Listo ✅ Te avisaremos cuando tengamos nuevas opciones. Si cambias de opinión mientras tanto, aquí estoy.',
      nextState: terminalState,
      context,
    };
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
      // Live bug (confirmed in production Supabase): two conversations that had already
      // completed a purchase ended up 'abandoned' after later declining to buy more.
      // "Abandoned before buying" and "bought, then declined more" must never share a status.
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
          // Live bug: a returning affiliate with `serieId` already known (surviving via
          // persistent memory) still got asked "Ingresa tu ID..." again — violates "nunca
          // preguntar lo que ya sabemos". `serieId` is always set once a lookup succeeds,
          // so it's the one reliable signal here.
          if (context.serieId) {
            const knownContext: ConversationContext = { ...context, autorizado: true, discoveryFilter: true };
            return this.offerDiscoveryEntry(
              'Ya te habías afiliado a Colsubsidio, así que ya tengo tu perfil.\n\n',
              knownContext,
            );
          }
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
        return this.handleDiscovery(convId, context, text, intent);

      case ConversationState.QUOTING:
      case ConversationState.QUOTE_PRESENTED:
        return this.handleQuotation(context, text, intent);

      case ConversationState.DATA_CAPTURE:
        return this.handleDataCapture(convId, context, text, intent, rawText, contact, photo);

      case ConversationState.PAYMENT:
        return this.handlePayment(convId, context, text, intent);

      default:
        // Live bug: ReminderService's auto-close promises "aquí estoy — 24/7", but
        // ABANDONED/REJECTED only restarted on an exact hola/ayuda/inicio match — any
        // real follow-up got stuck on the same terminal reply forever. Restart
        // unconditionally here. COMPLETED excluded: those hold real KYC data and blindly
        // resetting would force a paying customer to redo verification.
        if (currentState === ConversationState.ABANDONED || currentState === ConversationState.REJECTED) {
          // Persistent memory: carries forward durable profile facts instead of wiping to
          // {}. Session-scoped state still resets for a fresh inquiry.
          // Live bug: this rendered GREETING's text but set nextState back to GREETING, so
          // the user's next message re-rendered the identical text before reaching
          // AUTHORIZATION. nextState: AUTHORIZATION (matching case GREETING) shows it once.
          const remembered = pickPersistentFields(context);
          return {
            text: STATE_RESPONSES[ConversationState.GREETING](remembered),
            nextState: ConversationState.AUTHORIZATION,
            context: remembered,
          };
        }
        // Checked before the hola/ayuda restart below — "necesito ayuda con mi póliza" is
        // about an existing purchase, not a restart. Gated on purchasedProductIds, not
        // policyId/policyIds (already cleared for the next purchase) — see types.ts.
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

  // Affiliate ID lookup. "Nunca preguntar lo que ya sabemos" for income: this is the one
  // signal Colsubsidio can supply if the user self-identifies via SERIE. A decline, an
  // unrecognized-but-numeric ID, or lookup being disabled all proceed to DISCOVERY
  // identically, just without the rangoSalarial boost. Only a non-numeric, non-"no" answer
  // is rejected (digit-shape guard below).
  //
  // SERIE is a plain row number (1..500000, matching the CSV), not a length check like cédula.
  private static readonly MAX_SERIE = 500_000;

  private handleAffiliateId(context: ConversationContext, text: string, rawText: string): ProcessResult {
    const baseContext: ConversationContext = { ...context, awaitingAffiliateId: undefined };
    const declines = /^no\b/i.test(text.trim()) || !rawText.trim();

    if (!declines) {
      // Reuses the same digit-extraction convention as cédula (joinSpokenDigits handles
      // a number dictated one digit at a time by voice, e.g. "1, 2, 3, 4, 5, 6, 7, 8, 9.").
      const serie = this.joinSpokenDigits(rawText).replace(/\D/g, '');

      // Live bug: a non-numeric, non-"no" answer ("Juan") was silently treated as an
      // implicit decline, advancing to DISCOVERY without telling the user. Only digits or
      // "no" pass now. Range 1–MAX_SERIE, not a digit-count check — SERIE is a sequential
      // row number, so a length check would reject most genuine values. Returns neither
      // `context` nor `nextState`: the conversation stays put and re-fires this gate.
      const serieNum = serie ? Number(serie) : NaN;
      if (!serie || !Number.isFinite(serieNum) || serieNum < 1 || serieNum > AgentService.MAX_SERIE) {
        return {
          text: `Tu ID de afiliado debe ser un número entre 1 y ${AgentService.MAX_SERIE.toLocaleString('es-CO')}. Si no eres afiliado, escríbeme "no".`,
        };
      }

      if (this.affiliateLookup.isEnabled()) {
        const record = this.affiliateLookup.findBySerie(serie);
        // Any match enriches now, not just one with rangoSalarial/dependents;
        // affiliateProfile carries the FULL row forward (types.ts), even unread fields.
        if (record) {
          const enriched: ConversationContext = {
            ...baseContext,
            serieId: serie,
            cedula: serie,
            documentType: 'CC',
            affiliateProfile: record,
            ...(record.segmentoGrupoFamiliar !== undefined ? { segmentoGrupoFamiliar: record.segmentoGrupoFamiliar } : {}),
            ...(record.rangoSalarial !== undefined ? { rangoSalarial: record.rangoSalarial } : {}),
            // Pre-fills dependents+askedDependents only for the confidently-known-zero
            // case. Family-segment minimums stay in affiliateProfile.dependents as a
            // fallback — the live question is still asked so a real answer wins.
            ...(record.segmentoGrupoFamiliar === 'AFILLIADO SIN GRUPO_FAMILIAR' && baseContext.dependents === undefined
              ? { dependents: 0, askedDependents: true }
              : {}),
            ...(record.petCount !== undefined && baseContext.petCount === undefined
              ? { petCount: record.petCount }
              : {}),
          };
          return this.offerDiscoveryEntry(
            '¡Encontré tu perfil! Esto me ayuda a personalizar mejor tu cotización.\n\n',
            enriched,
          );
        }
      }
    }

    return this.offerDiscoveryEntry('', baseContext);
  }

  // Sends F01's category buttons — or, if AseguraWeb is configured (WEB_APP_URL), asks
  // "¿hablar o escribir?" first (plan-17 §11). `awaitingWebModalityChoice`'s gate at the
  // top of handleDiscovery resolves that reply and falls back to these SAME F01 choices
  // once it's answered (or unrecognized) — or immediately, if AseguraWeb isn't
  // configured, which is today's exact behavior, byte-for-byte unchanged.
  // Swaps a long signed AseguraWeb URL for a short single-use one on the backend's own
  // host, so the session token never sits in plain view in a chat message. The short host
  // MUST be the backend (it serves /s/:code) — WEB_APP_URL points at the static site, which
  // has no such route. With PUBLIC_URL unset there is no host to build, so the long link
  // goes out unchanged: a visible token beats a link that 404s.
  private shortLink(destination: string): string {
    const publicUrl = this.config.get<string>('PUBLIC_URL');
    if (!publicUrl) return destination;
    return `${publicUrl.replace(/\/$/, '')}/s/${this.webLinkCodes.mint(destination)}`;
  }

  private offerDiscoveryEntry(prefix: string, context: ConversationContext): ProcessResult {
    if (this.config.get<string>('WEB_APP_URL')) {
      return {
        text: `${prefix}¿Prefieres seguir aquí escribiendo, o te paso a una página donde puedes hablar o escribir con más calma?`,
        nextState: ConversationState.DISCOVERY,
        context: { ...context, awaitingWebModalityChoice: true },
        choices: ['🗣️ Hablar', '⌨️ Escribir', '💬 Seguir aquí'],
      };
    }
    return {
      text: `${prefix}${STATE_RESPONSES[ConversationState.DISCOVERY](context)}`,
      nextState: ConversationState.DISCOVERY,
      context,
      choices: F01_CHOICES,
    };
  }

  // Discovery

  // Resolves the AseguraWeb "¿hablar o escribir?" reply set up by offerDiscoveryEntry
  // above. Returns null when the reply doesn't clearly say either — the caller then
  // clears the flag and lets the SAME message fall through to normal DISCOVERY handling
  // (F01/free text), so a real answer typed instead of tapping a choice is never lost.
  private resolveWebModalityChoice(convId: string, context: ConversationContext, text: string): ProcessResult | null {
    const lower = text.toLowerCase();
    // Live bug (2026-08-18): the question names both options ("¿hablar o escribir?"), so
    // people answer naming both — "escribir, no hablar", "escribir mejor que hablar". Voice
    // used to win on a bare mention, recording the choice INVERTED. It surfaces at the very
    // end: webModality builds Wompi's redirect_url, so someone who asked to write got the
    // voice page opened on them right after paying. Drop negated mentions, then let
    // whichever option is named FIRST win — that's the one people lead with.
    const stripped = lower.replace(
      /\bno\s+(?:quiero\s+|me\s+gusta\s+|puedo\s+)?(?:hablar|voz|audio|llamar|escribir|texto|chat)\b/g,
      ' ',
    );
    const voiceAt = stripped.search(/\b(hablar|voz|audio|llamar)\b/);
    const textAt = stripped.search(/\b(escribir|texto|escrib|chat)\b/);
    if (voiceAt < 0 && textAt < 0) return null;
    const wantsVoice = voiceAt >= 0 && (textAt < 0 || voiceAt < textAt);

    const webAppUrl = this.config.get<string>('WEB_APP_URL');
    const token = webAppUrl ? this.webSessionTokens.sign({ conversationId: convId }) : null;
    // Shouldn't happen — the gate is only ever set when WEB_APP_URL is configured — but
    // never crash on a misconfiguration; the caller clears the flag and continues normally.
    if (!webAppUrl || !token) return null;

    const modality: 'voz' | 'texto' = wantsVoice ? 'voz' : 'texto';
    const verb = wantsVoice ? 'hablar' : 'escribir';
    const destination = `${webAppUrl.replace(/\/$/, '')}/${modality}.html?token=${token}`;
    return {
      text: `Perfecto, puedes ${verb} aquí: ${this.shortLink(destination)}\n\n` +
        'Cuando termines, vuelve al chat — o sigue escribiéndome aquí si prefieres.',
      // webModality persists (never cleared here) — createPaymentLinkFlow reads it later
      // to mint a fresh token and set Wompi's redirect_url (plan-17 §12), so checkout
      // returns the browser to the same AseguraWeb page instead of Wompi's own screen.
      context: { ...context, awaitingWebModalityChoice: undefined, webModality: modality },
    };
  }

  private handleDiscovery(
    convId: string,
    context: ConversationContext,
    text: string,
    intent: InsuranceIntent,
  ): ProcessResult {
    if (context.awaitingWebModalityChoice) {
      const resolved = this.resolveWebModalityChoice(convId, context, text);
      if (resolved) return resolved;
      context = { ...context, awaitingWebModalityChoice: undefined };
    }

    const newContext: ConversationContext = { ...context };

    // After a purchase, the cross-sell "¿Quieres proteger algo más?" resets to DISCOVERY —
    // a decline used to fall through to the generic "no entendí" acknowledgment. Only
    // fires on a genuine decline with no new category in the same breath ("no, quiero
    // vida" still quotes vida); always clears the flag so it can't hijack a later "no".
    if (context.awaitingCrossSellResponse) {
      // Live bug: Groq's isNegative had no example for elliptical negations ("No, ningún
      // otro."), misclassifying them as false. A message starting with standalone "no" is
      // an unambiguous decline regardless of what the LLM extracted.
      const clearlyDeclines = intent.isNegative || /^no\b/i.test(text.trim());
      // Live bug: trusting intent.productCategory directly let Groq hallucinate a category
      // from a decline naming no product ("No, la póliza está mal."), silently defeating
      // the decline check and re-quoting the stale product — a customer who said their
      // policy was WRONG got a second payment link for the same product. Requires real
      // textual evidence, same check handleQuotation's cross-sell trigger already uses.
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

    // Live bug: a plain "no" to "¿Tienes familia...?" got the same question repeated
    // verbatim — "no dependents" is a valid answer, not unclear input. Scoped to
    // early/fresh DISCOVERY only, so it never hijacks a later "no" mid-conversation.
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

    // Symmetric case: "Sí?" alone to "¿Tienes familia...?" names no category, so it fell
    // through to the generic fallback repeating the whole compound question verbatim.
    // Same scoping as the negative pivot above: only fresh/early DISCOVERY.
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

    // A button tap must never be silently misclassified — see F01_CATEGORY_MAP's comment.
    // Checked before the normal fill-in-if-empty assignment so a deliberate tap always wins.
    const f01Category = F01_CATEGORY_MAP[text];
    if (f01Category) {
      newContext.productCategory = f01Category;
    } else if (!context.productCategory && intent.productCategory) {
      newContext.productCategory = intent.productCategory;
    }
    // Handle clarification response when we already know it's a mixed-pet household
    if (context.petType === 'mixto') {
      // Extract species counts from current message and merge with previously known.
      // Must run before the resolution check below so a quantity answer
      // (e.g. "2 gatos y 1 perro") is captured before the else clause sees it.
      const curCounts = this.extractSpeciesCounts(text);
      if (curCounts.gato > 0 || curCounts.perro > 0) {
        newContext.petSpeciesCounts = {
          gato: curCounts.gato || (context.petSpeciesCounts?.gato ?? 0),
          perro: curCounts.perro || (context.petSpeciesCounts?.perro ?? 0),
        };
      }

      // Live bug: "Una gata y dos perros." (both counts in one message) got petResolution
      // misread as 'perro' — naming a species while stating its count isn't the same as
      // choosing "solo esa especie". Once BOTH counts are known, any single-species
      // petResolution is spurious and must be cleared — otherwise the household silently
      // lost one species from the quote entirely. Deliberate narrowing ("solo perros") is
      // a later step, handled by handleQuotation's own guard once a quote is on screen.
      const p = newContext.petSpeciesCounts;
      if (p?.gato && p?.perro && (intent.petResolution === 'gato' || intent.petResolution === 'perro')) {
        intent.petResolution = null;
      }

      if (intent.petResolution === 'gato') {
        newContext.petType = 'gato';
      } else if (intent.petResolution === 'perro') {
        newContext.petType = 'perro';
      } else if (intent.petResolution === 'all') {
        newContext.petType = null;
      } else if (intent.petType && intent.petType !== 'mixto') {
        newContext.petType = intent.petType;
      } else if (newContext.petSpeciesCounts?.gato && newContext.petSpeciesCounts?.perro) {
        // Once both counts are known, ask individual vs. combined ("para todos") — skipping
        // straight to a combined quote here was a regression, reverted. Answer handled by
        // the petResolution branches above on the next turn.
        return {
          text: `Entendido, tienes ${newContext.petSpeciesCounts.gato} gato${newContext.petSpeciesCounts.gato !== 1 ? 's' : ''} y ${newContext.petSpeciesCounts.perro} perro${newContext.petSpeciesCounts.perro !== 1 ? 's' : ''}. ¿Quieres el seguro para los gatos, los perros, o para todos?`,
          context: newContext,
        };
      } else if (newContext.petSpeciesCounts?.gato !== undefined || newContext.petSpeciesCounts?.perro !== undefined) {
        // Partial counts — one species known, the other needs to be asked
        const p = newContext.petSpeciesCounts!;
        if (p.gato && !p.perro) {
          return {
            text: `Entendido, tienes ${p.gato} gato${p.gato !== 1 ? 's' : ''}. ¿Cuántos perros tienes?`,
            context: newContext,
          };
        }
        return {
          text: `Entendido, tienes ${p.perro} perro${p.perro !== 1 ? 's' : ''}. ¿Cuántos gatos tienes?`,
          context: newContext,
        };
      } else {
        return {
          text: '¿Para cuál mascota? Escríbeme "el gato", "los perros" o "para todos".',
          context,
        };
      }
      if (!newContext.coverage?.length) newContext.coverage = ['medicina veterinaria'];

      if (intent.petResolution === 'all') {
        if (newContext.petSpeciesCounts?.gato && newContext.petSpeciesCounts?.perro) {
          return this.buildMixedSpeciesQuote(newContext);
        }
        // Partial counts — ask for the missing one
        if (newContext.petSpeciesCounts?.gato && !newContext.petSpeciesCounts?.perro) {
          return {
            text: `Entendido, tienes ${newContext.petSpeciesCounts.gato} gato${newContext.petSpeciesCounts.gato !== 1 ? 's' : ''}. ¿Cuántos perros tienes?`,
            context: newContext,
          };
        }
        if (!newContext.petSpeciesCounts?.gato && newContext.petSpeciesCounts?.perro) {
          return {
            text: `Entendido, tienes ${newContext.petSpeciesCounts.perro} perro${newContext.petSpeciesCounts.perro !== 1 ? 's' : ''}. ¿Cuántos gatos tienes?`,
            context: newContext,
          };
        }
        // No per-species counts yet — ask for quantity breakdown
        return {
          text: 'Genial, ¿cuántos gatos y cuántos perros tienes? Así calculo el valor exacto.',
          context,
        };
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
      // Live bug: "Tengo dos perros, una gata y yo." quoted a single product multiplied by
      // the TOTAL pet count, charging dogs at the cat rate. Capture the per-species
      // breakdown now, before the original message naming both species is gone.
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
      // Wakes the "Cubre a N personas" family reason too, no separate beneficiaries
      // question needed. `<= 1` not just falsy: Groq's schema shows beneficiaries:1 as an
      // example the LLM often defaults to with no real signal — must not block dependents.
      if (intent.dependents > 0 && (!newContext.beneficiaries || newContext.beneficiaries <= 1)) {
        newContext.beneficiaries = intent.dependents + 1;
      }
    }

    // CSV fallback when the dependents question was asked but got no parseable answer.
    // Only fires when askedDependents is true and dependents is still undefined after
    // probing — the AFILLIADO SIN GRUPO_FAMILIAR / dependents=0 case is already pre-filled.
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

    // Catalog-honesty bridge: "quiero asegurar mi carro" had no branch in DISCOVERY — no
    // such product exists, so it looped on the generic question forever.
    // detectOutOfCatalogCategory already existed for QUOTE_PRESENTED; DISCOVERY didn't have
    // it. Guarded on productCategory unresolved so "tengo... una empresa" isn't hijacked
    // once vida/mascotas already matched above.
    if (!newContext.productCategory) {
      const outOfCatalog = this.detectOutOfCatalogCategory(text);
      if (outOfCatalog) {
        return {
          text: `Por ahora no tengo seguros de ${outOfCatalog}, pero sí tengo vida, accidentes, asistencia médica y mascotas. ¿Te interesa alguno de estos?`,
          context: newContext,
        };
      }
    }

    // First time detecting mixed pets — ask for quantity breakdown before quoting.
    // Must ask counts first so "para todos" can quote both species at the right price.
    if (newContext.petType === 'mixto') {
      // Live bug (2026-08-18): "Tengo dos perros y un gato." states the breakdown in the
      // very message that reveals the mixed household, and the block above already saved
      // it — but this branch asked for it anyway, so the person had to repeat themselves
      // to a agent that had just written their answer down. Only ask for what's missing.
      const known = newContext.petSpeciesCounts;
      if (known?.gato && known?.perro) {
        return {
          text: `Entendido, tienes ${known.gato} gato${known.gato !== 1 ? 's' : ''} y ${known.perro} perro${known.perro !== 1 ? 's' : ''}. ¿Quieres el seguro para los gatos, los perros, o para todos?`,
          context: newContext,
        };
      }
      return {
        text: '¡Qué bonita familia de mascotas! 🐱🐶 ¿Cuántos gatos y cuántos perros tienes? Así calculo el valor exacto.',
        context: newContext,
      };
    }

    // Must know the species before quoting mascotas — the catalog has cat-only and
    // dog-only products, quoting blind risks missing the better match. Live gap: "Tengo
    // dos mascotas y yo." went straight to a quote without learning cat/dog/mixed.
    // Gated on !coverage?.length too — "para todos" resolves petType to null and always
    // sets coverage, so this must not re-ask in that case.
    if (newContext.productCategory === 'mascotas' && !newContext.petType && !newContext.coverage?.length) {
      return {
        text: '¿Tus mascotas son gatos, perros, o tienes de ambos? Así te muestro la cobertura correcta.',
        context: newContext,
      };
    }

    // Step 3: ask about dependents ONCE, only in the discoveryFilter flow, and only when it
    // could change the recommendation — mascotas is excluded (Principle #3: only ask
    // questions that change the recommendation). askedDependents set in this same return,
    // so the next turn always proceeds regardless of whether the answer parsed.
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

    // coverage is NOT required to score — QuotingService only needs productCategory for a
    // matchScore > 0. Requiring it here stranded every quote in an infinite loop whenever
    // fallbackIntent() ran (it never fills coverage).
    const hasEnoughInfo = !!newContext.productCategory;

    // Dead-end guard: DISCOVERY's third tier text is permanently unanswerable — no NLP
    // field captures it, Step 3's `dependents` is the real replacement. If productCategory
    // never got extracted, every reply loops back to it forever.
    //
    // Live bug: this guard also required `beneficiaries` truthy before a best-effort quote
    // (stale condition left behind after the text itself was rewritten). Coverage set
    // without beneficiaries fell through to the dead text. Dropped that requirement —
    // coverage alone is enough to attempt a real quote.
    const stuckWithoutCategory = !hasEnoughInfo && !!newContext.coverage?.length;

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

    // No new signal this turn — acknowledge instead of silently repeating the question.
    // `beneficiaries` excluded: Groq's schema shows it defaulting to 1 with no real signal.
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
      // Only the genuinely-stuck branch counts toward escalation — madeProgress means real
      // signal was extracted, just not enough to quote yet, which is normal, not confusion.
      unclearReply: !madeProgress,
    };
  }

  // Quotation

  private handleQuotation(context: ConversationContext, text: string, intent: InsuranceIntent): ProcessResult {
    // This flag is set when a category's alternatives run out, but the conversation stays
    // anchored in QUOTE_PRESENTED — so the reply is processed here, not through
    // AUTHORIZATION. A previous version checked it in AUTHORIZATION, which was
    // unreachable dead code that left the waitlist offer with no working answer path.
    if (context.awaitingContactConsent) {
      if (intent.isAffirmative) {
        return this.beginLeadCapture(context);
      }
      if (intent.isNegative || intent.abandonIntent) {
        const terminalState = context.hasCompletedPurchase
          ? ConversationState.COMPLETED
          : ConversationState.ABANDONED;
        return {
          text: STATE_RESPONSES[terminalState](context),
          nextState: terminalState,
        };
      }
      return {
        text: 'No entendí. Si quieres, puedo guardar tus datos y avisarte cuando tengamos más opciones. ¿Te interesa? Responde "sí" o "no".',
      };
    }

    const currentProduct = this.catalog.getProduct(context.quoteProductId);

    // Live bug: "salir" then "terminar" right after a quote got the identical card
    // re-shown both times — no branch here checked intent.abandonIntent, and
    // processMessage's top-level check excludes QUOTE_PRESENTED on purpose.
    if (intent.abandonIntent) {
      const terminalState = context.hasCompletedPurchase
        ? ConversationState.COMPLETED
        : ConversationState.ABANDONED;
      return {
        text: STATE_RESPONSES[terminalState](context),
        nextState: terminalState,
      };
    }

    // Live bug: "No, pero no tengo gatos..." while a gato quote was showing got the
    // identical quote re-shown — the multi-clause correction didn't trip Groq's
    // classification. An explicit "no tengo <species just quoted>" is unambiguous
    // regardless of what the LLM extracted; resets petType/coverage/quote for a clean re-ask.
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

    // Switch between species (or back to both) in a mixed household. Live bug: gating on
    // `selectedProductIds.length > 1` only worked for the ORIGINAL combined quote — once
    // narrowed to one species, naming the other fell through with no way back. Gating on
    // `petSpeciesCounts` having both species known (unchanged by narrowing) fixes it.
    if (context.petSpeciesCounts?.gato && context.petSpeciesCounts?.perro) {
      if (intent.petResolution === 'all') {
        return this.buildMixedSpeciesQuote(context);
      }
      if (intent.petResolution === 'gato' || intent.petResolution === 'perro') {
        const species = intent.petResolution;
        const speciesProductId = species === 'gato' ? 'medicina-prepagada-gatos' : 'medicina-prepagada-perros';
        const speciesProduct = this.catalog.getProduct(speciesProductId);
        if (speciesProduct) {
          return {
            text: this.formatQuote(speciesProduct, { reasons: [], monthlyPremium: speciesProduct.basePremium }, context),
            nextState: ConversationState.QUOTE_PRESENTED,
            context: {
              ...context,
              petType: species,
              selectedProductIds: [speciesProductId],
              quoteProductId: speciesProductId,
              shownProductIds: [...new Set([...(context.shownProductIds ?? []), speciesProductId])],
            },
          };
        }
      }
    }

    // "Restore the flow": a quote in progress is never interrupted by a different
    // category — it's deferred until after this purchase is paid (notifyPoliciesIssued
    // reads context.pendingCrossSell). Live bug: naming a different category mid-quote
    // used to replace it immediately, silently abandoning an unconfirmed purchase. Close
    // one deal at a time.
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

    // Live bug: "la primera opción", "la que vale 16.800" reference a SPECIFIC shown
    // product — checked before isAffirmative so it can't get matched as a blind
    // confirmation of a differently-priced product on screen (a customer naming $16.800
    // ended up confirming a $20.000 purchase). Only fires when it resolves to a different product.
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
      // KYC: verify the phone via Telegram's native request_contact before collecting
      // cédula/nombre/correo, no separate SMS provider. Once per conversation — a
      // returning customer (phoneVerified already true) skips straight to the real prompt.
      if (!context.phoneVerified) {
        return {
          // 2026-08-12 (live-tested via texto.html): this text used to hardcode "de
          // Telegram" — nonsensical on WhatsApp (no such button exists there either) and
          // on AseguraWeb (handleWebMessage auto-verifies via a synthetic contact on
          // every message, same as WhatsApp's WaId — see the header comment there).
          // Channel-neutral wording: Telegram users see a real button (requestContact
          // below still renders it there); WhatsApp/web users just continue and the
          // NEXT message verifies them transparently, no button needed.
          // 2026-08-13 (driven end-to-end on AseguraWeb): leading with "toca el botón"
          // still read as broken on the 2 of 3 channels where no button renders, and the
          // 👇 pointed at nothing. Now the universally-true action comes first.
          text: 'Antes de continuar, confirmemos que eres tú: escríbeme cualquier cosa y lo verifico al instante. Si ves un botón para compartir tu número, también sirve.',
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
      // Live bug: "otro" during an active mixed-species purchase used to search for an
      // unrelated THIRD product priced against the raw cross-species petCount — wrong
      // total, plus a consent mismatch (a following "sí" confirmed the original 2-product
      // purchase, not the product just shown). No single "next best" exists for a combined
      // quote, so just re-anchor on the one already active.
      if (context.selectedProductIds && context.selectedProductIds.length > 1) {
        return { text: this.formatMixedSpeciesQuote(context) };
      }

      const allScores = this.quoting.score(context as AffiliateSignals);
      const seen = context.shownProductIds ?? (context.quoteProductId ? [context.quoteProductId] : []);
      const nextProduct = allScores.find((s) => !seen.includes(s.productId));

      if (nextProduct) {
        const altProduct = this.catalog.getProduct(nextProduct.productId);
        if (altProduct) {
          return {
            text: this.formatQuote(altProduct, nextProduct, context),
            nextState: ConversationState.QUOTE_PRESENTED,
            context: { ...context, quoteProductId: altProduct.id, shownProductIds: [...seen, altProduct.id] },
          };
        }
      }

      // Live bug: this used to reset productCategory and transition to DISCOVERY — a vague
      // next message could then get a HALLUCINATED category (an "asistencia" shopper ended
      // up with "vida"). Staying in QUOTE_PRESENTED keeps resolveProductReference and the
      // cross-sell-defer check working; a genuine new category still switches via a real
      // keyword match.
      //
      // Once every product in a category is shown, offer contact capture instead of a dead
      // end — a real lead. Applies to any category, not just the mascotas-only scope it used to have.
      return {
        text: 'No tenemos más oferta en el momento. Si nos compartes tus datos te voy a avisar cuando la oferta aumente. ¿Te interesa?',
        context: { ...context, awaitingContactConsent: true },
      };
    }

    // Live bug: a plain decline ("No, está bien.") was treated like wantsAlternative,
    // cycling through every remaining product instead of letting the user go. A bare
    // decline now ends the conversation politely.
    if (intent.isNegative && !intent.isAffirmative) {
      // Live bug: the top-level abandonIntent check skips QUOTE_PRESENTED, so a customer
      // with an active paid policy declining a cross-sell still got marked ABANDONED.
      const terminalState = context.hasCompletedPurchase
        ? ConversationState.COMPLETED
        : ConversationState.ABANDONED;
      return {
        text: STATE_RESPONSES[terminalState](context),
        nextState: terminalState,
      };
    }

    // Live bug: "¿Cuál es mejor?"/"cuéntame más" carried no isAffirmative/isNegative/
    // wantsAlternative signal, falling through to the neutral re-show of the same product.
    // Answer with the real product detail instead.
    if (currentProduct && AgentService.MORE_INFO_PATTERN.test(text)) {
      return { text: this.formatProductDetail(currentProduct, context) };
    }

    // Live bug: asking for a category we don't sell silently re-showed the unrelated
    // already-quoted product verbatim, never acknowledging the request. Checked before the
    // neutral-message re-show below.
    const outOfCatalog = this.detectOutOfCatalogCategory(text);
    if (outOfCatalog && !this.mentionsAlreadyCoveredTopic(text, context)) {
      return {
        text: `Por ahora no tengo seguros de ${outOfCatalog}, pero sí tengo vida, accidentes, asistencia médica y mascotas. ¿Te interesa alguno de estos?`,
      };
    }

    // Neutral/unclear message — re-show the actual quoted product instead of the generic
    // placeholder, which has no real name/price. Live bug: "2+2" got re-shown with zero
    // acknowledgment; only prefix a clarification when the raw text has NO letters at all
    // — a real question always has plenty.
    // Live bug: an unclear turn during a mixed-species purchase re-showed just ONE of the
    // two active products priced against the cross-species petCount. Checked first here.
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
      // Counts toward the stuck-loop breaker either way — a plain re-show means none of
      // the branches above understood what was actually being asked.
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

  // "no tengo gatos" (or perros) denies the species the CURRENT quote assumes — checked
  // against whichever species that is, so it only fires when relevant to what's on screen.
  private deniesCurrentPetType(text: string, petType: 'gato' | 'perro' | 'mixto'): boolean {
    if (petType === 'mixto') return false;
    const words = petType === 'gato' ? ['gato', 'gatos', 'gata', 'gatas'] : ['perro', 'perros', 'perra', 'perras'];
    return text.includes('no tengo') && words.some((w) => text.includes(w));
  }

  // Scans for EVERY category keyword present, not just the first (unlike
  // GroqNlpService.fallbackIntent) — needed for "mascotas y vida". "asistencia
  // veterinaria" is stripped first so it doesn't also register as "asistencia médica".
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
  // asistencia). Vehículos and empresas aren't real products (rule #12) — must get an
  // honest "we don't offer that", not a reused quote.
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

  // Live bug: asistencias-multiples covers "Asistencia vehículo" — asking about that
  // coverage got the same "no vendemos vehículos" denial as a real car-policy request.
  // Checked against every product in this purchase; coverage text comes from the real
  // catalog (rule #12), so this can't manufacture a false "yes we cover that."
  private mentionsAlreadyCoveredTopic(text: string, context: ConversationContext): boolean {
    const productIds = context.selectedProductIds?.length ? context.selectedProductIds : (context.quoteProductId ? [context.quoteProductId] : []);
    const coverageText = productIds
      .map((id) => this.catalog.getProduct(id))
      .filter((p): p is InsuranceProduct => !!p)
      .flatMap((p) => p.coverages)
      .join(' ')
      .toLowerCase();
    return Object.keys(AgentService.OUT_OF_CATALOG_KEYWORDS).some((keyword) => text.includes(keyword) && coverageText.includes(keyword));
  }

  // A strict productCategory === 'mascotas' check would skip per-pet data collection
  // whenever mascotas isn't the first selected product. Kept general in case
  // selectedProductIds is populated outside the live agent flow.
  private isPetSelected(context: ConversationContext): boolean {
    if (context.productCategory === 'mascotas') return true;
    if (!context.selectedProductIds?.length) return false;
    return context.selectedProductIds.some((id) => this.catalog.getProduct(id)?.category === 'mascotas');
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

  // A name is letters only (incl. ñ/accents), words separated by spaces/apostrophes/
  // hyphens — never digits. Live bug: "nombre": "2+2" was previously accepted verbatim.
  private static readonly NAME_REGEX = /^[a-zA-ZÀ-ÖØ-öø-ÿ]+(?:['’\-][a-zA-ZÀ-ÖØ-öø-ÿ]+|\s+[a-zA-ZÀ-ÖØ-öø-ÿ]+)*$/;

  // Live bug (production Supabase): nombre literally contained "Mi nombre es Michelle
  // Gómez Gómez" — NAME_REGEX allows it (all letters/spaces), so the lead-in restating
  // the question passed validation verbatim. Strip it before validating.
  private static readonly NAME_PREAMBLE_REGEX = /^(mi nombre completo es|mi nombre es|me llamo|yo soy|soy)\s*/i;

  private stripNamePreamble(text: string): string {
    return text.trim().replace(AgentService.NAME_PREAMBLE_REGEX, '').trim();
  }

  // Live bug: dictating a cédula digit-by-digit by voice transcribes as "1, 2, 3..." — the
  // regex needs a contiguous \d{6,10} run, so it never matched. Only joins when EVERY
  // comma-separated token is a single digit; "12.345.678" (typed) still rejects normally.
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
    // Live bug: narrowing a mixto household to "solo gato" leaves petCount at the OLD
    // combined total. Bypassed above for species-restricted products, but an 'any'
    // product (e.g. asistencia veterinaria) fell through to the stale total. Must respect
    // the same narrowing.
    if (context.petSpeciesCounts && (context.petType === 'gato' || context.petType === 'perro')) {
      return context.petSpeciesCounts[context.petType] ?? context.petCount;
    }
    return context.petCount;
  }

  // Same bug class as petCountForProduct, for name collection instead of pricing:
  // narrowing to "solo perros" left petCount at the stale combined total, so the loop
  // asked for 3 pets' details instead of 2, sweeping the cat in. Sums per-product instead
  // of trusting the raw total.
  private totalPetsForPurchase(context: ConversationContext): number {
    const productIds = context.selectedProductIds?.length
      ? context.selectedProductIds
      : (context.quoteProductId ? [context.quoteProductId] : []);
    // Only the mascotas product(s) need pet details — a cross-sell combo (vida +
    // asistencia-veterinaria) must not count the non-pet product toward the total.
    const products = productIds
      .map((id) => this.catalog.getProduct(id))
      .filter((p): p is InsuranceProduct => !!p && p.category === 'mascotas');
    if (products.length === 0) return context.petCount ?? 1;
    const total = products.reduce((sum, p) => sum + (this.petCountForProduct(context, p) ?? 1), 0);
    return total || 1;
  }

  private isValidHumanName(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.length >= 2 && trimmed.length <= 80 && AgentService.NAME_REGEX.test(trimmed);
  }

  // Voice dictation spells out email symbols as words ("arroba" for @, "punto" for .).
  // Live bug: `\s+arroba\s+` required literal whitespace, but Whisper often inserts a
  // comma right after ("arroba,"), breaking the match — user had to repeat 4 times.
  // `[\s,]*` absorbs the stray comma the same way it absorbs whitespace.
  private normalizeSpokenEmail(text: string): string {
    return text
      .replace(/[\s,]*\barroba\b[\s,]*/gi, '@')
      .replace(/[\s,]*\bpunto\b[\s,]*/gi, '.')
      .replace(/\s+/g, '');
  }

  // True if ANY product in this purchase (single or multi-product) requires conditional
  // underwriting (2026-07-24 business feedback: vida, medicina-prepagada-gatos/perros).
  private requiresUnderwritingInfo(context: ConversationContext): boolean {
    const productIds = context.selectedProductIds?.length
      ? context.selectedProductIds
      : (context.quoteProductId ? [context.quoteProductId] : []);
    return productIds.some((id) => this.catalog.getProduct(id)?.requiresUnderwriting);
  }

  // The generic "edad, enfermedad, historial clínico" question only fits a HUMAN product
  // (vida). A pet product already has the pet's age from the per-pet loop, and there's no
  // "historial clínico" for a pet — only whether it has a preexisting illness.
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
    const totalPets = this.totalPetsForPurchase(context);
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

  // Data capture

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

    // Step -2 — waitlist contact info collection (2026-07-26): when no more products
    // are available for a pet species, the user can share their name/email/phone to be
    // notified about future offers. Each field is collected one at a time; after all
    // three are captured the conversation returns to QUOTE_PRESENTED.
    if (context.awaitingContactName) {
      const cleanedName = this.stripNamePreamble(rawText);
      if (!this.isValidHumanName(cleanedName)) {
        return { text: '¿Cuál es tu nombre completo?', context };
      }
      return {
        text: 'Gracias. ¿Cuál es tu correo electrónico?',
        context: { ...context, contactName: cleanedName, awaitingContactName: undefined, awaitingContactEmail: true },
      };
    }
    if (context.awaitingContactEmail) {
      const normalizedEmail = this.normalizeSpokenEmail(rawText);
      if (!/\S+@\S+\.\S+/.test(normalizedEmail)) {
        const hint = normalizedEmail.includes('@')
          ? ''
          : ' Si lo dictas por voz, recuerda decir "arroba" donde va el @.';
        return { text: `¿Cuál es tu correo electrónico?${hint}`, context };
      }
      return {
        text: 'Perfecto. Por último, ¿cuál es tu número de teléfono?',
        context: { ...context, contactEmail: normalizedEmail, awaitingContactEmail: undefined, awaitingContactPhone: true },
      };
    }
    if (context.awaitingContactPhone) {
      const phone = rawText.replace(/\D/g, '');
      if (phone.length < 7) {
        return { text: '¿Cuál es tu número de teléfono? Debe tener al menos 7 dígitos.', context };
      }
      return this.finalizeLead({ ...context, contactPhone: phone, awaitingContactPhone: undefined });
    }

    // Step -1 — identity verification. Set up by handleQuotation's isAffirmative branch,
    // which shows the contact-share button once. Live bug: this used to re-show "toca el
    // botón" forever for ANY typed reply — a demo-killing infinite loop with no escape.
    // Cosmetic KYC must never block a sale: any non-contact-share reply is treated as
    // declined and moves on immediately.
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
          text: 'Identidad verificada ✅\n\n📸 Por último, envíame una selfie ahora mismo para confirmar tu identidad.',
          context: verifiedContext,
          // '✅' is NOT one of Telegram's allowed reaction emoji (grammy's
          // ReactionTypeEmoji union) — silently failed with REACTION_INVALID in
          // production. '🤝' is allowed and fits "verified/connected".
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
        text: 'Sin problema, seguimos así.\n\n📸 Por último, envíame una selfie ahora mismo para confirmar tu identidad.',
        context: skippedContext,
      };
    }

    // Step -0.5 — cosmetic selfie confirmation. A SIMULATION, not a real identity check —
    // no face matching, no liveness detection, any photo counts as "confirmed". A real
    // deployment would swap this for a third-party provider. Same never-loop-forever fix
    // as phone verification above.
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
      const totalPets = this.totalPetsForPurchase(context);
      const pets = context.pets ?? [];
      if (pets.length < totalPets) {
        const extracted = (intent.pets && intent.pets.length > 0)
          ? intent.pets
          : (intent.petName ? [{ name: intent.petName, age: intent.petAge ?? null, breed: intent.petBreed ?? null }] : []);

        if (extracted.length > 0) {
          const updatedPets = [...pets];
          // Live bug: NLP dropped a pet from a 3-pet message, and the user's next message
          // re-stated an already-collected pet, pushed as a literal duplicate, corrupting
          // the issued policy. Second line of defense: exact name match is never re-pushed.
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

      // Live bug: a 3-pet message came back with a duplicated name and a dropped pet.
      // Correcting by name always matched the FIRST occurrence, silently editing the
      // wrong entry, and "el tercero es..." wasn't understood at all — the corrupted list
      // reached the issued policy. Ordinal reference is checked FIRST and wins outright.
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

    // Step 3 — collect email. Requires a basic shape — accepting any text let an
    // unrelated phrase silently become the "email". Voice dictation says "arroba"/"punto"
    // — normalize before validating, or a clear spoken email never passes.
    if (!context.email) {
      const normalizedEmail = this.normalizeSpokenEmail(rawText);
      if (!/\S+@\S+\.\S+/.test(normalizedEmail)) {
        // Live bug: dictating without ever saying "arroba" ("juan gmail punto com") can't
        // be fixed — normalizeSpokenEmail can't invent a symbol never said. Hint shown
        // only when there's no @ at all, not for a genuine typo.
        const hint = normalizedEmail.includes('@')
          ? ''
          : ' Si lo dictas por voz, recuerda decir *"arroba"* donde va el @ (ej: "juan arroba gmail punto com").';
        return { text: `¿Cuál es tu correo electrónico? Ahí recibirás la póliza.${hint}` };
      }
      newContext.email = normalizedEmail;
      // vida and medicina-prepagada-gatos/perros need underwriting info first;
      // everything else is direct-sell.
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

    // Step 4.5 — payment method choice. "Tarjeta Colsubsidio" and "link de pago" route to
    // the exact SAME Wompi checkout link (a wording/framing choice, not a second rail);
    // createPaymentLinkFlow reads paymentMethodChoice to theme the copy.
    // Live bug: an unrecognized answer used to re-ask forever. Defaults to link de pago
    // instead — a payment-method preference must never strand a ready purchase.
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

    // Step 4 — confirmation ("sí" → create pending policy, ask payment method). No PDF
    // sent here — the only PDF is generated by wompi-webhook.controller.ts once Wompi
    // reports APPROVED.
    if (intent.isAffirmative) {
      // Multi-product purchase — issue one policy per selected product; they'll share a
      // single combined Wompi payment link, created next in createPaymentLinkFlow.
      const productIds = newContext.selectedProductIds?.length
        ? newContext.selectedProductIds
        : (newContext.quoteProductId ? [newContext.quoteProductId] : []);
      const hasResolvableProduct = productIds.some((id) => this.catalog.getProduct(id));

      const policyIds: string[] = [];
      for (const productId of productIds) {
        // Each species-restricted product must be issued against its OWN per-species
        // count — live bug: 2 dogs + 1 cat both stored as petCount 3.
        const product = this.catalog.getProduct(productId);
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
      .map((id) => this.catalog.getProduct(id))
      .filter((p): p is InsuranceProduct => !!p);

    if (products.length === 0) {
      // Real gap: this used to silently fall back to a flat $20.000 COP charge when no
      // product resolved — a customer could be charged for nothing they were quoted.
      // Abort instead and reset to DISCOVERY so the user can restart cleanly.
      this.logger.error(`createPaymentLinkFlow: no resolvable product for conversation ${convId} — aborting payment link creation`);
      return {
        text: 'Tuve un problema retomando tu cotización. Escríbeme de nuevo qué seguro te interesa y lo resolvemos.',
        nextState: ConversationState.DISCOVERY,
        context: { ...context, quoteProductId: undefined, selectedProductIds: undefined, policyId: undefined, policyIds: undefined },
      };
    }

    // Live bug: species-restricted products were both charged against the COMBINED pet
    // count — the real Wompi amount was wrong, not just the on-screen quote.
    const amountCOP = products.reduce((sum, p) => sum + computeTotalPremium(p, this.petCountForProduct(context, p)), 0);
    const productName = products.length > 1
      ? `${products.length} seguros Colsubsidio`
      : (products[0]?.name ?? 'Seguro Colsubsidio');

    // Plan-17 §12 — a session actively using AseguraWeb gets a FRESH token (never reused
    // from the original hablar/escribir link, which may be long expired by checkout time)
    // so Wompi's real redirect_url param brings the browser back to the SAME page instead
    // of stranding it on Wompi's own confirmation screen. Chat-only conversations
    // (webModality unset) get no redirect_url — unchanged behavior.
    const webAppUrl = this.config.get<string>('WEB_APP_URL');
    const redirectUrl = context.webModality && webAppUrl
      ? (() => {
          const token = this.webSessionTokens.sign({ conversationId: convId });
          return token ? `${webAppUrl.replace(/\/$/, '')}/${context.webModality}.html?token=${token}` : undefined;
        })()
      : undefined;

    try {
      const { checkoutUrl, paymentLinkId } = await this.wompi.createPaymentLink({
        policyId: context.policyId ?? convId,
        productName,
        amountCOP,
        expiresInMinutes: AgentService.PAYMENT_LINK_EXPIRY_MINUTES,
        ...(redirectUrl && { redirectUrl }),
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

  // Payment

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

  private formatQuote(
    product: InsuranceProduct,
    score: { reasons: string[]; monthlyPremium: number },
    context?: ConversationContext,
  ): string {
    const cov = product.coverages.slice(0, 3).map((c) => `✅ ${c}`).join('\n');
    const reason = score.reasons[0] ?? 'se ajusta a lo que buscas';
    const isPet = product.category === 'mascotas';
    // Live bug: a mixed household got a re-shown product priced against the RAW
    // cross-species petCount, not its own species' count. Uses the same species-aware
    // helper buildMixedSpeciesQuote relies on, so any call site prices correctly.
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

  // Answers a follow-up meta-question with the FULL coverage list (formatQuote truncates
  // to top-3) instead of the same truncated card re-shown. Names other shown products so
  // the user can switch — no invented data (rule #12).
  private formatProductDetail(product: InsuranceProduct, context: ConversationContext): string {
    const cov = product.coverages.map((c) => `✅ ${c}`).join('\n');
    const scored = this.quoting.score(context as AffiliateSignals).find((s) => s.productId === product.id);
    const reason = scored?.reasons[0] ?? 'se ajusta a lo que buscas';
    const others = (context.shownProductIds ?? [])
      .filter((id) => id !== product.id)
      .map((id) => this.catalog.getProduct(id))
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

  // Answers a COMPLETED customer's question about their OWN policy — never a sales pitch
  // (no "¿te interesa?"). Falls back to the generic COMPLETED text if no recorded id
  // still resolves (rule #12: never fabricate a card for a product that no longer exists).
  private answerPolicyInquiry(context: ConversationContext): ProcessResult {
    const products = (context.purchasedProductIds ?? [])
      .map((id) => this.catalog.getProduct(id))
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

  // Extracted from buildMixedSpeciesQuote so a re-show of an already-active mixed-species
  // purchase reuses the same species-correct summary. Pure text builder, never mutates context.
  private formatMixedSpeciesQuote(context: ConversationContext): string {
    const gatoProduct = this.catalog.getProduct('medicina-prepagada-gatos')!;
    const perroProduct = this.catalog.getProduct('medicina-prepagada-perros')!;
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

  // Live bug: a mixed household was quoted a SINGLE species-restricted product multiplied
  // by the TOTAL pet count, charging the other species at the wrong rate. Quotes BOTH
  // products together, reusing the multi-product purchase machinery downstream.
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
