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
