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

    // Wompi requires ISO 8601 with a "T" separator, no milliseconds, no "Z" — e.g.
    // "2040-12-10T14:30:00" (confirmed against docs.wompi.co). A previous version
    // replaced "T" with a space, which Wompi's API rejects with a 422.
    const expiresAt = params.expiresInMinutes
      ? new Date(Date.now() + params.expiresInMinutes * 60_000)
          .toISOString()
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

  // Wompi's own docs (docs.wompi.co/docs/colombia/eventos/) warn that the field set/order
  // in signature.properties "pueden variar en el tiempo y en cada evento" — a previous
  // version hardcoded transaction.id + transaction.status + transaction.amount_in_cents,
  // which would have silently rejected every real webhook whose properties differed.
  validateWebhookSignature(event: WompiWebhookEvent): boolean {
    if (!this.eventsSecret) return false;

    const properties = event.signature?.properties;
    if (!properties?.length) return false;

    const concatenated = properties.map((path) => this.resolveProperty(event.data, path)).join('');
    const timestamp = event.timestamp;

    const expectedChecksum = createHash('sha256')
      .update(`${concatenated}${timestamp}${this.eventsSecret}`)
      .digest('hex');

    return expectedChecksum === event.signature?.checksum;
  }

  private resolveProperty(data: unknown, dottedPath: string): string {
    const value = dottedPath.split('.').reduce((acc: any, key) => acc?.[key], data);
    return value === undefined || value === null ? '' : String(value);
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
