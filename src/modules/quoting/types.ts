interface InsuranceProduct {
  id: string;
  name: string;
  category: string;
  insurer: string;
  basePremium: number;
  url: string;
  coverages: string[];
  eligibility: { minAge?: number; maxAge?: number; family?: boolean; pet?: string };
}

interface InsuranceScore {
  productId: string;
  matchScore: number;
  reasons: string[];
  monthlyPremium: number;
  priority: 'high' | 'medium' | 'low';
}

interface AffiliateSignals {
  productCategory?: string | null;
  petType?: 'gato' | 'perro' | 'mixto' | null;
  coverage?: string[];
  beneficiaries?: number;
  budget?: number | null;
  edad?: number;
  depends?: string;
}

export { InsuranceProduct, InsuranceScore, AffiliateSignals };