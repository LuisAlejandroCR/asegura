// wompi.service.ts: Wompi payment links and webhook validation
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { CreatePaymentLinkParams, CreatePaymentLinkResult, WompiWebhookEvent, WompiTransactionResult } from './types';

@Injectable()
export class WompiService {
  private readonly logger = new Logger(WompiService.name);
  private readonly enabled: boolean;
  private readonly baseUrl: string;
  private readonly privateKey: string;
  private readonly eventsSecret: string;

  constructor(private readonly config: ConfigService) {
    const environment = config.get<string>('WOMPI_ENVIRONMENT');
    const privateKey = config.get<string>('WOMPI_PRIVATE_KEY');
    const eventsSecret = config.get<string>('WOMPI_EVENTS_SECRET');

    this.enabled = !!(environment && privateKey && eventsSecret);
    this.privateKey = privateKey ?? '';
    this.eventsSecret = eventsSecret ?? '';
    this.baseUrl = environment === 'production'
      ? 'https://production.wompi.co/v1'
      : 'https://sandbox.wompi.co/v1';

    if (!this.enabled) {
      this.logger.warn('Wompi disabled — WOMPI_ENVIRONMENT, WOMPI_PRIVATE_KEY or WOMPI_EVENTS_SECRET not set');
    }
  }

  async createPaymentLink(params: CreatePaymentLinkParams): Promise<CreatePaymentLinkResult> {
    if (!this.enabled) {
      throw new Error('Wompi not configured');
    }

    const expiresAt = params.expiresInMinutes
      ? new Date(Date.now() + params.expiresInMinutes * 60_000)
          .toISOString()
          .replace('T', ' ')
          .slice(0, 19)
      : undefined;

    const body = {
      name: params.productName,
      description: `Póliza ${params.policyId}`,
      single_use: true,
      collect_shipping: false,
      currency: 'COP',
      amount_in_cents: params.amountCOP * 100,
      ...(expiresAt && { expires_at: expiresAt }),
    };

    this.logger.log(`Creating payment link: ${params.policyId} - $${params.amountCOP} COP`);

    const response = await fetch(`${this.baseUrl}/payment_links`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.privateKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Wompi API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json() as any;
    const paymentLinkId: string = result.data.id;
    const checkoutUrl = `https://checkout.wompi.co/l/${paymentLinkId}`;

    this.logger.log(`Payment link created: ${checkoutUrl}`);
    return { checkoutUrl, paymentLinkId };
  }

  validateWebhookSignature(event: WompiWebhookEvent): boolean {
    if (!this.eventsSecret) return false;

    const { transaction } = event.data;
    const properties = `${transaction.id}${transaction.status}${transaction.amount_in_cents}`;
    const timestamp = event.timestamp;

    const expectedChecksum = createHash('sha256')
      .update(`${properties}${timestamp}${this.eventsSecret}`)
      .digest('hex');

    return expectedChecksum === event.signature?.checksum;
  }

  extractTransactionData(event: WompiWebhookEvent): WompiTransactionResult {
    return {
      transactionId: event.data.transaction.id,
      reference: event.data.transaction.reference,
      paymentLinkId: event.data.transaction.payment_link_id ?? null,
      status: event.data.transaction.status,
      amountInCents: event.data.transaction.amount_in_cents,
      paymentMethod: event.data.transaction.payment_method_type,
      createdAt: event.data.transaction.created_at,
    };
  }

  get isEnabled(): boolean {
    return this.enabled;
  }
}
