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

    if (signals.beneficiaries && product.eligibility.family) {
      matchScore += 20;
      reasons.push(`Cubre a ${signals.beneficiaries} personas`);
    }

    if (signals.budget && product.basePremium <= signals.budget) {
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

    matchScore = Math.min(matchScore, 100);

    return {
      productId: product.id,
      matchScore,
      reasons,
      monthlyPremium: product.basePremium,
      priority: matchScore >= 60 ? 'high' : matchScore >= 30 ? 'medium' : 'low',
    };
  }

  private isRelatedCategory(a: string, b: string): boolean {
    const related: Record<string, string[]> = {
      vida: ['vida', 'accidentes'],
      accidentes: ['accidentes', 'vida'],
      asistencia: ['asistencia', 'vida'],
      mascotas: ['mascotas'],
    };
    return related[a]?.includes(b) ?? false;
  }
}