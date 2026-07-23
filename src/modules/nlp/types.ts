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
  // being registered (DATA_CAPTURE's per-pet detail loop). Kept for a single pet
  // described alone; `pets` below covers one OR several pets in the same message.
  petName?: string | null;
  petAge?: string | null;
  petBreed?: string | null;
  // One entry per pet described in this message — lets the user describe all their
  // pets in a single turn ("Rocky tiene 5 años y es labrador, y Luna tiene 3 y es
  // siamesa") instead of being forced through one message per pet.
  pets?: { name: string | null; age: string | null; breed: string | null }[];
}

interface INlpProvider {
  extractIntent(text: string): Promise<InsuranceIntent>;
}

export { InsuranceIntent, INlpProvider };