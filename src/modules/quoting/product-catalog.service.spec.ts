// product-catalog.service.spec.ts: checks the real catalog loads and validates, and pins
// the 11 published prices so a YAML edit can never move one silently.

import { ProductCatalog } from './product-catalog.service';
import { InsuranceProduct } from './types';

// Transcribed from colsubsidio.com/seguros (CLAUDE.md § Productos MVP), in catalog order.
// This replaced a full copy of every product object: only the price is worth pinning by
// hand, and rule #12 says it must come from the published page, never from the code.
const PRECIOS_PUBLICADOS: [string, number][] = [
  ['accidentes-personales', 18000],
  ['accidentes-premium', 28100],
  ['vida', 12000],
  ['asistencias-multiples', 20000],
  ['exequial', 26000],
  ['accidentes-exequial', 14000],
  ['vida-ahorro', 20000],
  ['asistencias-medicas', 16800],
  ['asistencia-veterinaria', 14500],
  ['medicina-prepagada-gatos', 81800],
  ['medicina-prepagada-perros', 96600],
];

function makeValidFixture(overrides: Partial<InsuranceProduct> = {}): InsuranceProduct {
  return { id: 'x', name: 'X', category: 'vida', insurer: 'Y', basePremium: 10000, url: 'https://x', coverages: [], eligibility: {}, ...overrides };
}

describe('ProductCatalog — real data', () => {
  it('constructs without throwing against the real catalog/products/*.yaml', () => {
    expect(() => new ProductCatalog()).not.toThrow();
  });

  it('getProducts() returns the 11 real products in catalog order', () => {
    const catalog = new ProductCatalog();
    expect(catalog.getProducts().map((p) => p.id)).toEqual(PRECIOS_PUBLICADOS.map(([id]) => id));
  });

  // A price is the one field a quote is judged on, so a YAML typo has to fail here.
  it('every price matches the one published on colsubsidio.com/seguros', () => {
    const catalog = new ProductCatalog();
    expect(catalog.getProducts().map((p) => [p.id, p.basePremium])).toEqual(PRECIOS_PUBLICADOS);
  });

  // Proves the 13 not-yet-migrated YAML files (SOAT, vehicular, etc. — company: null,
  // public_price: null, requires_quote: true) are gracefully excluded, not accidentally
  // included as incomplete products.
  it('loads exactly 11 products — the not-yet-priced catalog files are excluded', () => {
    const catalog = new ProductCatalog();
    expect(catalog.getProducts().length).toBe(11);
  });

  it('getProduct(id) finds an existing product', () => {
    expect(new ProductCatalog().getProduct('vida')?.name).toBe('Seguro de vida');
  });

  it('getProduct(id) returns undefined for an unknown id', () => {
    expect(new ProductCatalog().getProduct('nope')).toBeUndefined();
  });

  it('getProducts() returns a defensive copy — mutating it does not affect a later call', () => {
    const catalog = new ProductCatalog();
    catalog.getProducts().push(makeValidFixture());
    expect(catalog.getProducts().length).toBe(PRECIOS_PUBLICADOS.length);
  });
});

describe('ProductCatalog — validate()', () => {
  const catalog = new ProductCatalog();

  it('does not throw for the real catalog', () => {
    expect(() => catalog.validate()).not.toThrow();
  });

  it('throws on an empty catalog', () => {
    expect(() => catalog.validate([])).toThrow(/empty/);
  });

  it('throws on a duplicate id', () => {
    const dup = makeValidFixture({ id: 'dup' });
    expect(() => catalog.validate([dup, { ...dup }])).toThrow(/duplicate/i);
  });

  it('throws on a non-positive basePremium', () => {
    expect(() => catalog.validate([makeValidFixture({ basePremium: 0 })])).toThrow(/basePremium/);
  });

  it('throws when eligibility is missing', () => {
    const bad = makeValidFixture();
    delete (bad as any).eligibility;
    expect(() => catalog.validate([bad])).toThrow(/eligibility/);
  });

  it('throws when coverages is not an array', () => {
    expect(() => catalog.validate([makeValidFixture({ coverages: undefined as any })])).toThrow(/coverages/);
  });

  it('throws on an invalid eligibility.pet value', () => {
    expect(() => catalog.validate([makeValidFixture({ eligibility: { pet: 'GATO' } })])).toThrow(/eligibility\.pet/);
  });

  it('aggregates multiple errors into a single thrown message', () => {
    const dup = makeValidFixture({ id: 'dup', basePremium: -1 });
    expect(() => catalog.validate([dup, { ...dup, basePremium: 5000 }])).toThrow(/duplicate/i);
  });
});
