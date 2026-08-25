// agent.service.ts: the deterministic conversation engine for the text channels. Two layers
// live here and they migrate differently — see docs/plan-router.md.
//
// ROUTING (what to say next, which state follows): being replaced by ToolRouterService. The
// business rules it used to hold alone now live in modules/agent/tools, where both engines
// enforce them — Ley 1581, underwriting, one payment link per policy.
//
// TRANSPORT (photo, contact share, document type, reply keyboards): stays here whatever the
// routing engine is, and is per channel — Telegram and WhatsApp do not offer the same
// primitives. The six awaitingSelfie/awaitingPhoneVerification/awaitingContact* flags belong
// to this layer and never reach the router.

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
// One implementation of the data rules for both channels: voice validates what text validates.
import { isValidName, normalizeName, normalizeSpokenEmail as sharedNormalizeEmail, tipoDocumentoDeclarado, TIPOS_DOCUMENTO_OFRECIDOS, TIPOS_DOCUMENTO_ETIQUETAS } from './tools';
import { pickPersistentFields } from './persistent-context';
import { QuotingService } from '../quoting/quoting.service';
import { AffiliateLookupService } from '../quoting/affiliate-lookup.service';
import { PolicyService } from '../policy/policy.service';
import { WompiService } from '../payments/wompi.service';
import { AffiliateSignals, InsuranceProduct, InsuranceScore, IProductRepository } from '../quoting/types';
import { ProductCatalog } from '../quoting/product-catalog.service';
import { computeTotalPremium } from '../quoting/pricing';
import { matchBreed } from './breed-matcher';

// The AseguraWeb reply shape — the same branches handleMessage dispatches, serialized
// instead of pushed through an IChannelAdapter. `quote` matches cotizar-tool.ts's
// CotizarResult on purpose. Unit price and count are split so the UI never has to guess.
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
  // A mixed-species household is TWO products and `quote` holds one, so the card showed the
  // cat price as the whole premium. One line per product, each priced by its own count.
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
  // Sends `text` via Telegram's native contact-share button instead of a plain message.
  requestContact?: boolean;
  // Reacts to the triggering message with this emoji, e.g. on the selfie photo itself.
  reaction?: string;
  // Upgrades `reaction` to Telegram's "big" variant, used for the contact-share confirmation.
  reactionBig?: boolean;
  // A local video sent as a Telegram animation — heavier than `reaction`, used only where asked.
  animation?: string;
  // A reply keyboard of tappable shortcuts. A tap arrives as an ordinary text message on the
  // same webhook; free text and voice stay fully valid, no button is ever mandatory (rule #10).
  choices?: string[];
  // This turn handed the person to AseguraWeb, so the silence that follows is them talking or
  // typing over there — nudging the chat interrupts the very page it just opened.
  handoffToWeb?: boolean;
  // Set when a reply means "the agent genuinely didn't understand", never for a normal
  // acknowledgment or a polite decline. Consecutive occurrences escalate to a human.
  unclearReply?: boolean;
}

// Static brand assets, resolved from the project root rather than __dirname: nest-cli.json
// doesn't copy non-.ts assets into dist/. Each clip has its text label baked in.
const IDENTITY_ANIMATION_PATH = path.join(process.cwd(), 'src', 'assets', 'identity-confirmed.mp4');
const PAYMENT_ANIMATION_PATH = path.join(process.cwd(), 'src', 'assets', 'payment-received.mp4');

// F01 buttons, offered at AUTHORIZATION→isAffirmative. Only categories the catalog can sell
// (rule #12); free text can still ask about the rest. Exported so the invariant test shares
// this exact array.
export const F01_CHOICES = ['❤️ Mi familia', '🏥 Mi salud', '🐾 Mi mascota', '🤕 Accidentes', '🤔 No estoy seguro'];

// A button tap has zero ambiguity, so it is keyed deterministically: Groq can misclassify a
// short emoji label, and the null-only guardrail never corrects a confident wrong answer.
// "🤔 No estoy seguro" is absent on purpose — nothing is forced.
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
    // Admin escalation and lead notifications are deliberately hardcoded to Telegram — ops
    // watches there regardless of which channel the customer used.
    private readonly telegram: TelegramAdapter,
    private readonly channels: ChannelRegistry,
    private readonly conversations: ConversationService,
    private readonly quoting: QuotingService,
    private readonly policy: PolicyService,
    private readonly wompi: WompiService,
    private readonly reminders: ReminderService,
    private readonly affiliateLookup: AffiliateLookupService,
    private readonly config: ConfigService,
    // A web-session reply needs a fetchable download link; a browser takes no chat attachment.
    private readonly documentCache: DocumentCacheService = new DocumentCacheService(),
    // Mints the texto.html/voz.html links offered at DISCOVERY entry.
    private readonly webSessionTokens: WebSessionTokenService = new WebSessionTokenService(config),
    // Shortens those links so the session token isn't in plain sight in a forwarded message.
    private readonly webLinkCodes: WebLinkCodeService = new WebLinkCodeService(),
    // Default keeps the test helper working; Nest's DI still injects the real singleton.
    @Inject('IProductRepository')
    private readonly catalog: IProductRepository = new ProductCatalog(),
  ) {}

  private static readonly TERMINAL_STATES = new Set([
    ConversationState.COMPLETED,
    ConversationState.ABANDONED,
    ConversationState.REJECTED,
  ]);

  // "¿cuál es mejor?"/"cuéntame más" carry no yes/no signal: a request for more detail on the
  // current product, not a new category for the NLP to classify.
  private static readonly MORE_INFO_PATTERN =
    /\b(cu[eé]ntame\s+m[aá]s|expl[ií]came|de\s+qu[eé]\s+se\s+trata|beneficios|cu[aá]l(?:\s+de\s+todos)?\s+es\s+mejor|mejor\s+para\s+m[ií])\b/i;

  // Only checked in COMPLETED, and never confused with MORE_INFO_PATTERN, which is about a
  // product still being shopped for.
  private static readonly POLICY_INQUIRY_PATTERN =
    /\b(mi p[oó]liza|mi seguro|lo que compr[eé]|lo que ya tengo|qu[eé]\s+cubre|c[oó]mo funciona mi|mi cobertura)\b/i;

  // An explicit reference to an already-shown product ("la primera", "la anterior", "más
  // económica") is resolved deterministically BEFORE isAffirmative, so it always beats a
  // probabilistic LLM guess — otherwise it confirmed the wrong product.
  private static readonly FIRST_OPTION_PATTERN = /\b(la primera(?:\s+opci[oó]n)?|el primero|primera opci[oó]n)\b/i;
  private static readonly PREVIOUS_OPTION_PATTERN = /\b(la anterior|el anterior|la de antes)\b/i;
  private static readonly CHEAPER_OPTION_PATTERN = /\b(m[aá]s econ[oó]mic\w*|m[aá]s barat\w*|m[aá]s accesible\w*|menos costos?)\b/i;

  // "16 mil algo" → 16000. Deliberately approximate — matched against shown products within
  // a tolerance, never required to be exact.
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

    // Cheap regex first, deciding WHICH product is referenced, before calling the scoring
    // engine: a message matching none of these patterns must cost nothing extra.
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
        const current = context.quoteProductId ? this.catalog.getProduct(context.quoteProductId) : undefined;
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


  // `channel` picks which adapter normalizes and replies; the webhook controllers each know
  // which they are. Admin notifications stay on Telegram regardless — ops only watches there.
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

    // A contact share or a photo carries no text at all, so it must skip the empty-text bail.
    if (!msg.text && !msg.contact && !msg.photo) return;

    // Never log the text: cédula, nombre, correo and teléfono all arrive through here.
    this.logger.log(`Message from ${msg.userId} (${msg.text.length} chars)`);

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

  // Shared core between handleMessage (dispatches through an IChannelAdapter) and
  // handleWebMessage (returns JSON). Conversation identity comes only from userId + channel,
  // so a web message carrying the original chat identity lands on that same row.
  // desdeWeb: el mensaje se escribió DENTRO de AseguraWeb, no en el chat. Sin esta distinción
  // cada turno de la página rearmaba el aviso de 60 s, que salía por WhatsApp preguntando
  // "¿sigues ahí?" a alguien que estaba escribiendo en la otra pantalla en ese mismo momento.
  private async computeReply(
    msg: NormalizedMessage,
    opts: { desdeWeb?: boolean } = {},
  ): Promise<{ conv: Conversation; result: ProcessResult }> {
    const conv = await this.conversations.getOrCreate(msg.userId, msg.channel);
    // Any incoming message proves the person is still here: cancel the pending reminder before
    // scheduling a fresh one below.
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

    // Read from the context that will be persisted: on restart pickPersistentFields drops
    // lastMessages, so history deliberately does not survive.
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

    // Arm the "come back to chat" reminder — skipped once the conversation is actually over.
    const finalState = result.nextState ?? conv.state;
    if (!AgentService.TERMINAL_STATES.has(finalState)) {
      // Un link de pago abierto o un traspaso a AseguraWeb significan que la persona salió del
      // chat a propósito: ahí el aviso interrumpe, no rescata.
      const finalContext = result.context ?? conv.context;
      // handoffToWeb solo es cierto en el mensaje que entrega el enlace; desdeWeb cubre todos
      // los turnos siguientes, que es donde el aviso interrumpía de verdad. Queda el cierre
      // largo: quien abandona la página igual tiene que cerrarse en algún momento.
      const enOtraPantalla =
        !!finalContext?.checkoutUrl || result.handoffToWeb === true || opts.desdeWeb === true;
      this.reminders.schedule(conv.id, msg.userId, conv.channel as 'telegram' | 'whatsapp', enOtraPantalla);
    }

    return { conv, result };
  }

  // AseguraWeb entry point. The token carries only a conversationId; channel and userId are
  // resolved fresh from the DB, never trusted from client input.
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
      // The signed token is proof of possession of the original chat identity, so `contact` is
      // attached unconditionally — exactly as the WhatsApp adapter does — and the existing
      // phoneVerified gate is satisfied without special-casing DATA_CAPTURE.
      contact: { phoneNumber: conv.user_id, firstName: '' },
      ...(input.photo && { photo: input.photo }),
    };

    const { result } = await this.computeReply(msg, { desdeWeb: true });
    return this.toWebReply(result, conv);
  }

  private toWebReply(result: ProcessResult, conv: Conversation): WebReply {
    const finalState = result.nextState ?? conv.state;
    const finalContext = result.context ?? conv.context;
    const texts = result.texts?.length ? result.texts : (result.text ? [result.text] : []);

    const reply: WebReply = {
      texts,
      state: finalState,
      progress: progressFor(finalState, finalContext),
      expectedInput: finalContext.awaitingSelfie ? 'selfie' : 'text',
    };

    if (result.choices?.length) {
      reply.choices = result.choices;
    }

    if (finalContext.checkoutUrl) {
      reply.checkoutUrl = finalContext.checkoutUrl;
    }

    // Same shape as cotizar-tool.ts's CotizarResult: the sheet reads structured data, never the
    // markdown `.text` meant for chat.
    if (finalState === ConversationState.QUOTE_PRESENTED && finalContext.quoteProductId) {
      // selectedProductIds holds every product of a multi-product quote; absent for a single one.
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

  // Escalates to a human instead of repeating "no logré entender" forever. Counts only turns
  // explicitly flagged unclear, so an ordinary follow-up question never trips it.
  private static readonly UNCLEAR_REPLY_ESCALATION_THRESHOLD = 3;
  // Deliberately narrow: only what a person says when they are done, never a real request.
  private static readonly CLOSING_PLEASANTRY_PATTERN =
    /^(gracias|muchas gracias|listo|ok|oka?y|perfecto|todo bien|dale)\b/i;

  // Two shapes only, so an ordinary rejection can never look like a complaint: a failure word
  // WITH a technical subject, or a phrase that cannot mean anything else. "no me sirve" alone
  // stays out of here — in QUOTE_PRESENTED it means "show me another one".
  // Two shapes only, so an ordinary rejection can never look like a complaint: a failure word
  // WITH a technical subject, or a phrase that cannot mean anything else. A bare "no me sirve"
  // stays out on purpose — in QUOTE_PRESENTED that means "show me another one".
  private static readonly CHANNEL_COMPLAINT_PATTERNS: RegExp[] = [
    /\b(no|nunca|ni)\b[^.?!]{0,30}\b(audio|micrófono|microfono|sonido|voz|página|pagina|link|enlace|web|sitio|pantalla)\b/i,
    /\b(audio|micrófono|microfono|sonido|voz|página|pagina|link|enlace|web|sitio|pantalla)\b[^.?!]{0,30}\b(no|falla|error)\b/i,
    /\bno (funciona|carga|abre|responde|me deja entrar)\b/i,
    /\bse queda cargando\b/i,
    /\bno se (escucha|oye|ve)\b/i,
  ];

  private static isChannelComplaint(text: string): boolean {
    return AgentService.CHANNEL_COMPLAINT_PATTERNS.some((re) => re.test(text));
  }

  private static readonly CHANNEL_COMPLAINT_TEXT =
    'Perdón por eso 🙏 Sigamos aquí en el chat, que sí funciona — escríbeme o mándame un audio, como prefieras. Si quieres reintentar con la página, dime y te mando otro enlace.';

  // The line above promises "dime y te mando otro enlace" and for a long time nothing honored
  // it: "genera otro enlace" fell through as an unclear reply, and the third one tripped the
  // circuit breaker and escalated the person to a human — the opposite of a self-service flow.
  // Two shapes only, both requiring an explicit ask, so a complaint about the page ("el enlace
  // no funciona") stays a complaint and is answered by the branch below.
  private static readonly WEB_LINK_REQUEST_PATTERNS: RegExp[] = [
    /\b(otro|otra|nuevo|nueva|de nuevo|otra vez|reenv[íi]a\w*|m[áa]nda\w*|env[íi]a\w*|gener\w*|dame|p[áa]sa\w*|comparte)\b[^.?!]{0,25}\b(enlace|link|p[áa]gina|pagina)\b/i,
    /\b(enlace|link|p[áa]gina|pagina)\b[^.?!]{0,25}\b(para (hablar|escribir)|de voz|otra vez|de nuevo|nuevo)\b/i,
  ];

  // A payment link is a different object with a different flow, and "mándame el link de pago"
  // matches the first shape word for word. Carved out here as well as by state at the call site.
  private static readonly PAYMENT_LINK_WORDS = /\b(pago|pagar|pagos|checkout|wompi|tarjeta)\b/i;

  private static isWebLinkRequest(text: string): boolean {
    if (AgentService.PAYMENT_LINK_WORDS.test(text)) return false;
    return AgentService.WEB_LINK_REQUEST_PATTERNS.some((re) => re.test(text));
  }

  private static readonly FAREWELL_AFTER_PURCHASE =
    'Listo, cierro por aquí 😊 No tienes que hacer nada más. Cuando quieras — una duda de coberturas, comparar otro plan, o proteger algo nuevo — escríbeme.';

  private static readonly COMPLETED_UNCLEAR_TEXT =
    'No estoy seguro de qué necesitas 🤔 Puedo contarte qué cubre tu seguro, compararte otro plan, o proteger algo nuevo. ¿Cuál te sirve?';

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
      // An understood reply resets the streak — only worth a write when there was one to clear.
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

  // Never blocks the real conversation if it fails or ADMIN_CHAT_ID is unset. A Telegram chat
  // id is just a numeric userId to that adapter, so no separate integration is needed.
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

  // A lead captured when every product in a category ran out. Degrades silently with no
  // ADMIN_CHAT_ID, and reuses telegram.sendText — this app has no leads store.
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

  // Pre-fills from whatever is already known and asks only for what is missing — "nunca
  // preguntar lo que ya sabemos".
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

  // Shared by the "everything already known" fast path and the "just asked for the phone" one.
  private finalizeLead(context: ConversationContext): ProcessResult {
    const terminalState = context.hasCompletedPurchase
      ? ConversationState.COMPLETED
      : ConversationState.ABANDONED;
    // Fire-and-forget: never blocks the real response if it fails or ADMIN_CHAT_ID is unset.
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
      // "Abandoned before buying" and "bought, then declined more" must never share a status.
      const terminalState = context.hasCompletedPurchase
        ? ConversationState.COMPLETED
        : ConversationState.ABANDONED;
      return {
        // Someone who says "terminar" is leaving, not asking whether their policy is active.
        text: context.hasCompletedPurchase
          ? AgentService.FAREWELL_AFTER_PURCHASE
          : STATE_RESPONSES[terminalState](context),
        nextState: terminalState,
      };
    }

    // Someone reporting that the page or the mic is broken is not answering a discovery
    // question. Without this the message reached the quote gate and a complaint was sold to.
    // Excluded past DATA_CAPTURE: there "no me carga" is about the payment link, which the
    // payment flow answers itself.
    // Checked before the complaint branch because it is the narrower of the two: it needs an
    // explicit ask, while a complaint only needs a failure word near a technical noun.
    if (
      currentState !== ConversationState.DATA_CAPTURE &&
      currentState !== ConversationState.PAYMENT &&
      AgentService.isWebLinkRequest(text)
    ) {
      const resent = this.resendWebLink(convId, context, text);
      // Null only when WEB_APP_URL is unset. Falling through beats promising a link that 404s.
      if (resent) return resent;
    }

    if (
      currentState !== ConversationState.DATA_CAPTURE &&
      currentState !== ConversationState.PAYMENT &&
      AgentService.isChannelComplaint(text)
    ) {
      return { text: AgentService.CHANNEL_COMPLAINT_TEXT };
    }

    switch (currentState) {
      case ConversationState.GREETING:
        // GREETING's text already folds in the authorization ask, so sending this too repeats it.
        return {
          text: STATE_RESPONSES[ConversationState.GREETING](context),
          nextState: ConversationState.AUTHORIZATION,
        };

      case ConversationState.AUTHORIZATION:
        // One-shot question asked right after "sí". Handled first so the reply is never
        // re-interpreted as a fresh answer to the Ley 1581 consent question below.
        if (context.awaitingAffiliateId) {
          return this.handleAffiliateId(context, text, rawText);
        }

        if (intent.isAffirmative) {
          // A returning affiliate whose serieId survived in persistent memory must not be asked again.
          if (context.serieId) {
            const knownContext: ConversationContext = { ...context, autorizado: true, discoveryFilter: true };
            return this.offerDiscoveryEntry(
              'Ya te habías afiliado a Colsubsidio, así que ya tengo tu perfil.\n\n',
              knownContext,
            );
          }
          return {
            // The "puedes responder por texto o audio" reassurance lives in GREETING now.
            text: 'Ingresa tu ID si eres afiliado a Colsubsidio — así puedo ajustar mejor tu cotización. Si no lo eres, escríbeme *"no"*.',
            // discoveryFilter gates the `dependents` question, and is set only on a fresh authorization
            // — a post-purchase cross-sell keeps quoting a returning buyer with no re-interrogation.
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
        // The auto-close promises "aquí estoy — 24/7", so any follow-up restarts the conversation,
        // not just an exact hola/ayuda. COMPLETED is excluded: it holds real KYC data.
        if (currentState === ConversationState.ABANDONED || currentState === ConversationState.REJECTED) {
          // Carries durable profile facts forward instead of wiping to {}. nextState AUTHORIZATION,
          // not GREETING, or the identical text renders again on the user's next message.
          const remembered = pickPersistentFields(context);
          return {
            text: STATE_RESPONSES[ConversationState.GREETING](remembered),
            nextState: ConversationState.AUTHORIZATION,
            context: remembered,
          };
        }
        // Checked before the hola/ayuda restart: "necesito ayuda con mi póliza" is about an
        // existing purchase. Gated on purchasedProductIds, since policyIds are already cleared.
        if (currentState === ConversationState.COMPLETED && AgentService.POLICY_INQUIRY_PATTERN.test(text)) {
          return this.answerPolicyInquiry(context);
        }
        if (text.includes('hola') || text.includes('ayuda') || text.includes('inicio') || text === '/start') {
          // Same fix as the restart above: nextState AUTHORIZATION, so the greeting is shown once.
          return {
            text: STATE_RESPONSES[ConversationState.GREETING](context),
            nextState: ConversationState.AUTHORIZATION,
          };
        }
        // COMPLETED used to answer anything it did not recognise with the purchase
        // confirmation, so a stray "1" got "tu seguro está activo". Flagging it unclear also
        // lets the circuit breaker escalate instead of repeating forever.
        if (currentState === ConversationState.COMPLETED) {
          // Thanks is a goodbye, not a request — answering it with a question reads as nagging.
          if (AgentService.CLOSING_PLEASANTRY_PATTERN.test(text)) {
            return { text: AgentService.FAREWELL_AFTER_PURCHASE };
          }
          return { text: AgentService.COMPLETED_UNCLEAR_TEXT, unclearReply: true };
        }
        return {
          text: STATE_RESPONSES[currentState]?.(context) ?? STATE_RESPONSES[ConversationState.COMPLETED](context),
        };
    }
  }

  // Affiliate ID lookup — the one income signal Colsubsidio can supply if the person
  // self-identifies. A decline, an unknown ID, or a disabled lookup all proceed to DISCOVERY
  // identically. SERIE is a plain row number (1..500000), so there is no length check.
  private static readonly MAX_SERIE = 500_000;

  private handleAffiliateId(context: ConversationContext, text: string, rawText: string): ProcessResult {
    const baseContext: ConversationContext = { ...context, awaitingAffiliateId: undefined };
    const declines = /^no\b/i.test(text.trim()) || !rawText.trim();

    if (!declines) {
      // Same digit extraction as cédula, so an ID dictated one digit at a time by voice works.
      const serie = this.joinSpokenDigits(rawText).replace(/\D/g, '');

      // Only digits or "no" pass: a non-numeric answer ("Juan") used to be treated as an implicit
      // decline. Range 1–MAX_SERIE, not a digit count — SERIE is a sequential row number. Returns
      // neither context nor nextState, so the conversation stays put and re-fires this gate.
      const serieNum = serie ? Number(serie) : NaN;
      if (!serie || !Number.isFinite(serieNum) || serieNum < 1 || serieNum > AgentService.MAX_SERIE) {
        return {
          text: `Tu ID de afiliado debe ser un número entre 1 y ${AgentService.MAX_SERIE.toLocaleString('es-CO')}. Si no eres afiliado, escríbeme "no".`,
        };
      }

      if (this.affiliateLookup.isEnabled()) {
        const record = this.affiliateLookup.findBySerie(serie);
        // Any match enriches now, and affiliateProfile carries the FULL row forward, unread fields included.
        if (record) {
          const enriched: ConversationContext = {
            ...baseContext,
            serieId: serie,
            cedula: serie,
            // Sin documentType a propósito: una serie de afiliado no dice de qué documento es,
            // y ponerle 'CC' aquí era la misma suposición que DATA_CAPTURE ahora pregunta.
            affiliateProfile: record,
            ...(record.segmentoGrupoFamiliar !== undefined ? { segmentoGrupoFamiliar: record.segmentoGrupoFamiliar } : {}),
            ...(record.rangoSalarial !== undefined ? { rangoSalarial: record.rangoSalarial } : {}),
            // Pre-fills dependents only for the confidently-known-zero case; family-segment minimums
            // stay a fallback so a real answer still wins.
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

  // Sends F01's category buttons — or, when WEB_APP_URL is configured, asks "¿hablar o
  // escribir?" first. The long signed URL is swapped for a short single-use one on the
  // BACKEND's host (it serves /s/:code); with PUBLIC_URL unset the long link goes out instead,
  // since a visible token beats a link that 404s.
  private shortLink(destination: string): string {
    const publicUrl = this.config.get<string>('PUBLIC_URL');
    if (!publicUrl) return destination;
    return `${publicUrl.replace(/\/$/, '')}/s/${this.webLinkCodes.mint(destination)}`;
  }

  // The one place an AseguraWeb link is built, so the modality-choice reply and a later
  // "mándame otro enlace" can never drift apart. Null means WEB_APP_URL is unset — the only
  // reason a caller has nothing to offer.
  private mintWebLink(convId: string, modality: 'voz' | 'texto'): string | null {
    const webAppUrl = this.config.get<string>('WEB_APP_URL');
    if (!webAppUrl) return null;
    const token = this.webSessionTokens.sign({ conversationId: convId });
    if (!token) return null;
    return this.shortLink(`${webAppUrl.replace(/\/$/, '')}/${modality}.html?token=${token}`);
  }

  // Honors what CHANNEL_COMPLAINT_TEXT promises. A fresh token every time on purpose: the usual
  // reason for asking again is that the previous one expired. Deliberately returns no nextState —
  // someone deep in the flow asking for the link must not be sent back to DISCOVERY.
  private resendWebLink(convId: string, context: ConversationContext, text: string): ProcessResult | null {
    const wantsVoice = /\b(hablar|voz|audio|llamar)\b/i.test(text);
    const wantsText = /\b(escribir|texto|escrib|chat)\b/i.test(text);
    // Neither named: repeat whatever they chose before, and default to writing.
    const modality: 'voz' | 'texto' = wantsVoice && !wantsText ? 'voz' : wantsText ? 'texto' : (context.webModality ?? 'texto');
    const link = this.mintWebLink(convId, modality);
    if (!link) return null;

    const verb = modality === 'voz' ? 'hablar' : 'escribir';
    return {
      text: `Claro, aquí tienes uno nuevo para ${verb}: ${link}\n\n` +
        'Si prefieres, seguimos aquí en el chat — como te quede mejor.',
      context: { ...context, webModality: modality },
      handoffToWeb: true,
    };
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

  // Resolves the "¿hablar o escribir?" reply. Returns null when the reply says neither, so
  // the caller clears the flag and lets the SAME message fall through to normal DISCOVERY.
  private resolveWebModalityChoice(convId: string, context: ConversationContext, text: string): ProcessResult | null {
    const lower = text.toLowerCase();
    // The question names both options, so people answer naming both ("escribir, no hablar").
    // Voice used to win on a bare mention, recording the choice INVERTED — and it only surfaced
    // after payment, since webModality builds Wompi's redirect_url. Negated mentions are dropped
    // and whichever option is named FIRST wins.
    const stripped = lower.replace(
      /\bno\s+(?:quiero\s+|me\s+gusta\s+|puedo\s+)?(?:hablar|voz|audio|llamar|escribir|texto|chat)\b/g,
      ' ',
    );
    const voiceAt = stripped.search(/\b(hablar|voz|audio|llamar)\b/);
    const textAt = stripped.search(/\b(escribir|texto|escrib|chat)\b/);
    if (voiceAt < 0 && textAt < 0) return null;
    const wantsVoice = voiceAt >= 0 && (textAt < 0 || voiceAt < textAt);

    const modality: 'voz' | 'texto' = wantsVoice ? 'voz' : 'texto';
    const link = this.mintWebLink(convId, modality);
    // Shouldn't happen (the gate is only set when WEB_APP_URL exists), but never crash on it.
    if (!link) return null;

    const verb = wantsVoice ? 'hablar' : 'escribir';
    return {
      text: `Perfecto, puedes ${verb} aquí: ${link}\n\n` +
        'Cuando termines, vuelve al chat — o sigue escribiéndome aquí si prefieres.',
      // webModality persists: createPaymentLinkFlow reads it later to set Wompi's redirect_url, so
      // checkout returns the browser to the same AseguraWeb page.
      context: { ...context, awaitingWebModalityChoice: undefined, webModality: modality },
      handoffToWeb: true,
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

    // A decline of the post-purchase cross-sell used to fall through to the generic "no entendí".
    // Only fires on a genuine decline with no new category in the same breath ("no, quiero vida"
    // still quotes vida), and always clears the flag so it can't hijack a later "no".
    if (context.awaitingCrossSellResponse) {
      // A message starting with a standalone "no" is an unambiguous decline whatever the LLM said.
      const clearlyDeclines = intent.isNegative || /^no\b/i.test(text.trim());
      // Requires real textual evidence of a category: trusting intent.productCategory let Groq
      // hallucinate one from a decline naming no product, re-quoting the stale item — someone who
      // said their policy was WRONG got a second payment link for it.
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

    // "No dependents" is a valid answer, not unclear input. Scoped to fresh DISCOVERY only, so
    // it never hijacks a later "no".
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

    // Symmetric to the negative pivot below, and scoped the same way: a bare "sí" names no
    // category and used to repeat the whole compound question verbatim.
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

    // A button tap must never be silently misclassified, and is checked before the normal
    // fill-in-if-empty assignment so a deliberate tap always wins.
    const f01Category = F01_CATEGORY_MAP[text];
    if (f01Category) {
      newContext.productCategory = f01Category;
    } else if (!context.productCategory && intent.productCategory) {
      newContext.productCategory = intent.productCategory;
    }
    // Handle clarification response when we already know it's a mixed-pet household
    if (context.petType === 'mixto') {
      // Must run before the resolution check below, so a quantity answer is captured first.
      const curCounts = this.extractSpeciesCounts(text);
      if (curCounts.gato > 0 || curCounts.perro > 0) {
        newContext.petSpeciesCounts = {
          gato: curCounts.gato || (context.petSpeciesCounts?.gato ?? 0),
          perro: curCounts.perro || (context.petSpeciesCounts?.perro ?? 0),
        };
      }

      // Naming a species while stating its count is not the same as choosing only that species,
      // so once BOTH counts are known any single-species petResolution is spurious and cleared —
      // otherwise the household silently lost one species. Deliberate narrowing is a later step.
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
        // With both counts known, ask individual vs. combined — the answer is handled by the
        // petResolution branches above on the next turn.
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
        // Coverage already set means the pet was resolved earlier; re-setting petType to 'mixto'
        // would restart the clarification loop after a restart lost context.petType.
        if (intent.petType === 'mixto' && newContext.coverage?.length) {
          // skip — treat as already-resolved; let hasEnoughInfo + bestQuote handle it
        } else {
          newContext.petType = intent.petType;
        }
      }
      // Capture the per-species breakdown before the message naming both species is gone, or a
      // single product gets multiplied by the TOTAL count and dogs are charged at the cat rate.
      if (newContext.petType === 'mixto') {
        const counts = this.extractSpeciesCounts(text);
        if (counts.gato > 0 || counts.perro > 0) newContext.petSpeciesCounts = counts;
      }
    }

    if (!context.coverage && intent.coverage?.length) newContext.coverage = intent.coverage;
    if (!context.beneficiaries && intent.beneficiaries > 0) newContext.beneficiaries = intent.beneficiaries;
    if (!context.budget && intent.budget) newContext.budget = intent.budget;
    if (!context.petCount && intent.petCount && intent.petCount > 0) newContext.petCount = intent.petCount;
    // "immediate" always wins over a stale "exploring" from an earlier turn.
    if (intent.urgency === 'immediate') newContext.urgency = 'immediate';
    else if (!newContext.urgency && intent.urgency) newContext.urgency = intent.urgency;
    // `=== undefined`, not falsy, so a real answer of 0 ("vivo solo") is captured.
    if (newContext.dependents === undefined && intent.dependents !== null && intent.dependents !== undefined) {
      newContext.dependents = intent.dependents;
      // Wakes the "Cubre a N personas" reason too. `<= 1`, not falsy: Groq defaults beneficiaries
      // to 1 with no real signal, and that must not block dependents.
      if (intent.dependents > 0 && (!newContext.beneficiaries || newContext.beneficiaries <= 1)) {
        newContext.beneficiaries = intent.dependents + 1;
      }
    }

    // CSV fallback for when the dependents question was asked but got no parseable answer.
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

    // Catalog honesty: "quiero asegurar mi carro" had no branch here and looped on the generic
    // question forever. Guarded on productCategory being unresolved, so it can't hijack a
    // message once vida/mascotas already matched.
    if (!newContext.productCategory) {
      const outOfCatalog = this.detectOutOfCatalogCategory(text);
      if (outOfCatalog) {
        return {
          text: `Por ahora no tengo seguros de ${outOfCatalog}, pero sí tengo vida, accidentes, asistencia médica y mascotas. ¿Te interesa alguno de estos?`,
          context: newContext,
        };
      }
    }

    // Counts are asked before quoting so "para todos" can price both species correctly.
    if (newContext.petType === 'mixto') {
      // The breakdown often arrives in the very message that reveals the mixed household, and the
      // block above already saved it — ask only for what is actually missing.
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

    // The catalog has cat-only and dog-only products, so quoting before the species is known
    // risks missing the better match. Also gated on !coverage?.length: "para todos" resolves
    // petType to null and always sets coverage, so this must not re-ask then.
    if (newContext.productCategory === 'mascotas' && !newContext.petType && !newContext.coverage?.length) {
      return {
        text: '¿Tus mascotas son gatos, perros, o tienes de ambos? Así te muestro la cobertura correcta.',
        context: newContext,
      };
    }

    // Asked ONCE, only in the discoveryFilter flow, and only where it could change the
    // recommendation (mascotas excluded). askedDependents is set in this same return, so the
    // next turn proceeds whether or not the answer parsed.
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

    // coverage is NOT required to score: requiring it stranded every quote in a loop whenever
    // fallbackIntent() ran, since that path never fills coverage.
    const hasEnoughInfo = !!newContext.productCategory;

    // Dead-end guard: DISCOVERY's third tier is permanently unanswerable (no NLP field captures
    // it; Step 3's `dependents` replaced it), so without this every reply loops back to it.
    // Coverage alone is enough to attempt a real quote — requiring beneficiaries too was stale.
    const stuckWithoutCategory = !hasEnoughInfo && !!newContext.coverage?.length;

    if (hasEnoughInfo || stuckWithoutCategory) {
      const quote = this.quoting.bestQuote(newContext as AffiliateSignals);
      if (quote) {
        newContext.quoteProductId = quote.product.id;
        // Append to, never replace, shownProductIds — a product shown before a cross-sell reset
        // must stay in history for a later "los dos".
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
    // `beneficiaries` is excluded: Groq defaults it to 1 with no real signal.
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
      // Only the genuinely-stuck branch counts toward escalation: madeProgress means real signal
      // was extracted, just not enough to quote yet.
      unclearReply: !madeProgress,
    };
  }

  // Quotation

  private handleQuotation(context: ConversationContext, text: string, intent: InsuranceIntent): ProcessResult {
    // The waitlist flag is answered here, not in AUTHORIZATION: the conversation stays anchored
    // in QUOTE_PRESENTED, so checking it there was unreachable dead code.
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

    const currentProduct = context.quoteProductId ? this.catalog.getProduct(context.quoteProductId) : undefined;

    // No branch here checked abandonIntent, and processMessage's top-level check deliberately
    // excludes QUOTE_PRESENTED — so "salir" just re-showed the card.
    if (intent.abandonIntent) {
      const terminalState = context.hasCompletedPurchase
        ? ConversationState.COMPLETED
        : ConversationState.ABANDONED;
      return {
        text: STATE_RESPONSES[terminalState](context),
        nextState: terminalState,
      };
    }

    // An explicit "no tengo <species just quoted>" is unambiguous regardless of what the LLM
    // extracted, and resets petType/coverage/quote for a clean re-ask.
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

    // Switching species (or back to both) is gated on petSpeciesCounts knowing both, not on
    // selectedProductIds.length: once narrowed to one species, there was no way back.
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

    // A quote in progress is never interrupted by a different category: it is deferred until
    // this purchase is paid. Naming another category used to silently abandon an unconfirmed
    // purchase — close one deal at a time.
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

    // An explicit reference to a shown product is resolved before isAffirmative, or a customer
    // naming $16.800 ends up confirming the $20.000 product on screen.
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
      // KYC: the phone is verified through Telegram's request_contact before cédula/nombre/correo,
      // with no SMS provider. Once per conversation — a returning customer skips straight ahead.
      if (!context.phoneVerified) {
        return {
          // Channel-neutral wording: only Telegram renders a real button, and WhatsApp/web verify
          // transparently on the next message — so the universally-true action comes first.
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
      // No single "next best" exists for a combined quote: "otro" used to price an unrelated third
      // product against the raw cross-species petCount, and a following "sí" then confirmed the
      // original purchase rather than what was shown. Re-anchor on the active quote instead.
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

      // Staying in QUOTE_PRESENTED (rather than resetting to DISCOVERY) keeps
      // resolveProductReference and the cross-sell defer working, and stops a vague next message
      // from being given a hallucinated category. Once every product in a category is shown,
      // contact capture is offered instead of a dead end.
      return {
        text: 'No tenemos más oferta en el momento. Si nos compartes tus datos te voy a avisar cuando la oferta aumente. ¿Te interesa?',
        context: { ...context, awaitingContactConsent: true },
      };
    }

    // A bare decline ("No, está bien.") is not wantsAlternative: it used to cycle through every
    // remaining product instead of letting the person go.
    if (intent.isNegative && !intent.isAffirmative) {
      // The top-level abandonIntent check skips QUOTE_PRESENTED, so a customer with a paid policy
      // declining a cross-sell was still marked ABANDONED.
      const terminalState = context.hasCompletedPurchase
        ? ConversationState.COMPLETED
        : ConversationState.ABANDONED;
      return {
        text: STATE_RESPONSES[terminalState](context),
        nextState: terminalState,
      };
    }

    // "¿Cuál es mejor?" carries no yes/no/alternative signal — answer with real detail instead
    // of falling through to a neutral re-show.
    if (currentProduct && AgentService.MORE_INFO_PATTERN.test(text)) {
      return { text: this.formatProductDetail(currentProduct, context) };
    }

    // Asking for a category we don't sell used to silently re-show the unrelated quote.
    const outOfCatalog = this.detectOutOfCatalogCategory(text);
    if (outOfCatalog && !this.mentionsAlreadyCoveredTopic(text, context)) {
      return {
        text: `Por ahora no tengo seguros de ${outOfCatalog}, pero sí tengo vida, accidentes, asistencia médica y mascotas. ¿Te interesa alguno de estos?`,
      };
    }

    // Re-show the actual quoted product, not the generic placeholder. A clarification prefix
    // is added only when the raw text has NO letters at all — a real question always has plenty.
    // Mixed-species purchases are checked first, or only one of the two products re-showed.
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
      // Counts toward the stuck-loop breaker: a plain re-show means nothing above understood.
      return {
        text: noRealWords ? `No entendí ese mensaje, ¿puedes intentarlo de nuevo?\n\n${quoteText}` : quoteText,
        unclearReply: true,
      };
    }

    return { text: STATE_RESPONSES[ConversationState.QUOTE_PRESENTED](context), unclearReply: true };
  }

  private mentionsPersonalCoverage(text: string): boolean {
    // "también" alone is too generic — it can just mean "I also have a dog" mid-conversation.
    const personalPhrases = ['para mí', 'para mi', 'y yo'];
    const humanCategories = ['vida', 'accidentes', 'accidente', 'salud', 'hogar'];
    return personalPhrases.some((p) => text.includes(p)) || humanCategories.some((c) => text.includes(c));
  }

  // Denies the species the CURRENT quote assumes, so it only fires when relevant.
  private deniesCurrentPetType(text: string, petType: 'gato' | 'perro' | 'mixto'): boolean {
    if (petType === 'mixto') return false;
    const words = petType === 'gato' ? ['gato', 'gatos', 'gata', 'gatas'] : ['perro', 'perros', 'perra', 'perras'];
    return text.includes('no tengo') && words.some((w) => text.includes(w));
  }

  // Scans for EVERY category keyword present, not just the first, for "mascotas y vida".
  // "asistencia veterinaria" is stripped first so it doesn't also register as asistencia.
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

  // The real catalog covers vida, accidentes, asistencia and mascotas. Vehículos and empresas
  // are not products (rule #12) and must get an honest "we don't offer that".
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

  // asistencias-multiples covers "Asistencia vehículo", so asking about that coverage used to
  // get the same "no vendemos vehículos" denial as a real car policy. Coverage text comes from
  // the real catalog (rule #12), so this can't manufacture a false yes.
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

  // A strict productCategory check would skip per-pet collection whenever mascotas isn't the
  // first selected product.
  private isPetSelected(context: ConversationContext): boolean {
    if (context.productCategory === 'mascotas') return true;
    if (!context.selectedProductIds?.length) return false;
    return context.selectedProductIds.some((id) => this.catalog.getProduct(id)?.category === 'mascotas');
  }

  // Acknowledges interest in another category without abandoning the quote on screen; it is
  // followed up only once this purchase is paid.
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

  // Backchannel words a voice transcription produces in reply to the agent's own message —
  // never a real person's full name.
  private static readonly FILLER_WORDS = ['gracias', 'ok', 'okay', 'vale', 'listo', 'dale', 'bueno', 'ya'];

  private stripNamePreamble(text: string): string {
    return normalizeName(text);
  }

  // A cédula dictated digit-by-digit transcribes as "1, 2, 3...", which no contiguous \d{6,10}
  // run matches. Only joins when EVERY token is a single digit, so typed "12.345.678" still fails.
  private joinSpokenDigits(text: string): string {
    const tokens = text.split(',').map((t) => t.trim());
    if (tokens.length >= 6 && tokens.every((t) => /^\d$/.test(t))) {
      return tokens.join('');
    }
    return text;
  }

  // The catalog has separate species-restricted products at different prices, so a mixed
  // household needs its OWN per-species counts — a combined total quoted one cat-only product
  // and charged the dogs at the cat rate.
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

  // The right per-pet count for THIS product's price: a species-restricted product uses its own
  // species' count from the breakdown, never the combined total.
  private petCountForProduct(context: ConversationContext, product: InsuranceProduct): number | null | undefined {
    if (context.petSpeciesCounts && product.eligibility.pet === 'gato') return context.petSpeciesCounts.gato ?? context.petCount;
    if (context.petSpeciesCounts && product.eligibility.pet === 'perro') return context.petSpeciesCounts.perro ?? context.petCount;
    // An 'any' product (asistencia veterinaria) must respect the same narrowing: it fell through
    // to the stale combined total.
    if (context.petSpeciesCounts && (context.petType === 'gato' || context.petType === 'perro')) {
      return context.petSpeciesCounts[context.petType] ?? context.petCount;
    }
    return context.petCount;
  }

  // Same bug class as petCountForProduct, for name collection instead of pricing: narrowing to
  // "solo perros" left a stale combined total, so the loop asked for the cat's details too.
  private totalPetsForPurchase(context: ConversationContext): number {
    const productIds = context.selectedProductIds?.length
      ? context.selectedProductIds
      : (context.quoteProductId ? [context.quoteProductId] : []);
    // Only the mascotas products need pet details: a vida + veterinaria combo must not count
    // the non-pet product toward the total.
    const products = productIds
      .map((id) => this.catalog.getProduct(id))
      .filter((p): p is InsuranceProduct => !!p && p.category === 'mascotas');
    if (products.length === 0) return context.petCount ?? 1;
    const total = products.reduce((sum, p) => sum + (this.petCountForProduct(context, p) ?? 1), 0);
    return total || 1;
  }

  private isValidHumanName(text: string): boolean {
    return isValidName(text);
  }

  // Voice dictation spells out email symbols ("arroba", "punto"), and Whisper often inserts a
  // comma right after — `[\s,]*` absorbs it, which a literal `\s+` did not.
  private normalizeSpokenEmail(text: string): string {
    return sharedNormalizeEmail(text);
  }

  // True when ANY product in this purchase requires conditional underwriting.
  private requiresUnderwritingInfo(context: ConversationContext): boolean {
    const productIds = context.selectedProductIds?.length
      ? context.selectedProductIds
      : (context.quoteProductId ? [context.quoteProductId] : []);
    return productIds.some((id) => this.catalog.getProduct(id)?.requiresUnderwriting);
  }

  // The generic "edad, enfermedad, historial clínico" question only fits a HUMAN product. A pet
  // already gave its age in the per-pet loop, and pets have no clinical history.
  private buildUnderwritingQuestion(context: ConversationContext): string {
    if (this.isPetSelected(context) && context.pets?.length) {
      const names = formatNameList(context.pets.map((p) => p.name));
      const plural = context.pets.length > 1;
      return `Para emitir la póliza de ${names} necesito saber si ${plural ? 'tienen' : 'tiene'} alguna enfermedad preexistente (o escribe "ninguna" si no aplica).`;
    }
    return 'Para este seguro necesito un par de datos adicionales: tu edad, si tienes alguna enfermedad preexistente, y un breve historial clínico (o escribe "ninguna" si no aplica).';
  }

  // Single source for the payment link's expiry — it was two separate literal 30s, one in the
  // API call and one in the message text, free to drift apart.
  private static readonly PAYMENT_LINK_EXPIRY_MINUTES = 30;

  // Below this, a "photo" is more likely an icon or sticker than a camera photo. Not face
  // detection, just a sanity floor.
  private static readonly MIN_SELFIE_DIMENSION = 80;

  private isFillerWord(text: string): boolean {
    const normalized = text.trim().toLowerCase().replace(/[.,!¡¿?]/g, '');
    return AgentService.FILLER_WORDS.includes(normalized);
  }

  // The real first DATA_CAPTURE question once identity is verified: per-pet details for a
  // mascotas purchase, otherwise cédula.
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

  // Lets a correction reference a pet by position ("el tercero"), which is unambiguous even
  // when two pets share a name.
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

  // Not everyone has a CC: CE, TI and NIP/NUIP identify real people too. Defaults to CC when
  // no type is named, which matches prior behavior for a plain number.
  // Delegado a la capa de tools a propósito. Había una copia aquí que se había quedado atrás:
  // no conocía PEP —el documento de buena parte de la población migrante— y caía a 'CC' en
  // silencio, aunque el comentario del otro archivo afirmara que ambos eran espejo. Un tipo de
  // documento equivocado se imprime en la póliza.
  private detectDocumentType(text: string): DocumentType | null {
    return tipoDocumentoDeclarado(text);
  }

  private static readonly PREGUNTA_TIPO_DOCUMENTO =
    `¿Y ese número de qué documento es: ${TIPOS_DOCUMENTO_OFRECIDOS.map((t) => TIPOS_DOCUMENTO_ETIQUETAS[t]).join(', ')}?`;

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

    // Respuesta a "¿de qué documento es ese número?". Se pregunta una vez y una sola: si la
    // respuesta no nombra ninguno, se sigue con CC —el mayoritario— en vez de volver a
    // preguntar, porque trabar la venta en un bucle es peor que el caso que ya teníamos.
    if (context.awaitingDocumentType) {
      newContext.awaitingDocumentType = undefined;
      newContext.documentType = this.detectDocumentType(text) ?? 'CC';
      return {
        text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](newContext),
        context: newContext,
      };
    }

    // Waitlist contact capture, offered when a species has no products left. One field at a
    // time; once all three are in, the conversation returns to QUOTE_PRESENTED.
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

    // Identity verification, set up by handleQuotation's isAffirmative branch. Cosmetic KYC must
    // never block a sale, so any non-contact reply counts as declined and moves on — this used
    // to re-show "toca el botón" forever for any typed reply.
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
          // '✅' is not in Telegram's allowed reaction set and failed with REACTION_INVALID in
          // production; '🤝' is allowed and fits "verified".
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

    // Cosmetic selfie confirmation — a SIMULATION: no face matching, no liveness, any photo
    // counts. Same never-loop-forever rule as the phone step above.
    if (context.awaitingSelfie && !context.selfieProvided) {
      if (photo) {
        // A width/height sanity check against an icon-shaped file, not face detection. Asked at most
        // once: a second tiny image is accepted anyway, like every other KYC gate here.
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
          // "¡Identidad confirmada!" is baked into the video itself, so repeating it as text is noise.
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

    // Per-pet details before the human's own data. Accepts one pet per message or several at
    // once, so people can describe every pet in a single turn.
    if (this.isPetSelected(context)) {
      const totalPets = this.totalPetsForPurchase(context);
      const pets = context.pets ?? [];
      if (pets.length < totalPets) {
        const extracted = (intent.pets && intent.pets.length > 0)
          ? intent.pets
          : (intent.petName ? [{ name: intent.petName, age: intent.petAge ?? null, breed: intent.petBreed ?? null }] : []);

        if (extracted.length > 0) {
          const updatedPets = [...pets];
          // Second line of defence: an exact name match is never re-pushed. The NLP once dropped a pet
          // from a 3-pet message and the restated one was appended as a duplicate.
          let duplicateName: string | null = null;
          for (const p of extracted) {
            if (updatedPets.length >= totalPets) break;
            // A pet name goes on the policy PDF like a human name, so it gets the same digit/symbol guard.
            if (!p.name || !this.isValidHumanName(p.name)) continue;
            if (updatedPets.some((existing) => existing.name.toLowerCase() === p.name!.toLowerCase())) {
              duplicateName = p.name;
              continue;
            }
            updatedPets.push({
              name: p.name,
              age: p.age ?? 'no especificada',
              // Voice transcription mangles breed names ("Cocker" → "caken") — normalize against the
              // breed dictionary.
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
          // A summary before cédula, so a mis-transcribed age or breed can be fixed without redoing
          // the whole per-pet loop.
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

    // "sí" proceeds; a correction naming a pet updates just that field instead of restarting
    // the whole per-pet loop.
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

      // Ordinal reference is checked FIRST and wins outright: correcting by name always matched
      // the FIRST occurrence, silently editing the wrong entry when two pets share a name.
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
      // Same digit/symbol guard as the initial capture: a garbage petName must never overwrite
      // an already-valid one.
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

    // Conditional underwriting info, asked once the quoted product requires it. Informational
    // (age, illnesses, history), not a structural gate: ANY reply is stored verbatim and the
    // flow proceeds, so it can never loop.
    if (context.awaitingMedicalInfo) {
      newContext.medicalInfo = rawText;
      newContext.medicalInfoProvided = true;
      newContext.awaitingMedicalInfo = undefined;
      return {
        text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](newContext),
        context: newContext,
      };
    }

    // Not everyone has a CC, so CE/TI/NIP/NUIP are detected from keywords and the digit run is
    // extracted regardless of a spoken prefix ("mi tarjeta de identidad es...").
    if (!context.cedula) {
      const digitsMatch = this.joinSpokenDigits(text).match(/\b\d{6,10}\b/);
      if (!digitsMatch) {
        return { text: 'El número de documento debe tener entre 6 y 10 dígitos. Intenta de nuevo.' };
      }
      newContext.cedula = digitsMatch[0];
      const declarado = this.detectDocumentType(text);
      if (declarado) {
        newContext.documentType = declarado;
      } else {
        // Nadie dijo cuál es. Preguntar un turno cuesta menos que emitir una póliza a nombre
        // de una cédula de ciudadanía que la persona no tiene.
        newContext.awaitingDocumentType = true;
        return { text: AgentService.PREGUNTA_TIPO_DOCUMENTO, context: newContext };
      }
      return {
        text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](newContext),
        context: newContext,
      };
    }

    // Rejects the filler words a voice transcription produces in reply to the agent's own
    // message ("Gracias."): accepting one as the name pushed the real name into the next field.
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

    // Requires a basic shape, or an unrelated phrase silently becomes the "email". Voice
    // dictation says "arroba"/"punto", so it is normalized before validating.
    if (!context.email) {
      const normalizedEmail = this.normalizeSpokenEmail(rawText);
      if (!/\S+@\S+\.\S+/.test(normalizedEmail)) {
        // Hinted only when there is no @ at all: normalizeSpokenEmail cannot invent a symbol the
        // person never said, and a genuine typo deserves no lecture.
        const hint = normalizedEmail.includes('@')
          ? ''
          : ' Si lo dictas por voz, recuerda decir *"arroba"* donde va el @ (ej: "juan arroba gmail punto com").';
        return { text: `¿Cuál es tu correo electrónico? Ahí recibirás la póliza.${hint}` };
      }
      newContext.email = normalizedEmail;
      // vida and medicina-prepagada-gatos/perros need underwriting first; the rest are direct-sell.
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

    // Answering a pending "¿qué dato quieres corregir?" — reset only the named field, not the
    // blanket cédula+nombre+correo reset this replaced.
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

    // Both wordings route to the SAME Wompi checkout link; createPaymentLinkFlow only themes the
    // copy. An unrecognized answer defaults to link de pago rather than re-asking forever — a
    // wording preference must never strand a ready purchase.
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

    // Confirmation step. No PDF is sent here — the only PDF is generated by the webhook once
    // Wompi reports APPROVED.
    if (intent.isAffirmative) {
      // Multi-product purchase: one policy per product, all sharing a single combined Wompi link.
      const productIds = newContext.selectedProductIds?.length
        ? newContext.selectedProductIds
        : (newContext.quoteProductId ? [newContext.quoteProductId] : []);
      const hasResolvableProduct = productIds.some((id) => this.catalog.getProduct(id));

      const policyIds: string[] = [];
      for (const productId of productIds) {
        // Each species-restricted product is issued against its OWN count: 2 dogs + 1 cat were both
        // stored as petCount 3.
        const product = this.catalog.getProduct(productId);
        const petCountOverride = product ? this.petCountForProduct(newContext, product) : newContext.petCount;
        const { policyId } = await this.policy.issue(convId, { ...newContext, quoteProductId: productId, petCount: petCountOverride });
        policyIds.push(policyId);
      }
      newContext.policyId = policyIds[0];
      newContext.policyIds = policyIds;
      // Accumulates permanently, unlike policyIds. Deduped in case the same product is bought
      // again in a later cross-sell.
      newContext.purchasedProductIds = [...new Set([...(context.purchasedProductIds ?? []), ...productIds])];

      // No resolvable product, so there is nothing to ask a payment method for — let
      // createPaymentLinkFlow's own guard abort cleanly instead.
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
      // If the message names exactly one field, reset only that one: resetting all three forced
      // redoing cédula and correo to fix a one-word typo in a name.
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

      // No field named — ask which one instead of blanket-resetting all three.
      return {
        text: '¿Qué dato quieres corregir — cédula, nombre o correo?',
        context: { ...context, awaitingCorrectionField: true },
      };
    }

    // Genuinely unclear: acknowledge instead of re-showing the same summary card, which reads as
    // the agent ignoring the person.
    return { text: `No logré entender eso. ${STATE_RESPONSES[ConversationState.DATA_CAPTURE](context)}` };
  }

  // Creates the Wompi link and the message showing it. Shared by the DATA_CAPTURE confirmation
  // and handlePayment's retry branch, where the conversation already sits in PAYMENT.
  private async createPaymentLinkFlow(convId: string, context: ConversationContext): Promise<ProcessResult> {
    const productIds = context.selectedProductIds?.length
      ? context.selectedProductIds
      : (context.quoteProductId ? [context.quoteProductId] : []);
    const products = productIds
      .map((id) => this.catalog.getProduct(id))
      .filter((p): p is InsuranceProduct => !!p);

    if (products.length === 0) {
      // This used to fall back to a flat $20.000 charge when no product resolved — a customer
      // could be charged for something they were never quoted. Abort and reset instead.
      this.logger.error(`createPaymentLinkFlow: no resolvable product for conversation ${convId} — aborting payment link creation`);
      return {
        text: 'Tuve un problema retomando tu cotización. Escríbeme de nuevo qué seguro te interesa y lo resolvemos.',
        nextState: ConversationState.DISCOVERY,
        context: { ...context, quoteProductId: undefined, selectedProductIds: undefined, policyId: undefined, policyIds: undefined },
      };
    }

    // Species-restricted products were charged against the COMBINED count: the real Wompi
    // amount was wrong, not just the on-screen quote.
    const amountCOP = products.reduce((sum, p) => sum + computeTotalPremium(p, this.petCountForProduct(context, p)), 0);
    const productName = products.length > 1
      ? `${products.length} seguros Colsubsidio`
      : (products[0]?.name ?? 'Seguro Colsubsidio');

    // A session actively using AseguraWeb gets a FRESH token — the original link's may be long
    // expired by checkout — so Wompi's redirect_url returns the browser to the same page.
    // Chat-only conversations get no redirect_url.
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

      // Persisted on EVERY policy in this purchase: the webhook can only find them by
      // payment_link_id, and a multi-product purchase shares one link across all of them.
      const policyIds = context.policyIds?.length ? context.policyIds : (context.policyId ? [context.policyId] : []);
      for (const id of policyIds) {
        await this.policy.updateStatus(id, 'pending_payment', { wompi_link_id: paymentLinkId });
      }

      const amountStr = `$${amountCOP.toLocaleString('es-CO')}`;
      // Both wordings route to this EXACT same Wompi link (Wompi already accepts cards): themed
      // copy, not a second rail, and it never claims the payment already succeeded.
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
        // Tarjeta Colsubsidio has no API of its own, so the "match found" moment gets the branded
        // video — but it is still the same real Wompi link, never a faked "paid" claim.
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

    // Payment confirmation is not trust-based: typing "sí" once issued a policy with nothing
    // verified against Wompi. The webhook is the sole source of truth and notifies proactively.
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
    // Uses the same species-aware helper as buildMixedSpeciesQuote, so every call site prices a
    // mixed household by its own per-species counts.
    const effectivePetCount = context ? this.petCountForProduct(context, product) : undefined;
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

  // Answers a follow-up with the FULL coverage list, since formatQuote truncates to three.
  // Names the other shown products so the person can switch — no invented data (rule #12).
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

  // Answers a COMPLETED customer about their OWN policy — never a sales pitch. Falls back to
  // the generic COMPLETED text if no recorded id still resolves (rule #12).
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

  // Shared with a re-show of an already-active mixed purchase. Pure text builder, never mutates.
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

  // Quotes BOTH products together, reusing the multi-product machinery: a mixed household used
  // to get one species-restricted product multiplied by the TOTAL pet count.
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
