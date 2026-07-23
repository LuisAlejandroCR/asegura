import { computeTotalPremium } from './pricing';
import { InsuranceProduct } from './types';

function makeProduct(overrides: Partial<InsuranceProduct> = {}): InsuranceProduct {
  return {
    id: 'test-product', name: 'Test', category: 'mascotas', insurer: 'GEA',
    basePremium: 14500, url: 'https://example.com', coverages: [], eligibility: {},
    ...overrides,
  };
}

describe('computeTotalPremium — unit tests', () => {
  it('returns basePremium unchanged for a single pet (petCount=1)', () => {
    expect(computeTotalPremium(makeProduct(), 1)).toBe(14500);
  });

  it('multiplies by petCount for mascotas products with multiple pets', () => {
    expect(computeTotalPremium(makeProduct(), 3)).toBe(43500);
  });

  it('returns basePremium unchanged when petCount is undefined', () => {
    expect(computeTotalPremium(makeProduct(), undefined)).toBe(14500);
  });

  it('returns basePremium unchanged when petCount is null', () => {
    expect(computeTotalPremium(makeProduct(), null)).toBe(14500);
  });

  it('does NOT multiply for non-mascotas categories even with petCount set', () => {
    // petCount would only ever be set for the mascotas flow, but guard the invariant anyway
    expect(computeTotalPremium(makeProduct({ category: 'vida' }), 3)).toBe(14500);
  });
});

describe('computeTotalPremium — invariants', () => {
  const basePremiums = [0, 1, 14500, 81800, 96600, 1_000_000];
  const petCounts = [0, 1, 2, 3, 5, 10, 20, undefined, null];

  it('invariant: result is always an integer multiple of basePremium', () => {
    for (const basePremium of basePremiums) {
      for (const petCount of petCounts) {
        const result = computeTotalPremium(makeProduct({ basePremium }), petCount as any);
        if (basePremium === 0) {
          expect(result).toBe(0);
        } else {
          expect(result % basePremium).toBe(0);
        }
      }
    }
  });

  it('invariant: for petCount <= 1, result always equals basePremium exactly', () => {
    for (const basePremium of basePremiums) {
      for (const petCount of [0, 1, undefined, null]) {
        expect(computeTotalPremium(makeProduct({ basePremium }), petCount as any)).toBe(basePremium);
      }
    }
  });

  it('invariant: for mascotas + petCount > 1, result === basePremium * petCount exactly', () => {
    for (const basePremium of basePremiums) {
      for (const petCount of [2, 3, 5, 10, 20]) {
        expect(computeTotalPremium(makeProduct({ basePremium }), petCount)).toBe(basePremium * petCount);
      }
    }
  });

  it('invariant: non-mascotas categories never multiply, regardless of petCount', () => {
    const categories = ['vida', 'hogar', 'accidentes', 'asistencia'];
    for (const category of categories) {
      for (const petCount of [2, 3, 10]) {
        expect(computeTotalPremium(makeProduct({ category, basePremium: 20000 }), petCount)).toBe(20000);
      }
    }
  });

  it('invariant: result is never negative for non-negative inputs', () => {
    for (const basePremium of basePremiums) {
      for (const petCount of petCounts) {
        expect(computeTotalPremium(makeProduct({ basePremium }), petCount as any)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('computeTotalPremium FUZZ', () => {
  it('fuzz: random basePremium × random petCount always multiplies correctly for mascotas', () => {
    for (let i = 0; i < 200; i++) {
      const basePremium = Math.floor(Math.random() * 200_000) + 1;
      const petCount = Math.floor(Math.random() * 30) + 2; // 2..31
      const result = computeTotalPremium(makeProduct({ basePremium }), petCount);
      expect(result).toBe(basePremium * petCount);
    }
  });

  it('fuzz: never throws for arbitrary petCount values including negatives/NaN', () => {
    const weirdValues = [-1, -100, NaN, Infinity, -Infinity, 0.5, 2.9];
    for (const petCount of weirdValues) {
      expect(() => computeTotalPremium(makeProduct(), petCount as any)).not.toThrow();
    }
  });
});
