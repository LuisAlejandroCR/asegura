interface InsuranceProduct {
  id: string;
  name: string;
  category: string;
  insurer: string;
  basePremium: number;
  url: string;
  coverages: string[];
  eligibility: { minAge?: number; maxAge?: number; family?: boolean; pet?: string };
  // 2026-07-24 business feedback: these 7 products are the current priority for sale —
  // used as a small scoring tie-breaker, never a hard filter.
  businessPriority?: boolean;
  // 2026-07-24 business feedback: requires conditional underwriting (age, pre-existing
  // illnesses, clinical history) before the policy can be issued — checked by
  // AgentService's DATA_CAPTURE flow, not by the scoring engine itself.
  requiresUnderwriting?: boolean;
}

interface InsuranceScore {
  productId: string;
  matchScore: number;
  reasons: string[];
  monthlyPremium: number;
  priority: 'high' | 'medium' | 'low';
}

// Salary ranges from Usos_Productos_Afiliados_SIN_ID.xlsx RANGO_SALARIAL column
type RangoSalarial =
  | 'Hasta 2 SMLV'
  | 'Entre 2 y 4 SMLV'
  | 'Entre 4 y 6 SMLV'
  | 'Entre 6 y 8 SMLV'
  | 'Entre 8 y 10 SMLV'
  | 'Más de 10 SMLV'
  | string;

interface AffiliateSignals {
  productCategory?: string | null;
  petType?: 'gato' | 'perro' | 'mixto' | null;
  coverage?: string[];
  beneficiaries?: number;
  budget?: number | null;
  edad?: number;
  depends?: string;
  // From xlsx: salary segment used as budget proxy when explicit budget unknown
  rangoSalarial?: RangoSalarial;
}

export { InsuranceProduct, InsuranceScore, AffiliateSignals };