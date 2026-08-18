// quoting/types.ts: the quoting domain — AffiliateSignals (the profile scoring reads),
// InsuranceProduct, InsuranceScore, and the IProductRepository the catalog implements.

interface InsuranceProduct {
  id: string;
  name: string;
  category: string;
  insurer: string;
  basePremium: number;
  url: string;
  coverages: string[];
  eligibility: { minAge?: number; maxAge?: number; family?: boolean; pet?: string };
  // Current priority for sale: a small scoring tie-breaker, never a hard filter.
  businessPriority?: boolean;
  // Needs age, pre-existing illnesses and clinical history before issuing — enforced by
  // DATA_CAPTURE, not by the scoring engine.
  requiresUnderwriting?: boolean;
}

interface InsuranceScore {
  productId: string;
  matchScore: number;
  reasons: string[];
  monthlyPremium: number;
  priority: 'high' | 'medium' | 'low';
}

// Salary ranges as published in the affiliate CSV's RANGO_SALARIAL column
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
  // Salary segment, used as a budget proxy when no explicit budget is known.
  rangoSalarial?: RangoSalarial;
  // A real, live-captured signal, unlike `beneficiaries` — Groq often echoes the 1 from its
  // own schema example. 0 is deliberate; undefined means the question was never asked.
  dependents?: number;
  // Family segment from the affiliate CSV, used in the personalized recommendation reasons.
  segmentoGrupoFamiliar?: string;
  // Inferred by the NLP from words like "urgente"/"ya" — no extra question needed to get it.
  urgency?: 'immediate' | 'exploring';
}

// The adapter boundary (rule #6) between the scoring engine and wherever the catalog lives
// — today catalog/products/*.yaml via ProductCatalog, tomorrow possibly Supabase.
interface IProductRepository {
  getProducts(): InsuranceProduct[];
  getProduct(id: string): InsuranceProduct | undefined;
}

export { InsuranceProduct, InsuranceScore, AffiliateSignals, IProductRepository };
