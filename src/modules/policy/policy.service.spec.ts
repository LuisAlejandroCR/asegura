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

function makeInsertSupabaseMock(overrides: { data?: unknown; error?: unknown } = {}) {
  const single = jest.fn().mockResolvedValue({ data: overrides.data ?? { id: 'pol-1' }, error: overrides.error ?? null });
  const select = jest.fn().mockReturnValue({ single });
  const insert = jest.fn().mockReturnValue({ select });
  const from = jest.fn().mockReturnValue({ insert });
  return { supabase: { db: { from } } as any, insert };
}

describe('PolicyService.issue', () => {
  // The PDF is no longer generated/sent here — it was being attached to a message
  // BEFORE payment was ever confirmed (a real production bug: users received a
  // "policy PDF" for a policy they hadn't paid for). The only PDF the user should
  // ever receive is the one the Wompi webhook sends after payment is APPROVED.
  it('regression — does not call PdfService.generate at all', async () => {
    const pdf = makePdfMock();
    const { supabase } = makeInsertSupabaseMock();
    const service = new PolicyService(supabase, pdf);
    await service.issue('conv-1', { quoteProductId: 'asistencia-veterinaria', cedula: '123456789', nombre: 'Juan Pérez', email: 'juan@test.com' } as any);
    expect(pdf.generate).not.toHaveBeenCalled();
  });

  it('returns only policyId, no pdfBuffer field', async () => {
    const { supabase } = makeInsertSupabaseMock({ data: { id: 'pol-42' } });
    const service = new PolicyService(supabase, makePdfMock());
    const result = await service.issue('conv-1', { quoteProductId: 'asistencia-veterinaria', cedula: '123456789', nombre: 'Juan Pérez' } as any);
    expect(result).toEqual({ policyId: 'pol-42' });
  });

  it('regression — stores the correctly multiplied premium and pet_count for multi-pet households', async () => {
    // The chat quote and the actual Wompi charge were already fixed to multiply by
    // petCount — the stored policy record (and therefore the final PDF) must match.
    const { supabase, insert } = makeInsertSupabaseMock({ data: { id: 'pol-1' } });
    const service = new PolicyService(supabase, makePdfMock());
    await service.issue('conv-1', {
      quoteProductId: 'asistencia-veterinaria', cedula: '123456789', nombre: 'Juan Pérez', petCount: 3,
    } as any);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ monthly_premium: 43500, pet_count: 3 }),
    );
  });

  it('stores pet_count as null when not a multi-pet purchase', async () => {
    const { supabase, insert } = makeInsertSupabaseMock({ data: { id: 'pol-1' } });
    const service = new PolicyService(supabase, makePdfMock());
    await service.issue('conv-1', { quoteProductId: 'asistencia-veterinaria', cedula: '123456789', nombre: 'Juan Pérez' } as any);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ pet_count: null }));
  });
});

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
    wompi_link_id: 'txn-1', celo_tx_hash: '0xabc', pet_count: null,
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

  it('regression — passes the stored pet_count through so the PDF shows the correct per-pet total', async () => {
    // Real bug: the final PDF always showed a flat single-pet price because
    // PolicyPdfData never received petCount — the DB row is the only place it survives
    // between DATA_CAPTURE (chat) and the webhook (async, hours later).
    const pdf = makePdfMock();
    const service = new PolicyService(makeSupabaseMock(), pdf);
    await service.generateFinalPdf({ ...policy, pet_count: 3, monthly_premium: 43500 }, 'https://celoscan.io/tx/0xabc');
    expect(pdf.generate).toHaveBeenCalledWith(expect.objectContaining({ petCount: 3 }));
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
