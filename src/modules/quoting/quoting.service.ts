import { Injectable, Logger } from '@nestjs/common';
import { PRODUCTS } from './products.data';
import { AffiliateSignals, InsuranceProduct, InsuranceScore } from './types';

@Injectable()
export class QuotingService {
  private readonly logger = new Logger(QuotingService.name);

  score(signals: AffiliateSignals): InsuranceScore[] {
    const scores: InsuranceScore[] = [];

    for (const product of PRODUCTS) {
      const score = this.evaluateProduct(product, signals);
      if (score.matchScore > 0) {
        scores.push(score);
      }
    }

    scores.sort((a, b) => b.matchScore - a.matchScore);
    return scores.slice(0, 3);
  }

  bestQuote(signals: AffiliateSignals): { product: InsuranceProduct; score: InsuranceScore } | null {
    const scores = this.score(signals);
    if (scores.length === 0) return null;
    const top = scores[0];
    const product = PRODUCTS.find((p) => p.id === top.productId);
    return product ? { product, score: top } : null;
  }

  private evaluateProduct(product: InsuranceProduct, signals: AffiliateSignals): InsuranceScore {
    const zero: InsuranceScore = { productId: product.id, matchScore: 0, reasons: [], monthlyPremium: product.basePremium, priority: 'low' };
    let matchScore = 0;
    const reasons: string[] = [];

    // Hard filter: wrong category
    if (signals.productCategory && product.category !== signals.productCategory) {
      if (!this.isRelatedCategory(product.category, signals.productCategory)) return zero;
      matchScore += 20;
      reasons.push(`Categoría: ${product.category}`);
    } else if (signals.productCategory) {
      matchScore += 40;
    }

    // Hard filter: wrong pet type (gato vs perro products); 'mixto' skips the filter
    if (signals.petType && signals.petType !== 'mixto' && product.eligibility.pet && product.eligibility.pet !== 'any') {
      if (product.eligibility.pet !== signals.petType) return zero;
      matchScore += 20;
      reasons.push(`Para ${signals.petType}s`);
    }

    // beneficiaries > 1 only — Groq's own JSON schema shows "beneficiaries": 1 as an
    // EXAMPLE value in the prompt, so the LLM often defaults to 1 even when the message
    // carries no real signal about family size. Showing "Cubre a 1 personas" (also
    // ungrammatical: singular count, plural noun) as a "personalized" reason for every
    // single-person quote is a trivially-true, non-distinguishing fact that undermines
    // the actual personalization pitch — real bug observed in an external test session.
    if (signals.beneficiaries && signals.beneficiaries > 1 && product.eligibility.family) {
      matchScore += 20;
      reasons.push(`Cubre a ${signals.beneficiaries} personas`);
    }

    // Budget check: use explicit budget or infer from salary range
    const effectiveBudget = signals.budget ?? this.budgetFromSalary(signals.rangoSalarial);
    if (effectiveBudget && product.basePremium <= effectiveBudget) {
      matchScore += 15;
      reasons.push(`Desde $${product.basePremium.toLocaleString()}/mes — dentro de tu presupuesto`);
    }

    if (signals.coverage) {
      const matched = product.coverages.filter((c) =>
        signals.coverage!.some((s) => c.toLowerCase().includes(s.toLowerCase())),
      ).length;
      if (matched > 0) {
        matchScore += matched * 5;
        reasons.push(`Coberturas: ${product.coverages.slice(0, 2).join(', ')}`);
      }
    }

    // 2026-07-24 business feedback: 7 products are the current sales priority — a small
    // tie-breaker boost, never a hard filter, so a genuinely better-matching product
    // (e.g. the right pet-species medicine) still wins on its own signals.
    if (product.businessPriority) {
      matchScore += 10;
    }

    // 2026-07-25 hyper-personalization tier — ported from a teammate's Python prototype
    // (feature/motor-python-hiperpersonalizacion, analytics/reglas_negocio.py), reworked
    // to use only signals the live conversation actually collects. The branch's
    // age/pensioner tier (exequial for 55+) could NOT be ported: AffiliateSignals.edad is
    // declared in the type but never populated live — the NLP schema only ever extracts a
    // PET's age (petAge / pets[].age), never a human affiliate's own age. Deferred until
    // a real DISCOVERY question captures it.
    const hasDependents = !!signals.beneficiaries && signals.beneficiaries > 1;
    const highIncome = (this.budgetFromSalary(signals.rangoSalarial) ?? 0) >= 60000; // "Entre 3 y 4 SMLV"+

    if (product.category === 'vida') {
      if (hasDependents && highIncome && product.id === 'vida-ahorro') {
        matchScore += 25;
        reasons.push(`Tienes ${signals.beneficiaries} personas a cargo y un ingreso que permite ahorrar — Vida+Ahorro protege y capitaliza a la vez`);
      } else if (hasDependents && !highIncome && product.id === 'vida') {
        matchScore += 15;
        reasons.push(`Tienes ${signals.beneficiaries} personas a cargo — proteger ese ingreso es la necesidad más directa`);
      }
    }

    if (product.category === 'accidentes' && !hasDependents && highIncome && product.id === 'accidentes-premium') {
      matchScore += 20;
      reasons.push('Tu ingreso permite una cobertura ampliada — Accidentes premium suma gastos médicos mayores e indemnización más alta');
    }

    matchScore = Math.min(matchScore, 100);

    return {
      productId: product.id,
      matchScore,
      reasons,
      monthlyPremium: product.basePremium,
      priority: matchScore >= 60 ? 'high' : matchScore >= 30 ? 'medium' : 'low',
    };
  }

  // Maps RANGO_SALARIAL from the affiliate xlsx to an approximate monthly discretionary
  // budget for insurance. Normalized (trim/case/accents) because the xlsx is an external
  // file Colsubsidio regenerates — a stray whitespace or casing difference must not
  // silently drop this scoring boost with no error or fallback signal.
  //
  // Real bug found 2026-07-24, cross-checked against the actual affiliate data
  // (Usos_Productos_Afiliados_SIN_ID, ~465k non-empty rows): the previous map's keys
  // ('hasta 2 smlv', 'entre 2 y 4 smlv', 'mas de 10 smlv', ...) never matched ANY real
  // RANGO_SALARIAL value — the real bands are finer-grained. "Entre 1 y 1.5 SMLV" alone
  // (the most common, ~65% of rows) got silently NO budget boost at all. These are the
  // 12 actual band strings from the real distribution.
  private budgetFromSalary(rango?: string): number | null {
    if (!rango) return null;
    const map: Record<string, number> = {
      'menor al smlv': 15000,
      'entre 1 y 1.5 smlv': 20000,
      'entre 1.5 y 2 smlv': 30000,
      'entre 2 y 2.5 smlv': 40000,
      'entre 2.5 y 3 smlv': 50000,
      'entre 3 y 4 smlv': 60000,
      'entre 4 y 6 smlv': 80000,
      'entre 6 y 8 smlv': 100000,
      'entre 8 y 10 smlv': 120000,
      'entre 10 y 20 smlv': 150000,
      'entre 20 y 30 smlv': 200000,
      'mayor a 30 smlv': 300000,
    };
    return map[this.normalizeRango(rango)] ?? null;
  }

  private normalizeRango(rango: string): string {
    return rango
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
  }

  private isRelatedCategory(a: string, b: string): boolean {
    const related: Record<string, string[]> = {
      vida: ['vida', 'accidentes'],
      accidentes: ['accidentes', 'vida'],
      // 'hogar' has no dedicated product in the real catalog (rule: only real
      // colsubsidio.com/seguros prices) — asistencias-multiples explicitly covers
      // "asistencia en el hogar", so a hogar signal cross-sells into asistencia products
      // instead of hitting a structural dead end.
      asistencia: ['asistencia', 'vida', 'hogar'],
      mascotas: ['mascotas'],
    };
    return related[a]?.includes(b) ?? false;
  }
}