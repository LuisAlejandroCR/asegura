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
  // 2026-07-26 — a real, live-captured signal (see ConversationContext.dependents,
  // src/modules/agent/types.ts) unlike `beneficiaries`, which Groq's own JSON schema
  // shows as an example value (`"beneficiaries": 1`) the LLM often defaults to even with
  // no real family-size signal in the message. 0 is a meaningful, deliberate answer;
  // undefined means the dependents question was never asked/answered — evaluateProduct
  // falls back to the beneficiaries heuristic only in that undefined case.
  dependents?: number;
  // 2026-07-26 (Matriz 2, C05: "¿Necesitas la protección en los próximos días?") —
  // already inferred by the NLP layer from words like "urgente"/"ya" (InsuranceIntent,
  // nlp/types.ts) but never previously captured into context or read by scoring. No new
  // question needed to wake this: it's a byproduct of language already used in a normal
  // DISCOVERY reply.
  urgency?: 'immediate' | 'exploring';
}

export { InsuranceProduct, InsuranceScore, AffiliateSignals };