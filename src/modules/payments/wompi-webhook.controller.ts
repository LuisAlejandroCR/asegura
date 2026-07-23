// wompi-webhook.controller.ts: receives Wompi payment events, updates policy status
import { Controller, Post, Body, UnauthorizedException, Logger } from '@nestjs/common';
import { WompiService } from './wompi.service';
import { PolicyService } from '../policy/policy.service';
import { CeloService } from '../blockchain/celo.service';
import { WompiWebhookEvent } from './types';

@Controller('webhooks/wompi')
export class WompiWebhookController {
  private readonly logger = new Logger(WompiWebhookController.name);

  constructor(
    private readonly wompi: WompiService,
    private readonly policy: PolicyService,
    private readonly celo: CeloService,
  ) {}

  @Post()
  async handleWebhook(@Body() event: WompiWebhookEvent) {
    if (!this.wompi.validateWebhookSignature(event)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const txData = this.wompi.extractTransactionData(event);
    this.logger.log(`Wompi webhook: ${txData.transactionId} — ${txData.status}`);

    if (txData.status !== 'APPROVED') {
      if (txData.reference) {
        await this.policy.updateStatus(txData.reference, txData.status.toLowerCase());
      }
      return { status: 'ignored', reason: txData.status };
    }

    // Payment approved — update policy and register on Celo
    const policyId = txData.reference;
    await this.policy.updateStatus(policyId, 'paid', { wompi_link_id: txData.transactionId });

    const referenceURI = `https://asegura.co/poliza/${policyId}`;
    const { txHash } = await this.celo.registerPolicy(policyId, referenceURI);

    if (txHash) {
      await this.policy.updateStatus(policyId, 'active', { celo_tx_hash: txHash });
    }

    return { status: 'processed', transactionId: txData.transactionId, celoTxHash: txHash };
  }
}
