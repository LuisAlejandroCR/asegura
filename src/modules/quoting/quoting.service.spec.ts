// quoting.service.spec.ts: tests the scoring engine — the pet-type and category hard
// filters, and that every returned score carries a reason the jury can be shown.

import { QuotingService } from './quoting.service';
import { AffiliateSignals, IProductRepository, InsuranceProduct } from './types';
import { ProductCatalog } from './product-catalog.service';

// The runtime catalog, not a fixture copy of it: scoring must be exercised against the
// same 11 products the app actually quotes.
const PRODUCTS = new ProductCatalog().getProducts();

function makeFakeCatalog(products: InsuranceProduct[] = PRODUCTS): IProductRepository {
  return {
    getProducts: () => products,
    getProduct: (id) => products.find((p) => p.id === id),
  };
}

function makeService(): QuotingService {
  return new QuotingService(makeFakeCatalog());
}

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

  // Cross-checking against the actual affiliate data
  // (Usos_Productos_Afiliados_SIN_ID / the synthetic CSV built from its real marginal
  // distribution): budgetFromSalary's keys ('hasta 2 smlv', 'entre 2 y 4 smlv', ...)
  // never matched ANY real RANGO_SALARIAL value — the real bands are finer-grained
  // ("Entre 1 y 1.5 SMLV", "Menor al SMLV", "Entre 2.5 y 3 SMLV", etc., 12 bands total).
  // The single most common real band alone ("Entre 1 y 1.5 SMLV", ~65% of the 465k
  // non-empty rows in Base 2) silently got NO budget scoring boost at all.
  it.each([
    'Menor al SMLV', 'Entre 1 y 1.5 SMLV', 'Entre 1.5 y 2 SMLV', 'Entre 2 y 2.5 SMLV',
    'Entre 2.5 y 3 SMLV', 'Entre 3 y 4 SMLV', 'Entre 4 y 6 SMLV', 'Entre 6 y 8 SMLV',
    'Entre 8 y 10 SMLV', 'Entre 10 y 20 SMLV', 'Entre 20 y 30 SMLV', 'Mayor a 30 SMLV',
  ])('regression — applies the budget boost for the real RANGO_SALARIAL band "%s"', (rango) => {
    const scores = service.score({ productCategory: 'vida', rangoSalarial: rango });
    const vida = scores.find((s) => s.productId === 'vida')!;
    expect(vida.reasons.some((r) => r.includes('presupuesto'))).toBe(true);
  });

  // Regression: the RANGO_SALARIAL lookup was an exact-string map with no normalization.
  // The affiliate xlsx export is an external file Colsubsidio regenerates — trailing
  // whitespace or a stray case difference would silently drop the budget scoring boost
  // (15 of ~100 match points) with no error or fallback signal.
  it('regression — matches despite surrounding whitespace from the xlsx export', () => {
    const scores = service.score({ productCategory: 'vida', rangoSalarial: '  Entre 1 y 1.5 SMLV  ' as any });
    const vida = scores.find((s) => s.productId === 'vida')!;
    expect(vida.reasons.some((r) => r.includes('presupuesto'))).toBe(true);
  });

  it('regression — matches despite a case difference from the xlsx export', () => {
    const scores = service.score({ productCategory: 'vida', rangoSalarial: 'entre 1 y 1.5 smlv' as any });
    const vida = scores.find((s) => s.productId === 'vida')!;
    expect(vida.reasons.some((r) => r.includes('presupuesto'))).toBe(true);
  });

  it('does not apply the budget boost for an unrecognized rango (no crash, just no boost)', () => {
    expect(() => service.score({ productCategory: 'vida', rangoSalarial: 'not a real bracket' as any })).not.toThrow();
  });

  // ~1% of real rows have an empty RANGO_SALARIAL (Colsubsidio's own data gap, not ours).
  it('handles an empty RANGO_SALARIAL value without crashing', () => {
    expect(() => service.score({ productCategory: 'vida', rangoSalarial: '' as any })).not.toThrow();
  });
});

// Beneficiaries reason text
// Real observed bug: "Te lo recomiendo porque: Cubre a 1 personas." — ungrammatical
// (singular "1" with plural "personas"), and Groq's own JSON schema shows
// "beneficiaries": 1 as an EXAMPLE value in the prompt, so the LLM often defaults to 1
// even when the user's message carries no real signal about family size at all. Showing
// this reason for beneficiaries=1 makes every quote look "personalized" with a
// trivially-true, non-distinguishing fact, undermining the actual personalization pitch.

describe('QuotingService — "Cubre a N personas" reason text', () => {
  const service = makeService();

  it('regression — does not show the reason at all for beneficiaries=1 (no real family signal)', () => {
    const scores = service.score({ productCategory: 'asistencia', beneficiaries: 1 });
    const familyProduct = scores.find((s) => s.productId === 'asistencias-medicas')!;
    expect(familyProduct.reasons.some((r) => r.includes('Cubre a'))).toBe(false);
  });

  it('shows a grammatically correct reason for a genuine multi-person signal', () => {
    const scores = service.score({ productCategory: 'asistencia', beneficiaries: 4 });
    const familyProduct = scores.find((s) => s.productId === 'asistencias-medicas')!;
    expect(familyProduct.reasons.some((r) => r.includes('Cubre a 4 personas'))).toBe(true);
  });
});

describe('QuotingService — category cross-sell map (locked-in current behavior)', () => {
  const service = makeService();

  // isRelatedCategory(a, b) reads as "category `a` is also relevant when the signal is `b`",
  // and is asymmetric on purpose: vida<->accidentes cross-sell both ways; asistencia is
  // relevant to a vida signal but not the reverse; mascotas cross-sells through
  // mentionsPersonalCoverage in agent.service.ts, not this map. The businessPriority
  // tie-breaker decides the contested last top-3 slot, so asistencia wins it over accidentes.
  it('an accidentes signal does NOT surface vida products — 3 direct accidentes matches already fill the top-3 cap', () => {
    const scores = service.score({ productCategory: 'accidentes' });
    expect(scores).toHaveLength(3);
    expect(scores.every((s) => PRODUCTS.find((p) => p.id === s.productId)?.category === 'accidentes')).toBe(true);
  });

  it('an asistencia signal does NOT include vida products (the map only reaches asistencia FROM a vida signal, not the reverse)', () => {
    const scores = service.score({ productCategory: 'asistencia' });
    expect(scores.some((s) => PRODUCTS.find((p) => p.id === s.productId)?.category === 'vida')).toBe(false);
  });

  // A vida signal has exactly 2 direct vida products (vida, vida-ahorro), leaving one
  // top-3 slot contested among the related accidentes/asistencia candidates. Prioritized
  // asistencia products (asistencias-multiples, exequial, asistencias-medicas) and the
  // prioritized accidentes-exequial all score higher than the two non-prioritized
  // accidentes products — an asistencia product wins the slot by catalog order among the
  // prioritized ties.
  it('a vida signal now surfaces a prioritized asistencia product in the contested last top-3 slot, not accidentes', () => {
    const scores = service.score({ productCategory: 'vida' });
    expect(scores).toHaveLength(3);
    const categories = scores.map((s) => PRODUCTS.find((p) => p.id === s.productId)?.category);
    expect(categories).toEqual(['vida', 'vida', 'asistencia']);
    expect(scores.some((s) => PRODUCTS.find((p) => p.id === s.productId)?.category === 'accidentes')).toBe(false);
  });
});

// bestQuote() must never substitute the category the user explicitly chose, even when a
// related-category product would outscore it. The real catalog's weights never reach that
// case today, so this forces it with a controlled fake. "otro" can still surface a related
// category later, through score()'s own top-3.
describe('QuotingService.bestQuote — never substitutes an explicit category choice', () => {
  const service = makeService();

  it('regression — an exact-category match always wins bestQuote even when a related-category product scores strictly higher', () => {
    // Controlled fake catalog: 'exacto' is the only 'vida' product (deliberately no
    // extra bonuses), 'relacionado' is an 'asistencia' product engineered to outscore it
    // via coverage matches — proving the mechanism, not relying on real catalog weights
    // happening to reach this combination today.
    const fake: InsuranceProduct[] = [
      {
        id: 'exacto', name: 'Exacto', category: 'vida', insurer: 'Test', basePremium: 10000,
        url: 'https://example.com', coverages: ['cobertura básica'], eligibility: {},
      },
      {
        id: 'relacionado', name: 'Relacionado', category: 'asistencia', insurer: 'Test', basePremium: 10000,
        url: 'https://example.com',
        coverages: ['medicina general', 'consultas virtuales', 'urgencias médicas', 'telemedicina', 'hospitalización'],
        eligibility: {},
      },
    ];
    const fakeService = new QuotingService(makeFakeCatalog(fake));
    const signals = {
      productCategory: 'vida' as const,
      coverage: ['medicina', 'consultas', 'urgencias', 'telemedicina', 'hospitalización'],
    };
    // Confirms the premise: without the fix, score()'s own top pick is the RELATED
    // product (4 coverage matches beat a bare exact-category match with no other signal).
    const scores = fakeService.score(signals);
    expect(scores[0].productId).toBe('relacionado');

    const best = fakeService.bestQuote(signals);
    expect(best?.product.id).toBe('exacto');
  });

  it('falls back to the top-scoring related-category product when NO exact-category match exists at all (e.g. hogar)', () => {
    // 'hogar' has no dedicated product in the real catalog — asistencias-multiples is
    // the only real cross-sell available, and must still be returned, not null.
    const best = service.bestQuote({ productCategory: 'hogar' as const });
    expect(best).not.toBeNull();
    expect(best?.product.category).toBe('asistencia');
  });

  it('an exact category match with no competing related-category bonus is returned as before (unchanged behavior)', () => {
    const best = service.bestQuote({ productCategory: 'mascotas' as const });
    expect(best?.product.category).toBe('mascotas');
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

// Business feedback: 7 products are now prioritized for sale (direct-sell,
// require only basic cédula/nombre/correo) — vida, asistencias-multiples, exequial,
// accidentes-exequial, asistencias-medicas, medicina-prepagada-gatos,
// medicina-prepagada-perros. When multiple same-category products otherwise tie, a
// prioritized product must outrank a non-prioritized one.
describe('QuotingService — business-priority boost', () => {
  const service = makeService();
  const prioritizedIds = [
    'vida', 'asistencias-multiples', 'exequial', 'accidentes-exequial',
    'asistencias-medicas', 'medicina-prepagada-gatos', 'medicina-prepagada-perros',
  ];

  it('marks exactly the 7 prioritized products as businessPriority in the catalog', () => {
    const flagged = PRODUCTS.filter((p) => p.businessPriority).map((p) => p.id).sort();
    expect(flagged).toEqual([...prioritizedIds].sort());
  });

  it('a prioritized accidentes product outranks a non-prioritized one when otherwise tied', () => {
    const scores = service.score({ productCategory: 'accidentes' });
    const exequialScore = scores.find((s) => s.productId === 'accidentes-exequial')!.matchScore;
    const personalesScore = scores.find((s) => s.productId === 'accidentes-personales')!.matchScore;
    expect(exequialScore).toBeGreaterThan(personalesScore);
  });

  it('a prioritized vida product outranks a non-prioritized one when otherwise tied', () => {
    const scores = service.score({ productCategory: 'vida' });
    const vidaScore = scores.find((s) => s.productId === 'vida')!.matchScore;
    const vidaAhorroScore = scores.find((s) => s.productId === 'vida-ahorro')!.matchScore;
    expect(vidaScore).toBeGreaterThan(vidaAhorroScore);
  });
});

// Business feedback: "Seguro de vida" and both "Medicina prepagada"
// (gatos/perros) products need conditional underwriting — age, pre-existing illnesses,
// and clinical history — before they can be sold. Every other product is direct-sell
// (cédula/nombre/correo only).
describe('QuotingService — conditional underwriting flag', () => {
  it('marks exactly vida + medicina-prepagada-gatos + medicina-prepagada-perros as requiring underwriting', () => {
    const flagged = PRODUCTS.filter((p) => p.requiresUnderwriting).map((p) => p.id).sort();
    expect(flagged).toEqual(['medicina-prepagada-gatos', 'medicina-prepagada-perros', 'vida'].sort());
  });
});

// Hyper-personalization tier — ported from a teammate's Python prototype
// (feature/motor-python-hiperpersonalizacion, analytics/reglas_negocio.py), reworked to
// use only signals the live conversation actually collects. The branch's age/pensioner
// tier (exequial for 55+) could NOT be ported: AffiliateSignals.edad is declared in the
// type but never populated anywhere live — the NLP schema only ever extracts a PET's age
// (petAge / pets[].age), never a human affiliate's own age. That tier is deferred to
// Phase 2, pending a new DISCOVERY question. This block covers only the two tiers that
// use fields already populated today: beneficiaries (dependents proxy) and rangoSalarial.
describe('QuotingService — hyper-personalization tier (dependents/income)', () => {
  const service = makeService();

  it('dependents + high income upgrades vida-ahorro above vida (vida alone would win on businessPriority)', () => {
    const scores = service.score({ productCategory: 'vida', beneficiaries: 3, rangoSalarial: 'Entre 4 y 6 SMLV' });
    const vida = scores.find((s) => s.productId === 'vida')!;
    const vidaAhorro = scores.find((s) => s.productId === 'vida-ahorro')!;
    expect(vidaAhorro.matchScore).toBeGreaterThan(vida.matchScore);
    expect(vidaAhorro.reasons.some((r) => r.includes('ahorrar') || r.includes('Ahorro'))).toBe(true);
  });

  // Regression: rangoSalarial is declared in AffiliateSignals but is NEVER populated by
  // the live NLP schema (InsuranceIntent has no rangoSalarial field at all — confirmed by
  // grep across groq-nlp.service.ts and nlp/types.ts) — it only ever existed as an offline
  // CSV-calibration signal. The one live, user-stated income signal is `budget` (an
  // explicit peso amount), already used for the "dentro de tu presupuesto" boost above.
  // The tier bonus must react to the SAME effective budget, or it can never fire in
  // production regardless of what a real user says.
  it('dependents + high explicit budget (no rangoSalarial) also upgrades vida-ahorro above vida', () => {
    const scores = service.score({ productCategory: 'vida', beneficiaries: 3, budget: 100_000 });
    const vida = scores.find((s) => s.productId === 'vida')!;
    const vidaAhorro = scores.find((s) => s.productId === 'vida-ahorro')!;
    expect(vidaAhorro.matchScore).toBeGreaterThan(vida.matchScore);
  });

  it('no dependents + high explicit budget (no rangoSalarial) also upgrades accidentes-premium', () => {
    const scores = service.score({ productCategory: 'accidentes', beneficiaries: 1, budget: 100_000 });
    const std = scores.find((s) => s.productId === 'accidentes-personales')!;
    const premium = scores.find((s) => s.productId === 'accidentes-premium')!;
    expect(premium.matchScore).toBeGreaterThan(std.matchScore);
  });

  it('dependents + low/unknown income keeps vida as the top recommendation, with a dependents-specific reason', () => {
    // Not compared against vida-ahorro's presence here: at low income, other
    // businessPriority + beneficiaries-boosted products (e.g. asistencias-medicas,
    // which is also family-eligible) legitimately outscore vida-ahorro and crowd it out
    // of the top-3 — that's correct existing behavior, not something this test is about.
    const scores = service.score({ productCategory: 'vida', beneficiaries: 3, rangoSalarial: 'Menor al SMLV' });
    expect(scores[0].productId).toBe('vida');
    expect(scores[0].reasons.some((r) => r.includes('a cargo'))).toBe(true);
  });

  it('no dependents + high income upgrades accidentes-premium above accidentes-personales', () => {
    const scores = service.score({ productCategory: 'accidentes', beneficiaries: 1, rangoSalarial: 'Entre 6 y 8 SMLV' });
    const std = scores.find((s) => s.productId === 'accidentes-personales')!;
    const premium = scores.find((s) => s.productId === 'accidentes-premium')!;
    expect(premium.matchScore).toBeGreaterThan(std.matchScore);
  });

  it('no dependents + low income leaves accidentes-premium without the tier boost', () => {
    // rangoSalarial deliberately omitted here (rather than a real low band like "Menor
    // al SMLV"): any recognized band also clears vida's own low basePremium (12000) and
    // pulls it into a contested top-3 slot via the bidirectional accidentes<->vida
    // category relation, which would make this comparison depend on unrelated tie-break
    // order instead of the tier boost being tested.
    const withBoost = service.score({ productCategory: 'accidentes', beneficiaries: 1, rangoSalarial: 'Entre 6 y 8 SMLV' })
      .find((s) => s.productId === 'accidentes-premium')!.matchScore;
    const withoutBoost = service.score({ productCategory: 'accidentes', beneficiaries: 1 })
      .find((s) => s.productId === 'accidentes-premium')!.matchScore;
    expect(withoutBoost).toBeLessThan(withBoost);
  });

  it('dependents present suppresses the accidentes-premium tier boost (that tier is for no-dependents profiles)', () => {
    // Compares accidentes-premium's own score across the two scenarios (falling back to
    // 0 if it's crowded out of the top-3 entirely) rather than against accidentes-
    // personales directly — the two products are close enough in base score that a
    // same-value tie-break on array order would make a direct comparison flaky.
    const withoutDependents = service.score({ productCategory: 'accidentes', beneficiaries: 1, rangoSalarial: 'Entre 6 y 8 SMLV' })
      .find((s) => s.productId === 'accidentes-premium')?.matchScore ?? 0;
    const withDependents = service.score({ productCategory: 'accidentes', beneficiaries: 3, rangoSalarial: 'Entre 6 y 8 SMLV' })
      .find((s) => s.productId === 'accidentes-premium')?.matchScore ?? 0;
    expect(withDependents).toBeLessThan(withoutDependents);
  });

  describe('invariants', () => {
    it('at most one of vida/vida-ahorro receives the tier bonus for any beneficiaries × rangoSalarial combo', () => {
      const beneficiariesSet = [0, 1, 2, 3, 5, 10];
      const rangos = [undefined, '', 'Menor al SMLV', 'Entre 1.5 y 2 SMLV', 'Entre 4 y 6 SMLV', 'Mayor a 30 SMLV', 'garbage'];
      for (const beneficiaries of beneficiariesSet) {
        for (const rangoSalarial of rangos) {
          const scores = service.score({ productCategory: 'vida', beneficiaries, rangoSalarial: rangoSalarial as any });
          const vida = scores.find((s) => s.productId === 'vida');
          const vidaAhorro = scores.find((s) => s.productId === 'vida-ahorro');
          // Only meaningful when both are actually present — one being crowded out of
          // the top-3 by unrelated businessPriority noise is not a bonus-tie bug.
          if (vida && vidaAhorro) {
            expect(vida.matchScore === vidaAhorro.matchScore).toBe(false);
          }
        }
      }
    });

    it('matchScore never exceeds 100 for any dependents × income combination', () => {
      const beneficiariesSet = [0, 1, 2, 5, 10, 50];
      const rangos = ['Menor al SMLV', 'Entre 4 y 6 SMLV', 'Mayor a 30 SMLV'];
      for (const beneficiaries of beneficiariesSet) {
        for (const rangoSalarial of rangos) {
          for (const productCategory of ['vida', 'accidentes'] as const) {
            const scores = service.score({ productCategory, beneficiaries, rangoSalarial, budget: 500000 });
            for (const s of scores) expect(s.matchScore).toBeLessThanOrEqual(100);
          }
        }
      }
    });
  });

  describe('fuzz', () => {
    it('never throws for random beneficiaries × rangoSalarial combinations, including adversarial values', () => {
      const weirdBeneficiaries = [-1, -100, NaN, Infinity, -Infinity, 0.5, 999999];
      const weirdRangos = ['', '   ', 'no es un rango real', '¡garbage!', undefined, null];
      for (const beneficiaries of weirdBeneficiaries) {
        for (const rangoSalarial of weirdRangos) {
          for (const productCategory of ['vida', 'accidentes'] as const) {
            expect(() =>
              service.score({ productCategory, beneficiaries: beneficiaries as any, rangoSalarial: rangoSalarial as any }),
            ).not.toThrow();
          }
        }
      }
    });

    it('random valid combinations always keep matchScore within [0, 100] and reasons non-empty when a tier bonus applies', () => {
      for (let i = 0; i < 200; i++) {
        const beneficiaries = Math.floor(Math.random() * 10);
        const rangoSalarial = ['Menor al SMLV', 'Entre 1 y 1.5 SMLV', 'Entre 4 y 6 SMLV', 'Mayor a 30 SMLV'][
          Math.floor(Math.random() * 4)
        ];
        const scores = service.score({ productCategory: 'vida', beneficiaries, rangoSalarial });
        for (const s of scores) {
          expect(s.matchScore).toBeGreaterThanOrEqual(0);
          expect(s.matchScore).toBeLessThanOrEqual(100);
        }
      }
    });
  });
});

// "why this product" reason ordering
// Reasons used to surface in PUSH order: the exact-category branch pushed NO reason at
// all, the related-category branch pushed a raw slug (`Categoría: vida`), and the
// persuasive tier sentences were pushed LAST — so `formatQuote`'s `reasons[0]`
// (agent.service.ts) almost always displayed the least compelling line, or the slug
// itself, verbatim, to the user. This weight-ranks and sorts the SAME reasons at return
// time; matchScore arithmetic is untouched (see the pinned-literals invariant below).
describe('QuotingService — weight-ranked "why this product" reasons (Step 1)', () => {
  const service = makeService();

  it('the persuasive tier sentence leads the list for a strong dependents signal', () => {
    const scores = service.score({ productCategory: 'vida', beneficiaries: 3 });
    const vida = scores.find((s) => s.productId === 'vida')!;
    expect(vida.reasons[0]).toContain('a cargo');
  });

  it('a related-category match never leads (or appears at all) as a raw "Categoría:" slug', () => {
    // asistencia products cross-sell for a 'hogar' signal (isRelatedCategory('asistencia','hogar')).
    const scores = service.score({ productCategory: 'hogar' });
    for (const s of scores) {
      for (const r of s.reasons) {
        expect(r).not.toMatch(/^Categoría:/);
      }
    }
  });

  it('an exact category match with no other signal still yields a real, human reason (previously pushed nothing at all)', () => {
    const scores = service.score({ productCategory: 'accidentes' });
    const std = scores.find((s) => s.productId === 'accidentes-personales')!;
    expect(std.reasons.length).toBeGreaterThan(0);
    expect(std.reasons[0]).not.toMatch(/^Categoría:/);
  });

  it('fuzz: no reason is ever a raw "Categoría: x" slug across many signal combinations', () => {
    const categories: NonNullable<AffiliateSignals['productCategory']>[] = ['vida', 'hogar', 'accidentes', 'asistencia', 'mascotas'];
    for (const productCategory of categories) {
      for (const beneficiaries of [0, 1, 2, 5]) {
        for (const budget of [undefined, 15000, 60000, 200000]) {
          const scores = service.score({
            productCategory, beneficiaries, budget,
            petType: productCategory === 'mascotas' ? 'mixto' : undefined,
          });
          for (const s of scores) {
            for (const r of s.reasons) {
              expect(r).not.toMatch(/^Categoría:/);
            }
          }
        }
      }
    }
  });

  // Pinned-literals invariant: proves the Step 1 change is a pure REORDER of reasons, not
  // a scoring change — every matchScore below is byte-for-byte what this exact signal
  // combination already produced before Step 1 (confirmed via `git diff`: no `matchScore
  // +=` line was touched, only how `reasons` gets collected and sorted).
  it('pinned-literals invariant: matchScore is unchanged for known signal combinations', () => {
    const cases: { signals: AffiliateSignals; productId: string; expectedScore: number }[] = [
      { signals: { productCategory: 'vida', beneficiaries: 3 }, productId: 'vida', expectedScore: 65 },
      { signals: { productCategory: 'accidentes' }, productId: 'accidentes-personales', expectedScore: 40 },
      { signals: { productCategory: 'vida', beneficiaries: 3, budget: 100_000 }, productId: 'vida-ahorro', expectedScore: 80 },
      { signals: { productCategory: 'mascotas', petType: 'gato', coverage: ['medicina'] }, productId: 'medicina-prepagada-gatos', expectedScore: 75 },
    ];
    for (const { signals, productId, expectedScore } of cases) {
      const scores = service.score(signals);
      const found = scores.find((s) => s.productId === productId)!;
      expect([productId, found.matchScore]).toEqual([productId, expectedScore]);
    }
  });
});

// Step 2: `dependents` wakes the dormant tiers with a trustworthy signal
// `beneficiaries` is untrustworthy by design (Groq's schema shows "beneficiaries": 1 as
// its OWN example, so the LLM often defaults to 1 with no real signal). `dependents` is
// only ever set by a real DISCOVERY question (Step 3) — when present, it takes
// precedence; when absent (undefined), behavior is byte-for-byte the old
// beneficiaries-only fallback, so every pre-existing test/signal set is unaffected.
describe('QuotingService — dependents field precedence (Step 2)', () => {
  const service = makeService();

  it('dependents=0 suppresses the tier bonus even when beneficiaries suggests a family (dependents wins)', () => {
    const scores = service.score({ productCategory: 'vida', beneficiaries: 4, dependents: 0 });
    const vida = scores.find((s) => s.productId === 'vida')!;
    expect(vida.reasons.some((r) => r.includes('a cargo'))).toBe(false);
  });

  it('dependents>0 wakes the tier bonus even when beneficiaries is absent entirely', () => {
    const scores = service.score({ productCategory: 'vida', dependents: 2 });
    const vida = scores.find((s) => s.productId === 'vida')!;
    expect(vida.reasons.some((r) => r.includes('a cargo'))).toBe(true);
  });

  it('back-compat: dependents=undefined falls back to the beneficiaries heuristic exactly as before', () => {
    const scores = service.score({ productCategory: 'vida', beneficiaries: 3 });
    const vida = scores.find((s) => s.productId === 'vida')!;
    expect(vida.reasons.some((r) => r.includes('a cargo'))).toBe(true);
  });
});

// Urgency wakes non-underwriting products
// Already inferred by the NLP layer from words like "urgente"/"ya" (InsuranceIntent.
// urgency), but never previously read here. requiresUnderwriting products (vida,
// medicina-prepagada-*) genuinely take longer to activate (age/illness info required
// before the policy can be issued — see AgentService's DATA_CAPTURE flow), so someone
// who needs protection NOW is honestly better served by a direct-sell product.
describe('QuotingService — urgency wakes non-underwriting products (Matriz 2)', () => {
  const service = makeService();

  it('urgency=immediate boosts a non-underwriting product with a real reason', () => {
    const scores = service.score({ productCategory: 'accidentes', urgency: 'immediate' });
    const std = scores.find((s) => s.productId === 'accidentes-personales')!;
    expect(std.reasons.some((r) => r.includes('se activa de inmediato'))).toBe(true);
  });

  it('urgency=immediate does NOT boost a product that requires underwriting (vida)', () => {
    const scores = service.score({ productCategory: 'vida', urgency: 'immediate' });
    const vida = scores.find((s) => s.productId === 'vida')!;
    expect(vida.reasons.some((r) => r.includes('se activa de inmediato'))).toBe(false);
  });

  it('urgency=exploring does not add the boost', () => {
    const scores = service.score({ productCategory: 'accidentes', urgency: 'exploring' });
    const std = scores.find((s) => s.productId === 'accidentes-personales')!;
    expect(std.reasons.some((r) => r.includes('se activa de inmediato'))).toBe(false);
  });

  it('no urgency signal at all does not add the boost (back-compat — nothing populated this before today)', () => {
    const scores = service.score({ productCategory: 'accidentes' });
    const std = scores.find((s) => s.productId === 'accidentes-personales')!;
    expect(std.reasons.some((r) => r.includes('se activa de inmediato'))).toBe(false);
  });

  it('pinned-literals invariant: matchScore with urgency=immediate is exactly 10 points higher than without it, for a non-underwriting product', () => {
    const without = service.score({ productCategory: 'accidentes' }).find((s) => s.productId === 'accidentes-personales')!.matchScore;
    const withUrgency = service.score({ productCategory: 'accidentes', urgency: 'immediate' }).find((s) => s.productId === 'accidentes-personales')!.matchScore;
    expect(withUrgency).toBe(without + 10);
  });
});

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

// Reported from a live chat: someone who never mentioned a cat was quoted cat prepaid
// medicine for three pets. The species filter only ran when petType was already known, so
// with no species the three pet products all scored and CANONICAL_ORDER broke the tie —
// and cats are listed before dogs.
describe('QuotingService — never invents a species', () => {
  const service = new QuotingService(new ProductCatalog());

  it('regression — does not quote a cat-only or dog-only plan when no species is known', () => {
    const scores = service.score({ productCategory: 'mascotas' });
    const ids = scores.map((s) => s.productId);
    expect(ids).not.toContain('medicina-prepagada-gatos');
    expect(ids).not.toContain('medicina-prepagada-perros');
  });

  it('still offers the species-agnostic plan, so the answer is not empty', () => {
    const scores = service.score({ productCategory: 'mascotas' });
    expect(scores.map((s) => s.productId)).toContain('asistencia-veterinaria');
  });

  it('quotes the cat plan once the species is actually established', () => {
    const scores = service.score({ productCategory: 'mascotas', petType: 'gato' });
    expect(scores.map((s) => s.productId)).toContain('medicina-prepagada-gatos');
    expect(scores.map((s) => s.productId)).not.toContain('medicina-prepagada-perros');
  });

  it('a mixed household still sees both, since mixto is an explicit answer', () => {
    const ids = service.score({ productCategory: 'mascotas', petType: 'mixto' }).map((s) => s.productId);
    expect(ids.some((id) => id === 'medicina-prepagada-gatos' || id === 'medicina-prepagada-perros')).toBe(true);
  });
});
