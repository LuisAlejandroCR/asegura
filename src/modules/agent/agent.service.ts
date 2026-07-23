import { Inject, Injectable, Logger } from '@nestjs/common';
import { INlpProvider, InsuranceIntent } from '../nlp/types';
import { TelegramAdapter } from '../channel/telegram-adapter.service';
import { NormalizedMessage } from '../channel/types';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    @Inject('INlpProvider')
    private readonly nlp: INlpProvider,
    private readonly telegram: TelegramAdapter,
  ) {}

  async handleMessage(raw: unknown): Promise<void> {
    const msg: NormalizedMessage = this.telegram.normalize(raw);
    if (!msg.text) return;

    this.logger.log(`Message from ${msg.userId}: "${msg.text.slice(0, 80)}"`);

    const intent: InsuranceIntent = await this.nlp.extractIntent(msg.text);
    const response = this.buildResponse(intent);
    await this.telegram.sendText(msg.userId, response);
  }

  private buildResponse(intent: InsuranceIntent): string {
    if (intent.abandonIntent) {
      return 'Entendido. Si cambias de opinión, aquí estoy 24/7.';
    }

    const category = intent.productCategory ?? 'seguros';
    return `Entendido, buscamos seguros de ${category} para ti.\n\nCuéntame, ¿cuántas personas son en tu familia y qué edades tienen?`;
  }
}