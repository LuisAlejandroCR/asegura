import { Inject, Injectable, Logger } from '@nestjs/common';
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
}

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

    if (!msg.text) return;

    this.logger.log(`Message from ${msg.userId}: "${msg.text.slice(0, 80)}"`);

    const conv = await this.conversations.getOrCreate(msg.userId, msg.channel);
    const lowerText = msg.text.toLowerCase().trim().replace(/[.,!?¡¿:;]+$/, '').trim();
    const rawText = msg.text.trim().replace(/[.,!?¡¿:;]+$/, '').trim();
    const intent: InsuranceIntent = await this.nlp.extractIntent(msg.text);

    const result = await this.processMessage(conv.id, conv.state, conv.context, lowerText, intent, rawText);

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

    if (result.texts?.length) {
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
        return {
          texts: [
            STATE_RESPONSES[ConversationState.GREETING](context),
            STATE_RESPONSES[ConversationState.AUTHORIZATION](context),
          ],
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
        return this.handleDataCapture(convId, context, text, intent, rawText);

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
        newContext.shownProductIds = [quote.product.id];
        return {
          text: this.formatQuote(quote.product, quote.score, newContext),
          nextState: ConversationState.QUOTE_PRESENTED,
          context: newContext,
        };
      }
      // No match for this profile — reset category/coverage and let user redirect
      return {
        text: 'No encontré una opción exacta para ese perfil en el catálogo actual. ¿Quieres que busquemos algo diferente — vida, accidentes, asistencia médica?',
        context: { ...newContext, productCategory: undefined, coverage: undefined, shownProductIds: [] },
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

    // Cross-sell check runs BEFORE isAffirmative: a message naming personal/human
    // coverage ("...muéstrame ese de salud de accidentes para mí") can still contain a
    // loose affirmative word like "quiero" with no question mark — isAffirmative would
    // otherwise win the race and send the user straight to DATA_CAPTURE for the pet
    // quote, silently ignoring the cross-sell request (real live-test bug).
    if (currentProduct?.category === 'mascotas' && this.mentionsPersonalCoverage(text)) {
      // The same message that triggers cross-sell often already names a specific category
      // (e.g. "muéstrame ese de salud de accidentes para mí" → productCategory: 'accidentes')
      // — quote it directly instead of asking a redundant clarifying question that discards
      // information the user already gave (real live-test complaint: "I already said salud
      // y accidentes, why ask again?").
      if (intent.productCategory && intent.productCategory !== 'mascotas') {
        const personalContext: ConversationContext = {
          ...context, productCategory: intent.productCategory, coverage: undefined, petType: undefined, petCount: undefined, shownProductIds: [],
        };
        const best = this.quoting.bestQuote(personalContext as AffiliateSignals);
        if (best) {
          return {
            text: this.formatQuote(best.product, best.score, personalContext),
            nextState: ConversationState.QUOTE_PRESENTED,
            context: { ...personalContext, quoteProductId: best.product.id, shownProductIds: [best.product.id] },
          };
        }
      }
      return {
        text: (
          '¡Claro! Además de tus mascotas, puedo cotizarte algo para ti — vida, accidentes o asistencia médica.\n\n' +
          '¿Cuál te interesa, o cuéntame qué es lo que más te preocupa proteger?'
        ),
        nextState: ConversationState.DISCOVERY,
        context: { ...context, productCategory: undefined, coverage: undefined, petType: undefined, petCount: undefined, shownProductIds: [] },
      };
    }

    // Explicit category switch: the user directly named a different insurance category
    // than what's currently quoted (e.g. "quiero ver seguro de vida" while looking at an
    // asistencia quote). wantsAlternative only cycles within the SAME category, so this
    // used to fall through to the neutral re-display branch below and just repeat the
    // unchanged quote no matter what category the user asked for next (real live-test bug).
    if (intent.productCategory && currentProduct && intent.productCategory !== currentProduct.category) {
      const switchedContext: ConversationContext = {
        ...context, productCategory: intent.productCategory, coverage: undefined, shownProductIds: [],
      };
      const best = this.quoting.bestQuote(switchedContext as AffiliateSignals);
      if (best) {
        return {
          text: this.formatQuote(best.product, best.score, switchedContext),
          nextState: ConversationState.QUOTE_PRESENTED,
          context: { ...switchedContext, quoteProductId: best.product.id, shownProductIds: [best.product.id] },
        };
      }
    }

    if (intent.isAffirmative) {
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
        context: { ...context, productCategory: undefined, coverage: undefined, shownProductIds: [] },
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

  // Common backchannel/acknowledgment words a voice transcription can produce in
  // response to the bot's OWN previous message — never a real person's full name.
  private static readonly FILLER_WORDS = ['gracias', 'ok', 'okay', 'vale', 'listo', 'dale', 'bueno', 'ya'];

  private isFillerWord(text: string): boolean {
    const normalized = text.trim().toLowerCase().replace(/[.,!¡¿?]/g, '');
    return AgentService.FILLER_WORDS.includes(normalized);
  }

  private formatPetsSummary(pets: PetDetail[]): string {
    const lines = pets.map((p, i) => `${i + 1}. ${p.name} — ${p.age} — ${p.breed}`).join('\n');
    return (
      `📋 *Resumen de tus mascotas:*\n\n${lines}\n\n` +
      `¿Todo correcto? Escríbeme *"sí"* para continuar, o dime qué corregir (ej: "Bruna tiene 8 años").`
    );
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
  ): Promise<ProcessResult> {
    const newContext: ConversationContext = { ...context };

    // Step 0 — collect per-pet details (name, age, breed) before the human's own data.
    // Accepts either one pet per message (petName/petAge/petBreed) or several at once
    // (pets[]) — the user can describe all their pets in one turn if they want to.
    if (context.productCategory === 'mascotas') {
      const totalPets = context.petCount ?? 1;
      const pets = context.pets ?? [];
      if (pets.length < totalPets) {
        const extracted = (intent.pets && intent.pets.length > 0)
          ? intent.pets
          : (intent.petName ? [{ name: intent.petName, age: intent.petAge ?? null, breed: intent.petBreed ?? null }] : []);

        if (extracted.length > 0) {
          const updatedPets = [...pets];
          for (const p of extracted) {
            if (updatedPets.length >= totalPets) break;
            if (!p.name) continue;
            updatedPets.push({
              name: p.name,
              age: p.age ?? 'no especificada',
              // Voice transcription regularly mangles breed names (e.g. "Cocker" ->
              // "caken") — normalize against a dictionary of common breeds.
              breed: matchBreed(p.breed),
            });
          }
          if (updatedPets.length < totalPets) {
            return {
              text: `Perfecto. Ahora cuéntame de tu mascota ${updatedPets.length + 1} de ${totalPets}: ¿nombre, edad y raza?`,
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
      if (hasUpdateData && intent.petName) {
        targetIndex = pets.findIndex((p) => p.name.toLowerCase() === intent.petName!.toLowerCase());
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
      updatedPets[targetIndex] = {
        name: intent.petName ?? current.name,
        age: intent.petAge ?? current.age,
        breed: intent.petBreed ? matchBreed(intent.petBreed) : current.breed,
      };

      return {
        text: this.formatPetsSummary(updatedPets),
        context: { ...context, pets: updatedPets },
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
      newContext.nombre = rawText;
      return {
        text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](newContext),
        context: newContext,
      };
    }

    // Step 3 — collect email. Requires a basic email shape (user@domain.tld) — accepting
    // any text unconditionally previously let an unrelated phrase (e.g. a name captured
    // here after nombre was wrongly filled by a filler word) silently become the "email".
    if (!context.email) {
      if (!/\S+@\S+\.\S+/.test(rawText)) {
        return { text: '¿Cuál es tu correo electrónico? Ahí recibirás la póliza.' };
      }
      newContext.email = rawText;
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

    // Step 4 — confirmation ("sí" → create pending policy record, generate the payment
    // link immediately). No extra "¿listo para generar tu link?" question — the user
    // already confirmed by saying "sí" here; asking again is redundant friction, and the
    // message is informative, not another prompt. No PDF is sent here — the only PDF the
    // user receives is generated and sent by wompi-webhook.controller.ts once Wompi
    // reports the transaction as APPROVED.
    if (intent.isAffirmative) {
      const { policyId } = await this.policy.issue(convId, newContext);
      newContext.policyId = policyId;

      return this.createPaymentLinkFlow(convId, newContext);
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
    const quoteProduct = PRODUCTS.find((p) => p.id === context.quoteProductId);
    const amountCOP = quoteProduct ? computeTotalPremium(quoteProduct, context.petCount) : 20000;

    try {
      const { checkoutUrl, paymentLinkId } = await this.wompi.createPaymentLink({
        policyId: context.policyId ?? convId,
        productName: quoteProduct?.name ?? 'Seguro Colsubsidio',
        amountCOP,
        expiresInMinutes: 30,
      });

      // Persist immediately — the webhook can only find this policy via payment_link_id
      // (Wompi's Payment Links API has no "reference" create-parameter).
      if (context.policyId) {
        await this.policy.updateStatus(context.policyId, 'pending_payment', { wompi_link_id: paymentLinkId });
      }

      const amountStr = `$${amountCOP.toLocaleString('es-CO')}`;
      const msg = (
        `🔒 Tu pago es 100% seguro a través de Wompi — plataforma oficial de Bancolombia.\n\n` +
        `🔗 [Pagar ${amountStr} — Link seguro Wompi](${checkoutUrl})\n\n` +
        `Acepta tarjeta débito/crédito, Nequi y PSE.\n\n` +
        `⏱️ El link vence en 30 minutos.\n\n` +
        `En cuanto tu pago sea confirmado, te aviso aquí automáticamente con tu póliza.`
      );

      return { text: msg, nextState: ConversationState.PAYMENT, context: { ...context, checkoutUrl } };
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
