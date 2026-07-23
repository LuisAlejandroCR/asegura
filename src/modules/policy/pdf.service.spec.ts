import { PdfService } from './pdf.service';

// Regression: pdfkit's default export ships no `.default` property, so
// `import PDFDocument from 'pdfkit'` compiled under commonjs (no esModuleInterop)
// produced `new undefined()` at runtime — "pdfkit_1.default is not a constructor" —
// crashing every policy issuance. This test exercises the real constructor call.

describe('PdfService.generate', () => {
  const service = new PdfService();

  it('resolves with a non-empty PDF Buffer without throwing', async () => {
    const buffer = await service.generate({
      policyId: 'pol-12345678',
      productName: 'Asistencia veterinaria',
      insurer: 'GEA',
      coverages: ['Consulta veterinaria', 'Refuerzo de vacunación'],
      nombre: 'Juan Pérez',
      cedula: '123456789',
      email: 'juan@example.com',
      monthlyPremium: 14500,
      issuedAt: new Date('2026-07-23'),
    });
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    // A real PDF starts with the %PDF- magic header
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
