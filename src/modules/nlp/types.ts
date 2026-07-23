interface InsuranceIntent {
  productCategory: 'vida' | 'hogar' | 'accidentes' | 'asistencia' | 'mascotas' | null;
  petType?: 'gato' | 'perro' | null;
  coverage: string[];
  beneficiaries: number;
  urgency: 'immediate' | 'exploring';
  budget?: number;
  abandonIntent?: boolean;
  priceObjection?: boolean;
  whyThisProduct?: string;
}

interface INlpProvider {
  extractIntent(text: string): Promise<InsuranceIntent>;
}

export { InsuranceIntent, INlpProvider };