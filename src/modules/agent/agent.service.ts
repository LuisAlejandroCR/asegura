import { Inject, Injectable, Logger } from '@nestjs/common';
import { INlpProvider, InsuranceIntent } from '../nlp/types';
import { TelegramAdapter } from '../channel/telegram-adapter.service';
import { NormalizedMessage } from '../channel/types';
import { ConversationService } from './conversation.service';
import { ConversationState, ConversationContext } from './types';
import { STATE_RESPONSES } from './conversation-state.machine';
import { QuotingService } from '../quoting/quoting.service';
import { PolicyService } from '../policy/policy.service';
import { WompiService } from '../payments/wompi.service';
import { CeloService } from '../blockchain/celo.service';
import { AffiliateSignals, InsuranceProduct } from '../quoting/types';
import { PRODUCTS } from '../quoting/products.data';

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
    private readonly blockchain: CeloService,
  ) {}

  async handleMessage(raw: unknown): Promise<void> {
    const msg: NormalizedMessage = await this.telegram.normalize(raw);
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

    const hasEnoughInfo = newContext.productCategory && newContext.coverage?.length;
    if (hasEnoughInfo) {
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

    return { text: STATE_RESPONSES[ConversationState.QUOTE_PRESENTED](context) };
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

    // Step 1 — collect cédula
    if (!context.cedula) {
      if (!/^\d{6,10}$/.test(text)) {
        return { text: 'La cédula debe tener entre 6 y 10 dígitos. Intenta de nuevo.' };
      }
      newContext.cedula = text;
      return {
        text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](newContext),
        context: newContext,
      };
    }

    // Step 2 — collect nombre
    if (!context.nombre) {
      newContext.nombre = rawText;
      return {
        text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](newContext),
        context: newContext,
      };
    }

    // Step 3 — collect email
    if (!context.email) {
      newContext.email = rawText;
      return {
        text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](newContext),
        context: newContext,
      };
    }

    // Step 4 — confirmation ("sí" → issue policy)
    if (intent.isAffirmative) {
      const { policyId, pdfBuffer } = await this.policy.issue(convId, newContext);
      newContext.policyId = policyId;

      const result: ProcessResult = {
        text: STATE_RESPONSES[ConversationState.PAYMENT](newContext),
        nextState: ConversationState.PAYMENT,
        context: newContext,
      };

      if (pdfBuffer) {
        result.document = { buffer: pdfBuffer, filename: `poliza-${policyId.slice(0, 8)}.pdf` };
      }

      return result;
    }

    if (intent.isNegative || text.includes('corregir')) {
      return {
        text: '¿Qué dato quieres corregir? Escríbeme tu cédula de nuevo y empezamos.',
        nextState: ConversationState.DATA_CAPTURE,
        context: { ...context, cedula: undefined, nombre: undefined, email: undefined },
      };
    }

    // Default — re-show confirmation summary
    return { text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](context) };
  }

  // ── Payment ─────────────────────────────────────────────────────────────────

  private async handlePayment(
    convId: string,
    context: ConversationContext,
    text: string,
    intent: InsuranceIntent,
  ): Promise<ProcessResult> {
    const isConfirm = intent.isAffirmative;

    if (context.checkoutUrl && isConfirm) {
      const newContext: ConversationContext = { ...context, checkoutUrl: undefined };

      // Register on Celo — non-blocking, fails gracefully
      if (context.policyId) {
        const referenceURI = `https://asegura.co/poliza/${context.policyId}`;
        const { celoscanUrl } = await this.blockchain.registerPolicy(context.policyId, referenceURI);
        if (celoscanUrl) {
          newContext.celoscanUrl = celoscanUrl;
          await this.policy.updateStatus(context.policyId, 'active', { celo_tx_hash: celoscanUrl.split('/tx/')[1] });
        }
      }

      return {
        text: STATE_RESPONSES[ConversationState.POLICY_ISSUED](newContext),
        nextState: ConversationState.POLICY_ISSUED,
        context: newContext,
      };
    }

    if (context.checkoutUrl && intent.isNegative) {
      return {
        text: 'Entendido. Si quieres intentar de nuevo más tarde, escríbeme cuando gustes.',
        nextState: ConversationState.ABANDONED,
        context,
      };
    }

    if (context.checkoutUrl) {
      return {
        text: `El link de pago ya está generado: [Pagar aquí](${context.checkoutUrl})\n\nUna vez pagues, escríbeme "sí" para continuar.`,
        context,
      };
    }

    if (isConfirm) {
      const quoteProduct = PRODUCTS.find((p) => p.id === context.quoteProductId);
      const amountCOP = quoteProduct?.basePremium ?? 20000;

      try {
        const checkoutUrl = await this.wompi.createPaymentLink({
          policyId: context.policyId ?? convId,
          productName: quoteProduct?.name ?? 'Seguro Colsubsidio',
          amountCOP,
          expiresInMinutes: 30,
        });

        const amountStr = `$${amountCOP.toLocaleString('es-CO')}`;
        const msg = (
          `Para completar tu compra, paga aquí:\n\n` +
          `🔗 [Pagar ${amountStr} — Link seguro Wompi](${checkoutUrl})\n\n` +
          `El link es seguro (Wompi + Bancolombia). Acepta tarjeta de crédito, débito, Nequi y PSE.\n\n` +
          `⏱️ El link vence en 30 minutos.\n\n` +
          `Una vez pagues, escríbeme "sí" para que active tu póliza.`
        );

        return { text: msg, context: { ...context, checkoutUrl } };
      } catch (error) {
        this.logger.error(`Failed to create payment link: ${error}`);
        return {
          text: (
            `El monto a pagar es *$${amountCOP.toLocaleString('es-CO')}*.\n\n` +
            `Por ahora no puedo generar el link de pago automático. Realiza la transferencia a la cuenta indicada por tu asesor y comparte el comprobante aquí.` +
            `\n\n¿Ya realizaste el pago? Escríbeme "sí" cuando esté listo.`
          ),
          context,
        };
      }
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

    let priceBlock: string;
    if (isPet && petCount && petCount > 1) {
      const total = pricePerUnit * petCount;
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
