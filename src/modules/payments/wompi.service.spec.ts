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

// Resolves a dotted path (e.g. "transaction.id") against the event's `data` object —
// mirrors Wompi's real webhook signature algorithm (docs.wompi.co/docs/colombia/eventos/),
// which explicitly states the `properties` set and order "pueden variar en el tiempo y en
// cada evento" (can vary over time and per event) and must be read dynamically, never
// hardcoded to a fixed field list.
function resolvePath(data: unknown, path: string): string {
  const value = path.split('.').reduce((acc: any, key) => acc?.[key], data);
  return value === undefined || value === null ? '' : String(value);
}

function makeEvent(overrides: {
  id?: string; status?: string; amount?: number; timestamp?: number; secret?: string;
  paymentLinkId?: string; properties?: string[];
} = {}): WompiWebhookEvent {
  const id = overrides.id ?? 'txn-1';
  const status = overrides.status ?? 'APPROVED';
  const amount = overrides.amount ?? 5000000;
  const timestamp = overrides.timestamp ?? 1700000000;
  const secret = overrides.secret ?? 'secret123';
  const properties = overrides.properties ?? ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'];

  const data = {
    transaction: {
      id, status, amount_in_cents: amount,
      reference: 'auto-generated-by-wompi',
      payment_link_id: overrides.paymentLinkId ?? 'link-abc',
      payment_method_type: 'CARD',
      created_at: new Date().toISOString(),
    },
  };

  const concatenated = properties.map((p) => resolvePath(data, p)).join('');
  const checksum = createHash('sha256')
    .update(`${concatenated}${timestamp}${secret}`)
    .digest('hex');

  return {
    event: 'transaction.updated',
    timestamp,
    signature: { checksum, properties },
    data,
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

describe('WompiService — validateWebhookSignature reads properties dynamically', () => {
  // Real bug found during audit: the code hardcoded the concatenation order to
  // transaction.id + transaction.status + transaction.amount_in_cents. Wompi's own docs
  // warn this set/order "pueden variar en el tiempo y en cada evento" — if a live webhook
  // ever sent a different order or an extra field, every signature check would silently
  // fail and NO real payment would ever be confirmed. The event's own signature.properties
  // must be the source of truth, not an assumption baked into the code.

  it('validates correctly when properties are given in a different order', () => {
    const service = new WompiService(makeConfig());
    const event = makeEvent({ properties: ['transaction.status', 'transaction.id'] });
    expect(service.validateWebhookSignature(event)).toBe(true);
  });

  it('validates correctly with a different/larger set of properties', () => {
    const service = new WompiService(makeConfig());
    const event = makeEvent({
      properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents', 'transaction.payment_method_type'],
    });
    expect(service.validateWebhookSignature(event)).toBe(true);
  });

  it('validates correctly with just a single property', () => {
    const service = new WompiService(makeConfig());
    const event = makeEvent({ properties: ['transaction.id'] });
    expect(service.validateWebhookSignature(event)).toBe(true);
  });

  it('rejects a checksum computed with the wrong property order (tamper-evident)', () => {
    const service = new WompiService(makeConfig());
    const event = makeEvent({ properties: ['transaction.status', 'transaction.id'] });
    // Attacker/bug reorders the DECLARED properties without recomputing the checksum
    event.signature.properties = ['transaction.id', 'transaction.status'];
    expect(service.validateWebhookSignature(event)).toBe(false);
  });

  it('returns false when signature.properties is empty (nothing to verify against)', () => {
    const service = new WompiService(makeConfig());
    const event = makeEvent({ properties: [] });
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
  });

  it('regression — maps paymentLinkId, NOT reference, as the field used to find our policy', () => {
    // Wompi's Payment Links API has no "reference" create-parameter — the transaction's
    // reference is auto-generated by Wompi and unrelated to our internal policyId.
    // payment_link_id is the reliable foreign key back to the link we created.
    const service = new WompiService(makeConfig());
    const event = makeEvent({ paymentLinkId: 'link-xyz-789' });
    const result = service.extractTransactionData(event);
    expect(result.paymentLinkId).toBe('link-xyz-789');
  });

  it('paymentLinkId is null when the webhook payload omits it', () => {
    const service = new WompiService(makeConfig());
    const event = makeEvent();
    delete (event.data.transaction as any).payment_link_id;
    expect(service.extractTransactionData(event).paymentLinkId).toBeNull();
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

describe('WompiService — createPaymentLink success shape', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('returns both checkoutUrl and paymentLinkId (not a bare string)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: 'link-abc-123', name: 'Test', active: true } }),
    }) as any;

    const service = new WompiService(makeConfig());
    const result = await service.createPaymentLink({
      policyId: 'pol-1', productName: 'Test', amountCOP: 20000, expiresInMinutes: 30,
    });

    expect(result.paymentLinkId).toBe('link-abc-123');
    expect(result.checkoutUrl).toBe('https://checkout.wompi.co/l/link-abc-123');
  });

  it('regression — sends expires_at in the ISO 8601 "T" format Wompi requires, not "Y-M-D H:M:S"', async () => {
    // Real production bug: Wompi rejected our links with 422 "expires_at: Debe ser tipo
    // date time" — the code did .replace('T', ' '), producing "2026-07-23 20:22:56"
    // instead of the required "2026-07-23T20:22:56" (confirmed against docs.wompi.co).
    let capturedBody: any;
    global.fetch = jest.fn().mockImplementation((_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: async () => ({ data: { id: 'link-1', name: 'Test', active: true } }) });
    }) as any;

    const service = new WompiService(makeConfig());
    await service.createPaymentLink({
      policyId: 'pol-1', productName: 'Test', amountCOP: 20000, expiresInMinutes: 30,
    });

    expect(capturedBody.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(capturedBody.expires_at).not.toContain(' ');
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
