import { Controller, Post, Body, UnauthorizedException, Logger } from '@nestjs/common';
import { WompiService } from './wompi.service';
import { WompiWebhookEvent } from './types';

@Controller('webhooks/wompi')
export class WompiWebhookController {
  private readonly logger = new Logger(WompiWebhookController.name);

  constructor(private readonly wompiService: WompiService) {}

  @Post()
  async handleWebhook(@Body() event: WompiWebhookEvent) {
    if (!this.wompiService.validateWebhookSignature(event)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const txData = this.wompiService.extractTransactionData(event);

    this.logger.log(`Wompi webhook: ${txData.transactionId} - ${txData.status}`);

    if (txData.status !== 'APPROVED') {
      return { status: 'ignored', reason: txData.status };
    }

    return { status: 'processed', transactionId: txData.transactionId };
  }
}