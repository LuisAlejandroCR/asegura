interface InsuranceIntent {
  productCategory: 'vida' | 'hogar' | 'accidentes' | 'asistencia' | 'mascotas' | null;
  petType?: 'gato' | 'perro' | 'mixto' | null;
  coverage: string[];
  beneficiaries: number;
  urgency: 'immediate' | 'exploring';
  budget?: number;
  abandonIntent?: boolean;
  priceObjection?: boolean;
  whyThisProduct?: string;
  isAffirmative: boolean;
  isNegative: boolean;
  wantsAlternative: boolean;
  petResolution: 'gato' | 'perro' | 'all' | null;
}

interface INlpProvider {
  extractIntent(text: string): Promise<InsuranceIntent>;
}

export { InsuranceIntent, INlpProvider };