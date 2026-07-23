import { createHash } from 'crypto';
import { WompiService } from './wompi.service';
import { WompiWebhookEvent } from './types';

function makeConfig(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    WOMPI_ENVIRONMENT: 'sandbox',
    WOMPI_PRIVATE_KEY: 'prv_test_abc',
    WOMPI_EVENTS_SECRET: 'secret123',
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key] ?? undefined) } as any;
}

function makeEvent(overrides: {
  id?: string; status?: string; amount?: number; timestamp?: number; secret?: string;
} = {}): WompiWebhookEvent {
  const id = overrides.id ?? 'txn-1';
  const status = overrides.status ?? 'APPROVED';
  const amount = overrides.amount ?? 5000000;
  const timestamp = overrides.timestamp ?? 1700000000;
  const secret = overrides.secret ?? 'secret123';

  const properties = `${id}${status}${amount}`;
  const checksum = createHash('sha256')
    .update(`${properties}${timestamp}${secret}`)
    .digest('hex');

  return {
    event: 'transaction.updated',
    timestamp,
    signature: { checksum, properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'] },
    data: {
      transaction: {
        id, status, amount_in_cents: amount,
        reference: 'pol-1',
        payment_method_type: 'CARD',
        created_at: new Date().toISOString(),
      },
    },
  } as any;
}

// ── Unit tests ────────────────────────────────────────────────────────────────

describe('WompiService — enabled flag', () => {
  it('is enabled when all required env vars are set', () => {
    const service = new WompiService(makeConfig());
    expect(service.isEnabled).toBe(true);
  });

  it('is disabled when WOMPI_PRIVATE_KEY missing', () => {
    const service = new WompiService(makeConfig({ WOMPI_PRIVATE_KEY: '' }));
    expect(service.isEnabled).toBe(false);
  });

  it('is disabled when WOMPI_EVENTS_SECRET missing', () => {
    const service = new WompiService(makeConfig({ WOMPI_EVENTS_SECRET: '' }));
    expect(service.isEnabled).toBe(false);
  });

  it('does not throw when all keys are missing (graceful startup)', () => {
    expect(() => new WompiService(makeConfig({
      WOMPI_ENVIRONMENT: '',
      WOMPI_PRIVATE_KEY: '',
      WOMPI_EVENTS_SECRET: '',
    }))).not.toThrow();
  });
});

describe('WompiService — validateWebhookSignature', () => {
  it('returns true for a valid signature', () => {
    const service = new WompiService(makeConfig());
    expect(service.validateWebhookSignature(makeEvent())).toBe(true);
  });

  it('returns false for a tampered checksum', () => {
    const service = new WompiService(makeConfig());
    const event = makeEvent();
    event.signature.checksum = 'deadbeef';
    expect(service.validateWebhookSignature(event)).toBe(false);
  });

  it('returns false when amount is tampered', () => {
    const service = new WompiService(makeConfig());
    const event = makeEvent({ amount: 5000000 });
    event.data.transaction.amount_in_cents = 1; // tampered
    expect(service.validateWebhookSignature(event)).toBe(false);
  });

  it('returns false when status is tampered', () => {
    const service = new WompiService(makeConfig());
    const event = makeEvent({ status: 'APPROVED' });
    event.data.transaction.status = 'DECLINED'; // tampered
    expect(service.validateWebhookSignature(event)).toBe(false);
  });

  it('returns false when eventsSecret is empty', () => {
    const service = new WompiService(makeConfig({ WOMPI_EVENTS_SECRET: '' }));
    expect(service.validateWebhookSignature(makeEvent())).toBe(false);
  });

  it('returns false when wrong secret used to generate checksum', () => {
    const service = new WompiService(makeConfig({ WOMPI_EVENTS_SECRET: 'correct_secret' }));
    const event = makeEvent({ secret: 'wrong_secret' });
    expect(service.validateWebhookSignature(event)).toBe(false);
  });
});

describe('WompiService — extractTransactionData', () => {
  it('correctly maps all fields from the webhook event', () => {
    const service = new WompiService(makeConfig());
    const event = makeEvent({ id: 'txn-abc', status: 'APPROVED', amount: 1806000 });
    const result = service.extractTransactionData(event);

    expect(result.transactionId).toBe('txn-abc');
    expect(result.status).toBe('APPROVED');
    expect(result.amountInCents).toBe(1806000);
    expect(result.reference).toBe('pol-1');
  });
});

describe('WompiService — createPaymentLink throws when disabled', () => {
  it('throws when Wompi is not configured', async () => {
    const service = new WompiService(makeConfig({ WOMPI_PRIVATE_KEY: '', WOMPI_EVENTS_SECRET: '' }));
    await expect(
      service.createPaymentLink({ policyId: 'p1', productName: 'Test', amountCOP: 20000, expiresInMinutes: 30 }),
    ).rejects.toThrow('Wompi not configured');
  });
});

// ── Fuzz tests ────────────────────────────────────────────────────────────────

describe('WompiService FUZZ — signature validation', () => {
  it('invariant: valid event always validates correctly regardless of amount', () => {
    const service = new WompiService(makeConfig());
    const amounts = [100, 5000000, 18060000, 100000000, 1];
    for (const amount of amounts) {
      expect(service.validateWebhookSignature(makeEvent({ amount }))).toBe(true);
    }
  });

  it('invariant: any single-character change to checksum fails validation', () => {
    const service = new WompiService(makeConfig());
    const event = makeEvent();
    const original = event.signature.checksum;
    // Flip the first character
    event.signature.checksum = (original[0] === 'a' ? 'b' : 'a') + original.slice(1);
    expect(service.validateWebhookSignature(event)).toBe(false);
  });
});
