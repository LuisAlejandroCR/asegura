import { Inject, Injectable, Logger } from '@nestjs/common';
import { INlpProvider, InsuranceIntent } from '../nlp/types';
import { TelegramAdapter } from '../channel/telegram-adapter.service';
import { NormalizedMessage } from '../channel/types';
import { ConversationService } from './conversation.service';
import { ConversationState, ConversationContext } from './types';
import { STATE_RESPONSES } from './conversation-state.machine';
import { QuotingService } from '../quoting/quoting.service';
import { AffiliateSignals, InsuranceProduct } from '../quoting/types';
import { PRODUCTS } from '../quoting/products.data';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    @Inject('INlpProvider')
    private readonly nlp: INlpProvider,
    private readonly telegram: TelegramAdapter,
    private readonly conversations: ConversationService,
    private readonly quoting: QuotingService,
  ) {}

  async handleMessage(raw: unknown): Promise<void> {
    const msg: NormalizedMessage = this.telegram.normalize(raw);
    if (!msg.text) return;

    this.logger.log(`Message from ${msg.userId}: "${msg.text.slice(0, 80)}"`);

    const conv = await this.conversations.getOrCreate(msg.userId, msg.channel);
    const lowerText = msg.text.toLowerCase().trim();

    const intent: InsuranceIntent = await this.nlp.extractIntent(msg.text);
    const response = await this.processMessage(conv.state, conv.context, lowerText, intent);

    if (response.nextState) {
      await this.conversations.saveState(
        conv.id,
        response.nextState,
        response.context ?? conv.context,
      );
    }

    if (response.text) {
      await this.telegram.sendText(msg.userId, response.text);
    }
  }

  private async processMessage(
    currentState: ConversationState,
    context: ConversationContext,
    text: string,
    intent: InsuranceIntent,
  ): Promise<{ text?: string; nextState?: ConversationState; context?: ConversationContext }> {
    if (intent.abandonIntent && currentState !== ConversationState.GREETING && currentState !== ConversationState.QUOTE_PRESENTED) {
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

      case ConversationState.DISCOVERY: {
        const newContext: ConversationContext = { ...context };
        let changed = false;

        if (!context.productCategory && intent.productCategory) {
          newContext.productCategory = intent.productCategory;
          changed = true;
        }
        if (!context.coverage && intent.coverage?.length) {
          newContext.coverage = intent.coverage;
          changed = true;
        }
        if (!context.beneficiaries && intent.beneficiaries > 0) {
          newContext.beneficiaries = intent.beneficiaries;
          changed = true;
        }
        if (!context.budget && intent.budget) {
          newContext.budget = intent.budget;
          changed = true;
        }

        const hasEnoughInfo = newContext.productCategory && newContext.coverage?.length;
        if (hasEnoughInfo) {
          const quote = this.quoting.bestQuote(newContext as AffiliateSignals);
          if (quote) {
            newContext.quoteProductId = quote.product.id;
            return {
              text: this.formatQuote(quote.product, quote.score),
              nextState: ConversationState.QUOTE_PRESENTED,
              context: newContext,
            };
          }
          return {
            text: STATE_RESPONSES[ConversationState.QUOTE_PRESENTED](newContext),
            nextState: ConversationState.QUOTE_PRESENTED,
            context: newContext,
          };
        }

        return {
          text: STATE_RESPONSES[ConversationState.DISCOVERY](newContext),
          context: changed ? newContext : context,
        };
      }

      case ConversationState.QUOTING:
      case ConversationState.QUOTE_PRESENTED: {
        if (text === 'sí' || text === 'si') {
          return {
            text: 'Perfecto. Para emitir la póliza necesito tus datos.',
            nextState: ConversationState.DATA_CAPTURE,
          };
        }
        if (text === 'no' || text.includes('otro') || text.includes('otra') || text.includes('diferente') || text.includes('más')) {
          const allScores = this.quoting.score(context as AffiliateSignals);
          const remaining = context.quoteProductId
            ? allScores.filter((s) => s.productId !== context.quoteProductId)
            : allScores;
          const nextProduct = remaining[0];
          if (nextProduct) {
            const altProduct = PRODUCTS.find((p) => p.id === nextProduct.productId);
            if (altProduct) {
              return {
                text: this.formatQuote(altProduct, nextProduct),
                nextState: ConversationState.QUOTE_PRESENTED,
                context: { ...context, quoteProductId: altProduct.id },
              };
            }
          }
          return {
            text: 'No tengo más opciones en esta categoría. ¿Quieres probar con otra?',
            nextState: ConversationState.DISCOVERY,
          };
        }
        return {
          text: STATE_RESPONSES[ConversationState.QUOTE_PRESENTED](context),
        };
      }

      case ConversationState.DATA_CAPTURE: {
        const newContext = { ...context };
        let nextState: ConversationState = currentState;

        if (!context.cedula && /^\d{6,10}$/.test(text)) {
          newContext.cedula = text;
        } else if (!context.cedula) {
          return { text: 'La cédula debe tener entre 6 y 10 dígitos. Intenta de nuevo.' };
        }

        if (!context.nombre && context.cedula) {
          newContext.nombre = text;
          return { text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](newContext), context: newContext };
        } else if (!context.nombre) {
          return { text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](newContext) };
        }

        if (!context.email) {
          if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
            newContext.email = text;
            nextState = ConversationState.PAYMENT;
          } else if (!context.email) {
            newContext.email = text;
            nextState = ConversationState.PAYMENT;
          }
        }

        if (nextState === ConversationState.PAYMENT) {
          return {
            text: STATE_RESPONSES[ConversationState.PAYMENT](newContext),
            nextState,
            context: newContext,
          };
        }

        return { text: STATE_RESPONSES[ConversationState.DATA_CAPTURE](newContext), context: newContext };
      }

      default:
        if (text.includes('hola') || text.includes('ayuda')) {
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

  private formatQuote(product: { name: string; insurer: string; coverages: string[]; basePremium: number; url: string }, score: { reasons: string[]; monthlyPremium: number }): string {
    const cov = product.coverages.slice(0, 3).map((c) => `✅ ${c}`).join('\n');
    return `📋 *Tu cotización personalizada*\n\n🛡️ *${product.name}* con ${product.insurer}\n${cov}\n\nTe lo recomiendo porque: ${score.reasons[0] ?? 'se ajusta a lo que buscas'}.\n\n👉 Ver detalles: ${product.url}\n\n💰 *Desde $${product.basePremium.toLocaleString()}/mes*\n\n¿Te interesa o prefieres que busquemos otra opción?`;
  }
}