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
  petCount?: number | null;
  // Extracted when the user answers "nombre, edad y raza" for the pet currently
  // being registered (DATA_CAPTURE's per-pet detail loop).
  petName?: string | null;
  petAge?: string | null;
  petBreed?: string | null;
}

interface INlpProvider {
  extractIntent(text: string): Promise<InsuranceIntent>;
}

export { InsuranceIntent, INlpProvider };