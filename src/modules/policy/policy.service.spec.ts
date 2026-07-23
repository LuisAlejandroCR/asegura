import { PolicyService } from './policy.service';

function makeSupabaseMock(overrides: { data?: unknown; error?: unknown } = {}) {
  const maybeSingle = jest.fn().mockResolvedValue({ data: overrides.data ?? null, error: overrides.error ?? null });
  const eq = jest.fn().mockReturnValue({ maybeSingle });
  const select = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ select });
  return { db: { from } } as any;
}

function makePdfMock() {
  return { generate: jest.fn().mockResolvedValue(Buffer.from('%PDF-fake')) } as any;
}

describe('PolicyService.findById', () => {
  it('returns the policy row when found', async () => {
    const row = {
      id: 'pol-1', conversation_id: 'conv-1', product_id: 'asistencia-veterinaria',
      cedula: '123456789', nombre: 'Juan Pérez', email: 'juan@test.com',
      monthly_premium: 14500, status: 'pending_payment',
      wompi_link_id: null, celo_tx_hash: null,
      created_at: '2026-07-23T00:00:00Z', updated_at: '2026-07-23T00:00:00Z',
    };
    const supabase = makeSupabaseMock({ data: row });
    const service = new PolicyService(supabase, makePdfMock());
    const result = await service.findById('pol-1');
    expect(result).toEqual(row);
  });

  it('returns null when the policy does not exist (no PGRST116 noise)', async () => {
    const supabase = makeSupabaseMock({ data: null, error: null });
    const service = new PolicyService(supabase, makePdfMock());
    const result = await service.findById('missing-id');
    expect(result).toBeNull();
  });

  it('returns null and logs when Supabase errors, does not throw', async () => {
    const supabase = makeSupabaseMock({ data: null, error: { message: 'connection failed' } });
    const service = new PolicyService(supabase, makePdfMock());
    await expect(service.findById('pol-1')).resolves.toBeNull();
  });
});

describe('PolicyService.findByWompiLinkId', () => {
  // Wompi's Payment Links API has no "reference" field — the webhook's transaction
  // carries payment_link_id, which we must be able to match back to our policy.
  it('returns the policy row matching the given wompi_link_id', async () => {
    const row = {
      id: 'pol-1', conversation_id: 'conv-1', product_id: 'asistencia-veterinaria',
      cedula: '123456789', nombre: 'Juan Pérez', email: 'juan@test.com',
      monthly_premium: 14500, status: 'pending_payment',
      wompi_link_id: 'link-abc-123', celo_tx_hash: null,
      created_at: '2026-07-23T00:00:00Z', updated_at: '2026-07-23T00:00:00Z',
    };
    const supabase = makeSupabaseMock({ data: row });
    const service = new PolicyService(supabase, makePdfMock());
    const result = await service.findByWompiLinkId('link-abc-123');
    expect(result).toEqual(row);
  });

  it('returns null when no policy matches', async () => {
    const supabase = makeSupabaseMock({ data: null, error: null });
    const service = new PolicyService(supabase, makePdfMock());
    await expect(service.findByWompiLinkId('unknown-link')).resolves.toBeNull();
  });
});

describe('PolicyService.generateFinalPdf', () => {
  const policy = {
    id: 'pol-1', conversation_id: 'conv-1', product_id: 'asistencia-veterinaria',
    cedula: '123456789', nombre: 'Juan Pérez', email: 'juan@test.com',
    monthly_premium: 14500, status: 'active',
    wompi_link_id: 'txn-1', celo_tx_hash: '0xabc',
    created_at: '2026-07-23T00:00:00Z', updated_at: '2026-07-23T00:00:00Z',
  };

  it('generates a PDF passing the real celoscanUrl through to PdfService', async () => {
    const pdf = makePdfMock();
    const service = new PolicyService(makeSupabaseMock(), pdf);
    const buffer = await service.generateFinalPdf(policy, 'https://celoscan.io/tx/0xabc');
    expect(buffer).not.toBeNull();
    expect(pdf.generate).toHaveBeenCalledWith(
      expect.objectContaining({ policyId: 'pol-1', celoscanUrl: 'https://celoscan.io/tx/0xabc', productName: 'Asistencia veterinaria' }),
    );
  });

  it('returns null when the product_id does not match any known product', async () => {
    const service = new PolicyService(makeSupabaseMock(), makePdfMock());
    const result = await service.generateFinalPdf({ ...policy, product_id: 'unknown-product' }, 'https://celoscan.io/tx/0xabc');
    expect(result).toBeNull();
  });

  it('returns null (not throw) when PdfService.generate rejects', async () => {
    const pdf = { generate: jest.fn().mockRejectedValue(new Error('pdf boom')) };
    const service = new PolicyService(makeSupabaseMock(), pdf as any);
    await expect(service.generateFinalPdf(policy, 'https://celoscan.io/tx/0xabc')).resolves.toBeNull();
  });
});
