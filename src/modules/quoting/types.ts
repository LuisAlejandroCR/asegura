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