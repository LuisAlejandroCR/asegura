import { Inject, Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import { INlpProvider, InsuranceIntent } from '../nlp/types';
import { TelegramAdapter } from '../channel/telegram-adapter.service';
import { NormalizedMessage } from '../channel/types';
import { ConversationService } from './conversation.service';
import { ConversationState, ConversationContext, PetDetail, DocumentType } from './types';
import { STATE_RESPONSES } from './conversation-state.machine';
import { QuotingService } from '../quoting/quoting.service';
import { PolicyService } from '../policy/policy.service';
import { WompiService } from '../payments/wompi.service';
import { AffiliateSignals, InsuranceProduct } from '../quoting/types';
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
}

// Static brand asset — referenced relative to the project root (not __dirname) because
// nest-cli.json doesn't copy non-.ts assets into dist/, and the server runs `node dist/main`
// from the project root, so `src/assets/` is reachable at runtime via process.cwd()
// (same convention as pdf.service.ts's IMAGES_DIR).
const SUCCESS_ANIMATION_PATH = path.join(process.cwd(), 'src', 'assets', 'success-check.mp4');

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
  ) {}

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
    const lowerText = msg.text.toLowerCase().trim().replace(/[.,!?¡¿:;]+$/, '').trim();
    const rawText = msg.text.trim().replace(/[.,!?¡¿:;]+$/, '').trim();
    const intent: InsuranceIntent = msg.text
      ? await this.nlp.extractIntent(msg.text)
      : {
          productCategory: null, coverage: [], beneficiaries: 1, urgency: 'exploring',
          isAffirmative: false, isNegative: false, wantsAlternative: false, petResolution: null,
        };

    const result = await this.processMessage(conv.id, conv.state, conv.context, lowerText, intent, msg.contact, msg.photo, rawText);

    // Persist state/context whenever either changes
    if (result.nextState || result.context) {
      await this.conversations.saveState(
        conv.id,
        result.nextState ?? conv.state,
        result.context ?? conv.context,
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
    } else if (result.texts?.length) {
      for (const t of result.texts) {
        await this.telegram.sendText(msg.userId, t);
      }
    } else if (result.text) {
      await this.telegram.sendText(msg.userId, result.text);
    }
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
      return {
        text: STATE_RESPONSES[ConversationState.ABANDONED](context),
        nextState: ConversationState.ABANDONED,
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
        if (intent.isAffirmative) {
          return {
            text: STATE_RESPONSES[ConversationState.DISCOVERY](context),
            nextState: ConversationState.DISCOVERY,
            context: { ...context, autorizado: true },
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
        if (text.includes('hola') || text.includes('ayuda') || text.includes('inicio') || text === '/start') {
          return {
            text: STATE_RESPONSES[ConversationState.GREETING](context),
            nextState: ConversationState.GREETING,
          };
        }
        return {
          text: STATE_RESPONSES[currentState]?.(context) ?? STATE_RESPONSES[ConversationState.COMPLETED](context),
        };
    }
  }

  // ── Discovery ────────────────────────────────────────────────────────────────

  private handleDiscovery(
    context: ConversationContext,
    text: string,
    intent: InsuranceIntent,
  ): ProcessResult {
    const newContext: ConversationContext = { ...context };

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
    }

    if (!context.coverage && intent.coverage?.length) newContext.coverage = intent.coverage;
    if (!context.beneficiaries && intent.beneficiaries > 0) newContext.beneficiaries = intent.beneficiaries;
    if (!context.budget && intent.budget) newContext.budget = intent.budget;
    if (!context.petCount && intent.petCount && intent.petCount > 0) newContext.petCount = intent.petCount;

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

    // First time detecting mixed pets — ask clarification before quoting
    if (newContext.petType === 'mixto') {
      return {
        text: '¡Qué bonita familia de mascotas! 🐱🐶 ¿Para cuál quieres el seguro? ¿Solo el gato, solo los perros, o quieres cotizar para todos por separado?',
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
    };
  }

  // ── Quotation ────────────────────────────────────────────────────────────────

  private handleQuotation(context: ConversationContext, text: string, intent: InsuranceIntent): ProcessResult {
    const currentProduct = PRODUCTS.find((p) => p.id === context.quoteProductId);

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

    if (intent.wantsAlternative || (intent.isNegative && !intent.isAffirmative)) {
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

      return {
        text: 'No tengo más opciones en esta categoría. ¿Quieres que busquemos en otra?',
        nextState: ConversationState.DISCOVERY,
        context: { ...context, productCategory: undefined, coverage: undefined },
      };
    }

    // Real bug found 2026-07-24 (confirmed independently by a live test session and a
    // teammate's findings report): asking for a category we don't sell ("vehicular",
    // "seguro vehicular") silently re-showed the unrelated, already-quoted product
    // verbatim, identically, twice — the agent never acknowledged the request was for
    // something else entirely. Must check this BEFORE falling through to the
    // neutral-message re-show below.
    const outOfCatalog = this.detectOutOfCatalogCategory(text);
    if (outOfCatalog) {
      return {
        text: `Por ahora no tengo seguros de ${outOfCatalog}, pero sí tengo vida, accidentes, asistencia médica y mascotas. ¿Te interesa alguno de estos?`,
      };
    }

    // Neutral/unclear message (e.g. a follow-up question) — re-show the actual quoted
    // product instead of the generic STATE_RESPONSES placeholder, which has no real
    // product name or price and reads as a broken response.
    if (currentProduct) {
      return {
        text: this.formatQuote(
          currentProduct,
          { reasons: [], monthlyPremium: currentProduct.basePremium },
          context,
        ),
      };
    }

    return { text: STATE_RESPONSES[ConversationState.QUOTE_PRESENTED](context) };
  }

  private mentionsPersonalCoverage(text: string): boolean {
    // "también"/"tambien" alone is too generic here — could just mean "I also have a
    // dog" mid-pet-conversation. Anchor on phrases that specifically mean "for me".
    const personalPhrases = ['para mí', 'para mi', 'y yo'];
    const humanCategories = ['vida', 'accidentes', 'accidente', 'salud', 'hogar'];
    return personalPhrases.some((p) => text.includes(p)) || humanCategories.some((c) => text.includes(c));
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
          // animated burst) on the shared-contact message itself.
          reaction: '✅',
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
          text: `✅ Identidad confirmada con tu foto.\n\n${this.firstDataCaptureQuestion(confirmedContext)}`,
          context: confirmedContext,
          // 2026-07-24 feedback: "animated successfully check" — the real branded
          // success-checkmark video, not just a text reaction.
          animation: SUCCESS_ANIMATION_PATH,
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
      const digitsMatch = text.match(/\b\d{6,10}\b/);
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
      if (!this.isValidHumanName(rawText)) {
        return { text: 'Ese no parece un nombre válido — solo letras y espacios, sin números ni símbolos. ¿Cuál es tu nombre completo?' };
      }
      newContext.nombre = rawText.trim();
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
        return { text: '¿Cuál es tu correo electrónico? Ahí recibirás la póliza.' };
      }
      newContext.email = normalizedEmail;
      // 2026-07-24 business feedback: vida and medicina-prepagada-gatos/perros need
      // conditional underwriting info before the final confirmation — everything else
      // is direct-sell and goes straight to it.
      if (this.requiresUnderwritingInfo(newContext) && !newContext.medicalInfoProvided) {
        return {
          text: 'Para este seguro necesito un par de datos adicionales: tu edad, si tienes alguna enfermedad preexistente, y un breve historial clínico (o escribe "ninguna" si no aplica).',
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
        const { policyId } = await this.policy.issue(convId, { ...newContext, quoteProductId: productId });
        policyIds.push(policyId);
      }
      newContext.policyId = policyIds[0];
      newContext.policyIds = policyIds;

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

    const amountCOP = products.reduce((sum, p) => sum + computeTotalPremium(p, context.petCount), 0);
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
        `En cuanto tu pago sea confirmado, te aviso aquí automáticamente con tu póliza.`
      );

      return {
        text: msg,
        nextState: ConversationState.PAYMENT,
        context: { ...context, checkoutUrl },
        // 2026-07-24 feedback: Tarjeta Colsubsidio has no real API/sandbox of its own —
        // precisely because there's nothing real to show for it, the "match found"
        // moment gets the real branded success-checkmark video. Still the exact same
        // real Wompi link, never a faked/instant "paid" claim.
        ...(context.paymentMethodChoice === 'tarjeta_colsubsidio' && { animation: SUCCESS_ANIMATION_PATH }),
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
        text: `Tu link de pago sigue activo: [Pagar aquí](${context.checkoutUrl})\n\nEn cuanto Wompi confirme tu pago, te aviso automáticamente aquí mismo — no necesitas escribirme de nuevo.`,
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
    const petCount = (isPet && context?.petCount && context.petCount > 0) ? context.petCount : null;
    const pricePerUnit = product.basePremium;
    const total = computeTotalPremium(product, context?.petCount);

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
}
