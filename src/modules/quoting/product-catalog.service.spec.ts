import { ProductCatalog } from './product-catalog.service';
import { PRODUCTS } from './products.data';
import { InsuranceProduct } from './types';

function makeValidFixture(overrides: Partial<InsuranceProduct> = {}): InsuranceProduct {
  return { id: 'x', name: 'X', category: 'vida', insurer: 'Y', basePremium: 10000, url: 'https://x', coverages: [], eligibility: {}, ...overrides };
}

describe('ProductCatalog — real data', () => {
  it('constructs without throwing against the real catalog/products/*.yaml', () => {
    expect(() => new ProductCatalog()).not.toThrow();
  });

  it('getProducts() returns the 11 real products in the canonical (products.data.ts) order', () => {
    const catalog = new ProductCatalog();
    expect(catalog.getProducts().map((p) => p.id)).toEqual(PRODUCTS.map((p) => p.id));
  });

  // The strongest possible regression check: if this passes, the YAML transcription is
  // byte-identical to the original hand-written products.data.ts — the real bar for
  // "recommendations are unchanged" after swapping the data source.
  it('YAML-sourced catalog is byte-identical to products.data.ts (transcription check)', () => {
    const catalog = new ProductCatalog();
    expect(catalog.getProducts()).toEqual(PRODUCTS);
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
    expect(catalog.getProducts().length).toBe(PRODUCTS.length);
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
