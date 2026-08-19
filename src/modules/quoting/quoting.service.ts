// quoting.service.ts: scores the catalog against an affiliate's signals and returns a
// ranked list with an explicit reason per product. Rules decide here, not the LLM —
// the agent only supplies the extracted signals.

import { Inject, Injectable, Logger } from '@nestjs/common';
import { AffiliateSignals, IProductRepository, InsuranceProduct, InsuranceScore } from './types';

@Injectable()
export class QuotingService {
  private readonly logger = new Logger(QuotingService.name);

  constructor(@Inject('IProductRepository') private readonly catalog: IProductRepository) {}

  score(signals: AffiliateSignals): InsuranceScore[] {
    return this.scoreAll(signals).slice(0, 3);
  }

  bestQuote(signals: AffiliateSignals): { product: InsuranceProduct; score: InsuranceScore } | null {
    const scores = this.scoreAll(signals);
    if (scores.length === 0) return null;

    // An explicit category choice must never be substituted: a related category can outscore
    // an exact match on other bonuses (family, budget). Scans the FULL scored list, not just
    // the top-3 slice, so an exact match wins even when it missed the top 3.
    if (signals.productCategory) {
      const exactMatch = scores.find((s) => this.catalog.getProduct(s.productId)?.category === signals.productCategory);
      if (exactMatch) {
        const product = this.catalog.getProduct(exactMatch.productId);
        return product ? { product, score: exactMatch } : null;
      }
    }

    const top = scores[0];
    const product = this.catalog.getProduct(top.productId);
    return product ? { product, score: top } : null;
  }

  private scoreAll(signals: AffiliateSignals): InsuranceScore[] {
    const scores: InsuranceScore[] = [];

    for (const product of this.catalog.getProducts()) {
      const score = this.evaluateProduct(product, signals);
      if (score.matchScore > 0) {
        scores.push(score);
      }
    }

    scores.sort((a, b) => b.matchScore - a.matchScore);
    return scores;
  }

  // Reasons are weight-ranked and sorted at the end so formatQuote's reasons[0] is the most
  // persuasive line, not the first one pushed. Every matchScore below is unchanged by it.
  private static readonly REASON_WEIGHT = {
    tier: 100,
    family: 90,
    species: 80,
    urgency: 65,
    budget: 60,
    coverage: 40,
    categoryExact: 20,
    categoryRelated: 10,
  } as const;

  private evaluateProduct(product: InsuranceProduct, signals: AffiliateSignals): InsuranceScore {
    const zero: InsuranceScore = { productId: product.id, matchScore: 0, reasons: [], monthlyPremium: product.basePremium, priority: 'low' };
    let matchScore = 0;
    const weightedReasons: { weight: number; text: string }[] = [];
    const addReason = (weight: number, text: string) => weightedReasons.push({ weight, text });

    // Hard filter: wrong category
    if (signals.productCategory && product.category !== signals.productCategory) {
      if (!this.isRelatedCategory(product.category, signals.productCategory)) return zero;
      matchScore += 20;
      addReason(QuotingService.REASON_WEIGHT.categoryRelated, 'Aunque buscabas otra categoría, esta opción también cubre parte de esa necesidad');
    } else if (signals.productCategory) {
      matchScore += 40;
      addReason(QuotingService.REASON_WEIGHT.categoryExact, 'Coincide exactamente con el tipo de seguro que buscas');
    }

    // Hard filter: wrong pet type (gato vs perro products); 'mixto' skips the filter
    if (signals.petType && signals.petType !== 'mixto' && product.eligibility.pet && product.eligibility.pet !== 'any') {
      if (product.eligibility.pet !== signals.petType) return zero;
      matchScore += 20;
      addReason(QuotingService.REASON_WEIGHT.species, `Para ${signals.petType}s`);
    }

    // No species established: a species-specific plan is unquotable, because nothing here
    // knows which one. Without this the tie-break fell to catalog order and quoted cats to
    // someone who never mentioned a cat. The species-agnostic plan (pet: any) still scores.
    if (!signals.petType && product.eligibility.pet && product.eligibility.pet !== 'any') {
      return zero;
    }

    // beneficiaries > 1 only: Groq's own schema shows "beneficiaries": 1 as an EXAMPLE, so the
    // model defaults to it with no real signal. "Cubre a 1 personas" as a personalized reason
    // is trivially true and undermines the pitch.
    if (signals.beneficiaries && signals.beneficiaries > 1 && product.eligibility.family) {
      matchScore += 20;
      addReason(QuotingService.REASON_WEIGHT.family, `Cubre a ${signals.beneficiaries} personas`);
    }

    // Budget check: use explicit budget or infer from salary range
    const effectiveBudget = signals.budget ?? this.budgetFromSalary(signals.rangoSalarial);
    if (effectiveBudget && product.basePremium <= effectiveBudget) {
      matchScore += 15;
      addReason(QuotingService.REASON_WEIGHT.budget, `Desde $${product.basePremium.toLocaleString()}/mes — dentro de tu presupuesto`);
    }

    if (signals.coverage) {
      const matched = product.coverages.filter((c) =>
        signals.coverage!.some((s) => c.toLowerCase().includes(s.toLowerCase())),
      ).length;
      if (matched > 0) {
        matchScore += matched * 5;
        addReason(QuotingService.REASON_WEIGHT.coverage, `Coberturas: ${product.coverages.slice(0, 2).join(', ')}`);
      }
    }

    // requiresUnderwriting products (vida, medicina-prepagada-*) need age and pre-existing
    // illness info before they can be issued, so they are genuinely slower to activate — a
    // real catalog distinction for someone who says they need protection now.
    if (signals.urgency === 'immediate' && !product.requiresUnderwriting) {
      matchScore += 10;
      addReason(QuotingService.REASON_WEIGHT.urgency, 'Necesitas protección ya — este seguro no requiere trámites adicionales, se activa de inmediato');
    }

    // Current sales priority: a small tie-breaker, never a hard filter.
    if (product.businessPriority) {
      matchScore += 10;
    }

    // Hyper-personalization tier. `edad` and `rangoSalarial` are declared but never populated
    // live, so this reads `budget`; `dependents` wins when it was asked, and `beneficiaries`
    // stays the fallback when it wasn't.
    const hasDependents = signals.dependents !== undefined
      ? signals.dependents > 0
      : (!!signals.beneficiaries && signals.beneficiaries > 1);
    const highIncome = (effectiveBudget ?? 0) >= 60000; // "Entre 3 y 4 SMLV"+ equivalent

    if (product.category === 'vida') {
      if (hasDependents && highIncome && product.id === 'vida-ahorro') {
        matchScore += 25;
        addReason(QuotingService.REASON_WEIGHT.tier, `Tienes ${signals.beneficiaries} personas a cargo y un ingreso que permite ahorrar — Vida+Ahorro protege y capitaliza a la vez`);
      } else if (hasDependents && !highIncome && product.id === 'vida') {
        matchScore += 15;
        // The only two segments specific enough to ground a family sentence without inventing
        // details (rule #12).
        const segmentReason = signals.segmentoGrupoFamiliar === 'FAMILIA MONOPARENTAL'
          ? `Tienes ${signals.beneficiaries} personas a cargo — como cabeza de familia monoparental, proteger tu ingreso es esencial para tu hogar`
          : signals.segmentoGrupoFamiliar === 'FAMILIA NUCLEAR INTEGRAL'
            ? `Tienes ${signals.beneficiaries} personas a cargo — proteger tu ingreso asegura la estabilidad de tu hogar`
            : null;
        addReason(QuotingService.REASON_WEIGHT.tier, segmentReason ?? `Tienes ${signals.beneficiaries} personas a cargo — proteger ese ingreso es la necesidad más directa`);
      }
    }

    if (product.category === 'accidentes' && !hasDependents && highIncome && product.id === 'accidentes-premium') {
      matchScore += 20;
      addReason(QuotingService.REASON_WEIGHT.tier, 'Tu ingreso permite una cobertura ampliada — Accidentes premium suma gastos médicos mayores e indemnización más alta');
    }

    matchScore = Math.min(matchScore, 100);

    // Array.sort is stable, so equal weights keep their push order — a re-rank, not a rescore.
    const reasons = weightedReasons
      .slice()
      .sort((a, b) => b.weight - a.weight)
      .map((r) => r.text);

    return {
      productId: product.id,
      matchScore,
      reasons,
      monthlyPremium: product.basePremium,
      priority: matchScore >= 60 ? 'high' : matchScore >= 30 ? 'medium' : 'low',
    };
  }

  // Maps RANGO_SALARIAL to an approximate monthly budget for insurance. Normalized
  // (trim/case/accents) because the CSV is regenerated upstream. The previous keys matched
  // NO real value: "Entre 1 y 1.5 SMLV", 65% of rows, silently got no boost at all.
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
      // 'hogar' has no dedicated product in the real catalog, and asistencias-multiples
      // explicitly covers "asistencia en el hogar" — so a hogar signal cross-sells there.
      asistencia: ['asistencia', 'vida', 'hogar'],
      mascotas: ['mascotas'],
    };
    return related[a]?.includes(b) ?? false;
  }
}
