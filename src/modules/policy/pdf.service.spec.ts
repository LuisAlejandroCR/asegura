import { PdfService } from './pdf.service';

// Regression: pdfkit's default export ships no `.default` property, so
// `import PDFDocument from 'pdfkit'` compiled under commonjs (no esModuleInterop)
// produced `new undefined()` at runtime — "pdfkit_1.default is not a constructor" —
// crashing every policy issuance. This test exercises the real constructor call.

function baseData(overrides: Partial<Parameters<PdfService['generate']>[0]> = {}) {
  return {
    policyId: 'pol-12345678',
    productName: 'Asistencia veterinaria',
    insurer: 'GEA',
    coverages: ['Consulta veterinaria', 'Refuerzo de vacunación'],
    nombre: 'Juan Pérez',
    cedula: '123456789',
    email: 'juan@example.com',
    monthlyPremium: 14500,
    issuedAt: new Date('2026-07-23'),
    ...overrides,
  };
}

describe('PdfService.generate', () => {
  const service = new PdfService();

  it('resolves with a non-empty PDF Buffer without throwing', async () => {
    const buffer = await service.generate(baseData());
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    // A real PDF starts with the %PDF- magic header
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('still generates a valid PDF when celoscanUrl is provided (blockchain audit QR)', async () => {
    const buffer = await service.generate(baseData({ celoscanUrl: 'https://celoscan.io/tx/0xabc123' }));
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('still generates a valid PDF when email is omitted', async () => {
    const buffer = await service.generate(baseData({ email: undefined }));
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

// ── petCount pricing display ───────────────────────────────────────────────────
// Real bug: the chat quote correctly showed "$14.500/mes por mascota, Total para 3
// mascotas: $43.500/mes", but the PDF's PRIMA MENSUAL box always showed a flat single
// price — PdfService never received petCount at all, so it had no way to know.

describe('PdfService — petCount pricing display', () => {
  const service = new PdfService();

  function buildPremiumLines(monthlyPremium: number, petCount?: number | null): { primary: string; total: string | null } {
    return (service as any).buildPremiumLines(monthlyPremium, petCount);
  }

  it('shows only the flat price when petCount is absent', () => {
    const lines = buildPremiumLines(14500, undefined);
    expect(lines.primary).toContain('14.500');
    expect(lines.total).toBeNull();
  });

  it('shows only the flat price when petCount is 1', () => {
    const lines = buildPremiumLines(14500, 1);
    expect(lines.total).toBeNull();
  });

  it('shows "por mascota" plus the correct total when petCount > 1', () => {
    const lines = buildPremiumLines(14500, 3);
    expect(lines.primary).toContain('por mascota');
    expect(lines.total).toContain('3 mascotas');
    expect(lines.total).toContain('43.500'); // 14500 * 3
  });

  it('still generates a valid PDF end-to-end when petCount is provided', async () => {
    const buffer = await service.generate(baseData({ petCount: 3 }));
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('still generates a valid PDF end-to-end when a pets table is provided', async () => {
    const buffer = await service.generate(baseData({
      petCount: 2,
      pets: [
        { name: 'Max', age: '3 años', breed: 'labrador' },
        { name: 'Luna', age: '2 años', breed: 'siamés' },
      ],
    }));
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('still generates a valid PDF when pets is an empty array', async () => {
    const buffer = await service.generate(baseData({ pets: [] }));
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

// ── resolveAuditUrl — QR target logic ─────────────────────────────────────────
// The Celo on-chain transaction isn't known until after payment, but the PDF is
// generated before payment. The QR must always encode a working audit URL: the
// real Celoscan tx once available, or the deterministic referenceURI (the same
// URI that later gets registered on-chain) as a stable fallback.

describe('PdfService.resolveAuditUrl', () => {
  const service = new PdfService();

  function resolveAuditUrl(policyId: string, celoscanUrl?: string): string {
    return (service as any).resolveAuditUrl(policyId, celoscanUrl);
  }

  it('uses the real celoscanUrl when provided', () => {
    expect(resolveAuditUrl('pol-123', 'https://celoscan.io/tx/0xabc')).toBe('https://celoscan.io/tx/0xabc');
  });

  it('falls back to the deterministic referenceURI when celoscanUrl is absent', () => {
    expect(resolveAuditUrl('pol-123')).toBe('https://asegura.co/poliza/pol-123');
  });
});
