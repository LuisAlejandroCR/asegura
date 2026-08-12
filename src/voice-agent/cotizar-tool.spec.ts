// cotizar-tool.spec.ts: the core regla #5 guarantee for voice — cotizarLogic never
// invents a price or product name, only ever returns exactly what QuotingService's real
// scoring engine produces. No LiveKit runtime involved; this tests the pure function
// createCotizarTool wraps.

import { QuotingService } from '../modules/quoting/quoting.service';
import { ProductCatalog } from '../modules/quoting/product-catalog.service';
import { cotizarLogic, cotizarParams } from './cotizar-tool';

describe('cotizarLogic', () => {
  const quoting = new QuotingService(new ProductCatalog());

  it('returns a real product from the catalog for a vida profile, never a fabricated one', () => {
    const result = cotizarLogic(quoting, { productCategory: 'vida', dependents: 2 });
    expect(result.encontrado).toBe(true);

    // The whole point of this tool: every field traces back to the real catalog, not
    // something the LLM could have hallucinated.
    const catalogProducts = new ProductCatalog().getProducts();
    const match = catalogProducts.find((p) => p.name === result.producto);
    expect(match).toBeDefined();
    expect(result.aseguradora).toBe(match!.insurer);
    expect(result.precioMensual).toBeGreaterThan(0);
  });

  // QuotingService.bestQuote only returns null when the catalog itself has nothing to
  // score — the real catalog always has 11 products, so this is exercised with an empty
  // stub catalog to prove cotizarLogic passes the null through honestly instead of
  // fabricating a fallback product.
  it('returns encontrado:false instead of guessing when the catalog has nothing to score', () => {
    const emptyQuoting = new QuotingService({ getProducts: () => [], getProduct: () => undefined });
    const result = cotizarLogic(emptyQuoting, { productCategory: 'vida' });
    expect(result.encontrado).toBe(false);
    expect(result.producto).toBeUndefined();
    expect(result.precioMensual).toBeUndefined();
  });

  it('filters mascotas quotes by petType exactly like the text flow does', () => {
    const gato = cotizarLogic(quoting, { productCategory: 'mascotas', petType: 'gato' });
    expect(gato.producto).toMatch(/gato/i);
    const perro = cotizarLogic(quoting, { productCategory: 'mascotas', petType: 'perro' });
    expect(perro.producto).toMatch(/perro/i);
  });

  // Regla #5 in one assertion: the returned reason is one of QuotingService's own
  // generated strings, never text this tool composed itself.
  it('the reason field comes from QuotingService, not from this tool', () => {
    const result = cotizarLogic(quoting, { productCategory: 'vida', dependents: 3, budget: 20000 });
    const scores = quoting.score({ productCategory: 'vida', dependents: 3, budget: 20000 });
    const matchingScore = scores.find((s) => s.reasons[0] === result.razon);
    expect(matchingScore).toBeDefined();
  });
});

describe('cotizarParams schema', () => {
  it('accepts a well-formed voice-gathered profile', () => {
    const parsed = cotizarParams.safeParse({ productCategory: 'accidentes', dependents: 0, budget: null });
    expect(parsed.success).toBe(true);
  });

  it('rejects a category the real catalog does not sell — no silent coercion to null', () => {
    const parsed = cotizarParams.safeParse({ productCategory: 'vehicular' });
    expect(parsed.success).toBe(false);
  });
});
