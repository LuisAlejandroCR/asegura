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
    const msg: NormalizedMessage = this.telegram.normalize(raw);
    if (!msg.text) return;

    this.logger.log(`Message from ${msg.userId}: "${msg.text.slice(0, 80)}"`);

    const conv = await this.conversations.getOrCreate(msg.userId, msg.channel);
    const lowerText = msg.text.toLowerCase().trim();
    const intent: InsuranceIntent = await this.nlp.extractIntent(msg.text);

    const result = await this.processMessage(conv.id, conv.state, conv.context, lowerText, intent);

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

    if (result.text) {
      await this.telegram.sendText(msg.userId, result.text);
    }
  }

  private async processMessage(
    convId: string,
    currentState: ConversationState,
    context: ConversationContext,
    text: string,
    intent: InsuranceIntent,
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
          text: STATE_RESPONSES[ConversationState.AUTHORIZATION](context),
          nextState: ConversationState.AUTHORIZATION,
        };

      case ConversationState.AUTHORIZATION:
        if (text === 'sí' || text === 'si') {
          return {
            text: STATE_RESPONSES[ConversationState.DISCOVERY](context),
            nextState: ConversationState.DISCOVERY,
            context: { ...context, autorizado: true },
          };
        }
        return {
          text: STATE_RESPONSES[ConversationState.REJECTED](context),
          nextState: ConversationState.REJECTED,
          context: { ...context, autorizado: false },
        };

      case ConversationState.DISCOVERY:
        return this.handleDiscovery(context, text, intent);

      case ConversationState.QUOTING:
      case ConversationState.QUOTE_PRESENTED:
        return this.handleQuotation(context, text);

      case ConversationState.DATA_CAPTURE:
        return this.handleDataCapture(convId, context, text);

      case ConversationState.PAYMENT:
        return this.handlePayment(convId, context, text);

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
    _text: string,
    intent: InsuranceIntent,
  ): ProcessResult {
    const newContext: ConversationContext = { ...context };

    if (!context.productCategory && intent.productCategory) newContext.productCategory = intent.productCategory;
    if (!context.petType && intent.petType) newContext.petType = intent.petType;
    if (!context.coverage && intent.coverage?.length) newContext.coverage = intent.coverage;
    if (!context.beneficiaries && intent.beneficiaries > 0) newContext.beneficiaries = intent.beneficiaries;
    if (!context.budget && intent.budget) newContext.budget = intent.budget;

    const hasEnoughInfo = newContext.productCategory && newContext.coverage?.length;
    if (hasEnoughInfo) {
      const quote = this.quoting.bestQuote(newContext as AffiliateSignals);
      if (quote) {
        newContext.quoteProductId = quote.product.id;
        newContext.shownProductIds = [quote.product.id];
        return {
          text: this.formatQuote(quote.product, quote.score),
          nextState: ConversationState.QUOTE_PRESENTED,
          context: newContext,
        };
      }
    }

    return {
      text: STATE_RESPONSES[ConversationState.DISCOVERY](newContext),
      context: newContext,
    };
  }

  // ── Quotation ────────────────────────────────────────────────────────────────

  private handleQuotation(context: ConversationContext, text: string): ProcessResult {
    if (text === 'sí' || text === 'si') {
      return {
        text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](context),
        nextState: ConversationState.DATA_CAPTURE,
      };
    }

    if (
      text === 'no' ||
      text.includes('otro') ||
      text.includes('otra') ||
      text.includes('diferente') ||
      text.includes('más')
    ) {
      const allScores = this.quoting.score(context as AffiliateSignals);
      const seen = context.shownProductIds ?? (context.quoteProductId ? [context.quoteProductId] : []);
      const nextProduct = allScores.find((s) => !seen.includes(s.productId));

      if (nextProduct) {
        const altProduct = PRODUCTS.find((p) => p.id === nextProduct.productId);
        if (altProduct) {
          return {
            text: this.formatQuote(altProduct, nextProduct),
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
      newContext.nombre = text;
      return {
        text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](newContext),
        context: newContext,
      };
    }

    // Step 3 — collect email
    if (!context.email) {
      newContext.email = text;
      return {
        text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](newContext),
        context: newContext,
      };
    }

    // Step 4 — confirmation ("sí" → issue policy)
    if (text === 'sí' || text === 'si') {
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

    if (text === 'no' || text.includes('corregir')) {
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
  ): Promise<ProcessResult> {
    const isConfirm = text === 'sí' || text === 'si';

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

    if (context.checkoutUrl && text === 'no') {
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

    if (text === 'no') {
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
  ): string {
    const cov = product.coverages.slice(0, 3).map((c) => `✅ ${c}`).join('\n');
    const reason = score.reasons[0] ?? 'se ajusta a lo que buscas';
    return (
      `📋 *Tu cotización personalizada*\n\n` +
      `🛡️ *${product.name}* con ${product.insurer}\n${cov}\n\n` +
      `Te lo recomiendo porque: ${reason}.\n\n` +
      `👉 Ver detalles: ${product.url}\n\n` +
      `💰 *Desde $${product.basePremium.toLocaleString('es-CO')}/mes*\n\n` +
      `¿Te interesa o prefieres que busquemos otra opción?`
    );
  }
}
