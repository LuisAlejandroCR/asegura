// nlp/types.ts: the NLP boundary — InsuranceIntent (what the agent needs extracted from a
// message) and INlpProvider, so a provider can be swapped without touching the agent.

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
  // A single pet described alone; `pets` below covers one OR several in the same message.
  petName?: string | null;
  petAge?: string | null;
  petBreed?: string | null;
  // One entry per pet described in the same message, so nobody is forced into one per turn.
  pets?: { name: string | null; age: string | null; breed: string | null }[];
  // The deterministic cross-check always wins here, same as petCount/petType.
  dependents?: number | null;
}

interface INlpProvider {
  extractIntent(text: string, history?: Array<{ role: string; text: string }>): Promise<InsuranceIntent>;
}

export { InsuranceIntent, INlpProvider };
