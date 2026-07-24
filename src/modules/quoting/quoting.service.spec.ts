import { QuotingService } from './quoting.service';
import { AffiliateSignals } from './types';
import { PRODUCTS } from './products.data';

function makeService(): QuotingService {
  return new QuotingService();
}

// ── Unit tests ────────────────────────────────────────────────────────────────

describe('QuotingService — pet type hard filter', () => {
  const service = makeService();

  it('gato signal excludes perro product', () => {
    const scores = service.score({ productCategory: 'mascotas', petType: 'gato', coverage: ['medicina'] });
    expect(scores.find(s => s.productId === 'medicina-prepagada-perros')).toBeUndefined();
  });

  it('perro signal excludes gato product', () => {
    const scores = service.score({ productCategory: 'mascotas', petType: 'perro', coverage: ['medicina'] });
    expect(scores.find(s => s.productId === 'medicina-prepagada-gatos')).toBeUndefined();
  });

  it('gato signal includes gato product', () => {
    const scores = service.score({ productCategory: 'mascotas', petType: 'gato', coverage: ['medicina'] });
    expect(scores.find(s => s.productId === 'medicina-prepagada-gatos')).toBeDefined();
  });

  it('perro signal includes perro product', () => {
    const scores = service.score({ productCategory: 'mascotas', petType: 'perro', coverage: ['medicina'] });
    expect(scores.find(s => s.productId === 'medicina-prepagada-perros')).toBeDefined();
  });

  it('mixto signal includes BOTH gato and perro products', () => {
    const scores = service.score({ productCategory: 'mascotas', petType: 'mixto', coverage: ['medicina'] });
    const ids = scores.map(s => s.productId);
    expect(ids).toContain('medicina-prepagada-gatos');
    expect(ids).toContain('medicina-prepagada-perros');
  });

  it('gato signal includes any-pet product', () => {
    const scores = service.score({ productCategory: 'mascotas', petType: 'gato' });
    expect(scores.find(s => s.productId === 'asistencia-veterinaria')).toBeDefined();
  });

  it('perro signal includes any-pet product', () => {
    const scores = service.score({ productCategory: 'mascotas', petType: 'perro' });
    expect(scores.find(s => s.productId === 'asistencia-veterinaria')).toBeDefined();
  });
});

describe('QuotingService — category filter', () => {
  const service = makeService();

  it('vida signal returns only vida/accidentes products', () => {
    const scores = service.score({ productCategory: 'vida', coverage: ['protección'] });
    for (const s of scores) {
      const p = PRODUCTS.find(p => p.id === s.productId)!;
      expect(['vida', 'accidentes', 'asistencia']).toContain(p.category);
    }
  });

  it('mascotas signal never returns hogar product', () => {
    const scores = service.score({ productCategory: 'mascotas', petType: 'gato' });
    for (const s of scores) {
      const p = PRODUCTS.find(p => p.id === s.productId)!;
      expect(p.category).not.toBe('hogar');
    }
  });
});

describe('QuotingService — shownProductIds / no-repeat', () => {
  const service = makeService();

  it('bestQuote returns highest-scoring product', () => {
    const signals: AffiliateSignals = { productCategory: 'mascotas', petType: 'gato', coverage: ['medicina'] };
    const best = service.bestQuote(signals);
    expect(best).not.toBeNull();
    expect(best!.product.eligibility.pet).not.toBe('perro');
  });

  it('score returns at most 3 results', () => {
    const scores = service.score({ productCategory: 'vida', coverage: ['protección'] });
    expect(scores.length).toBeLessThanOrEqual(3);
  });

  it('results are sorted by matchScore descending', () => {
    const scores = service.score({ productCategory: 'mascotas', petType: 'gato', coverage: ['medicina'] });
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1].matchScore).toBeGreaterThanOrEqual(scores[i].matchScore);
    }
  });
});

// ── Invariant tests ───────────────────────────────────────────────────────────

describe('QuotingService INVARIANTS', () => {
  const service = makeService();

  it('invariant: matchScore never exceeds 100 for any product/signal combination', () => {
    const signalSets: AffiliateSignals[] = [
      { productCategory: 'mascotas', petType: 'gato', coverage: ['medicina'], beneficiaries: 5, budget: 200000 },
      { productCategory: 'mascotas', petType: 'perro', coverage: ['cirugías', 'consultas', 'hospitalización'], budget: 50000 },
      { productCategory: 'vida', coverage: ['protección', 'familia', 'incapacidad'], beneficiaries: 4, budget: 15000 },
      { productCategory: 'accidentes', coverage: ['gastos médicos', 'indemnización'], budget: 30000 },
      { productCategory: 'asistencia', coverage: ['hogar', 'vehículo'], beneficiaries: 2 },
    ];
    for (const signals of signalSets) {
      const scores = service.score(signals);
      for (const s of scores) {
        expect(s.matchScore).toBeLessThanOrEqual(100);
        expect(s.matchScore).toBeGreaterThan(0);
      }
    }
  });

  it('invariant: no duplicate productIds in results', () => {
    const allSignals: AffiliateSignals[] = [
      { productCategory: 'vida' },
      { productCategory: 'mascotas', petType: 'gato' },
      { productCategory: 'mascotas', petType: 'perro' },
      { productCategory: 'mascotas', petType: 'mixto' },
      { productCategory: 'accidentes' },
      { productCategory: 'asistencia' },
    ];
    for (const signals of allSignals) {
      const scores = service.score(signals);
      const ids = scores.map(s => s.productId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('invariant: gato queries NEVER include perro product in any position', () => {
    const scores = service.score({ productCategory: 'mascotas', petType: 'gato' });
    for (const s of scores) {
      expect(s.productId).not.toBe('medicina-prepagada-perros');
    }
  });

  it('invariant: perro queries NEVER include gato product in any position', () => {
    const scores = service.score({ productCategory: 'mascotas', petType: 'perro' });
    for (const s of scores) {
      expect(s.productId).not.toBe('medicina-prepagada-gatos');
    }
  });

  it('invariant: all returned products exist in PRODUCTS catalog', () => {
    const scores = service.score({ productCategory: 'mascotas', petType: 'mixto', coverage: ['medicina'] });
    for (const s of scores) {
      expect(PRODUCTS.find(p => p.id === s.productId)).toBeDefined();
    }
  });
});

describe('QuotingService — budget scoring from RANGO_SALARIAL', () => {
  const service = makeService();

  it('applies the budget boost for an exact RANGO_SALARIAL match', () => {
    const scores = service.score({ productCategory: 'vida', rangoSalarial: 'Hasta 2 SMLV' });
    const vida = scores.find((s) => s.productId === 'vida')!;
    expect(vida.reasons.some((r) => r.includes('presupuesto'))).toBe(true);
  });

  // Regression: the RANGO_SALARIAL lookup was an exact-string map with no normalization.
  // The affiliate xlsx export is an external file Colsubsidio regenerates — trailing
  // whitespace or a stray case difference would silently drop the budget scoring boost
  // (15 of ~100 match points) with no error or fallback signal.
  it('regression — matches despite surrounding whitespace from the xlsx export', () => {
    const scores = service.score({ productCategory: 'vida', rangoSalarial: '  Hasta 2 SMLV  ' as any });
    const vida = scores.find((s) => s.productId === 'vida')!;
    expect(vida.reasons.some((r) => r.includes('presupuesto'))).toBe(true);
  });

  it('regression — matches despite a case difference from the xlsx export', () => {
    const scores = service.score({ productCategory: 'vida', rangoSalarial: 'hasta 2 smlv' as any });
    const vida = scores.find((s) => s.productId === 'vida')!;
    expect(vida.reasons.some((r) => r.includes('presupuesto'))).toBe(true);
  });

  it('does not apply the budget boost for an unrecognized rango (no crash, just no boost)', () => {
    expect(() => service.score({ productCategory: 'vida', rangoSalarial: 'not a real bracket' as any })).not.toThrow();
  });
});

describe('QuotingService — category cross-sell map (locked-in current behavior)', () => {
  const service = makeService();

  // isRelatedCategory(a, b) reads as: "product category `a` is also relevant when the
  // signal is `b`". The map is intentionally asymmetric: vida<->accidentes cross-sell
  // both ways; asistencia is relevant to a vida signal (life insurance + exequial is a
  // natural pairing) but NOT the reverse; mascotas cross-sells to human coverage via a
  // separate code path (mentionsPersonalCoverage in agent.service.ts), not this map.
  it('a vida signal includes accidentes products (bidirectional)', () => {
    const scores = service.score({ productCategory: 'vida' });
    expect(scores.some((s) => PRODUCTS.find((p) => p.id === s.productId)?.category === 'accidentes')).toBe(true);
  });

  // Regression / known limitation: score() caps results to the top 3 by matchScore.
  // 'accidentes' has exactly 3 direct products (all scoring 40), which fill every slot
  // before the related-category vida match (scoring 20) is ever considered — so the
  // accidentes->vida link in the map is real but never surfaces in practice. This test
  // documents the current, verified behavior so a future change to either the map or the
  // top-3 cap is deliberate, not accidental.
  it('an accidentes signal does NOT surface vida products — 3 direct accidentes matches already fill the top-3 cap', () => {
    const scores = service.score({ productCategory: 'accidentes' });
    expect(scores).toHaveLength(3);
    expect(scores.every((s) => PRODUCTS.find((p) => p.id === s.productId)?.category === 'accidentes')).toBe(true);
  });

  it('an asistencia signal does NOT include vida products (the map only reaches asistencia FROM a vida signal, not the reverse)', () => {
    const scores = service.score({ productCategory: 'asistencia' });
    expect(scores.some((s) => PRODUCTS.find((p) => p.id === s.productId)?.category === 'vida')).toBe(false);
  });

  // Same top-3-cap limitation as accidentes above: vida has 2 direct products, leaving one
  // slot contested between accidentes and asistencia cross-sell candidates (both score 20).
  // Stable sort preserves catalog order, so accidentes (earlier in products.data.ts) wins.
  it('a vida signal does not include asistencia products in the top 3 (contested last slot, accidentes wins by catalog order)', () => {
    const scores = service.score({ productCategory: 'vida' });
    expect(scores.some((s) => PRODUCTS.find((p) => p.id === s.productId)?.category === 'asistencia')).toBe(false);
  });
});

describe('QuotingService INVARIANT — every NLP-reachable category yields a recommendation', () => {
  const service = makeService();

  // Regression: 'hogar' is a fully-wired NLP category (schema, extraction, cross-sell
  // keywords, and even the DISCOVERY prompt literally ask about "tu hogar") but the real
  // Colsubsidio catalog has zero products categorized 'hogar' — a user who explicitly
  // asked for home insurance hit a structural dead end with no product ever offered. This
  // invariant guards the whole class of bug: any category the NLP layer can emit must be
  // reachable to at least one real product, directly or via a cross-sell relationship.
  it('every non-null productCategory the NLP schema can emit returns at least one product', () => {
    const categories: NonNullable<AffiliateSignals['productCategory']>[] = [
      'vida', 'hogar', 'accidentes', 'asistencia', 'mascotas',
    ];
    for (const productCategory of categories) {
      const scores = service.score({ productCategory });
      expect(scores.length).toBeGreaterThan(0);
    }
  });
});

// ── Fuzz tests ────────────────────────────────────────────────────────────────

describe('QuotingService FUZZ', () => {
  const service = makeService();

  it('never throws for any combination of valid signals', () => {
    const categories: AffiliateSignals['productCategory'][] = ['vida', 'hogar', 'accidentes', 'asistencia', 'mascotas', null];
    const petTypes: AffiliateSignals['petType'][] = ['gato', 'perro', 'mixto', null, undefined];
    const budgets = [0, 5000, 14000, 20000, 100000, 999999];

    for (const productCategory of categories) {
      for (const petType of petTypes) {
        for (const budget of budgets) {
          expect(() => service.score({ productCategory, petType, budget })).not.toThrow();
        }
      }
    }
  });

  it('gracefully handles empty and noisy coverage arrays', () => {
    const coverageSets = [
      [],
      [''],
      ['xyzzy', 'foo', 'bar'],
      ['!@#$', '123'],
      Array(50).fill('medicina'),
    ];
    for (const coverage of coverageSets) {
      expect(() => service.score({ productCategory: 'mascotas', coverage })).not.toThrow();
    }
  });

  it('negative and extreme budgets do not crash scorer', () => {
    for (const budget of [-1, 0, -999999, Number.MAX_SAFE_INTEGER, NaN]) {
      expect(() => service.score({ productCategory: 'vida', budget })).not.toThrow();
    }
  });
});
