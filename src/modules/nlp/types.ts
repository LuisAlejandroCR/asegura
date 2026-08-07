// types.ts: the NLP boundary — InsuranceIntent (what the agent needs extracted from a
// message) and INlpProvider, so Groq or Ollama can be swapped without touching the agent.

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
  // 2026-07-26 — answer to the new DISCOVERY "¿cuántas personas dependen de ti?"
  // question. Deterministic cross-check always wins, same override policy as
  // petCount/petType (never trust the model alone) — see groq-nlp.service.ts.
  dependents?: number | null;
}

interface INlpProvider {
  extractIntent(text: string, history?: Array<{ role: string; text: string }>): Promise<InsuranceIntent>;
}

export { InsuranceIntent, INlpProvider };