enum ConversationState {
  GREETING = 'greeting',
  AUTHORIZATION = 'authorization',
  DISCOVERY = 'discovery',
  QUOTING = 'quoting',
  QUOTE_PRESENTED = 'quote_presented',
  DATA_CAPTURE = 'data_capture',
  PAYMENT = 'payment',
  POLICY_ISSUED = 'policy_issued',
  COMPLETED = 'completed',
  ABANDONED = 'abandoned',
  REJECTED = 'rejected',
}

interface PetDetail {
  name: string;
  age: string;
  breed: string;
}

// Colombian ID document types — not everyone has a CC (cédula de ciudadanía):
// CE = cédula de extranjería, TI = tarjeta de identidad (minors), NIP/NUIP = the
// numbering schemes used for newborns/special cases.
type DocumentType = 'CC' | 'CE' | 'TI' | 'NIP' | 'NUIP';

interface ConversationContext {
  autorizado?: boolean;
  productCategory?: string | null;
  petType?: 'gato' | 'perro' | 'mixto' | null;
  coverage?: string[];
  beneficiaries?: number;
  budget?: number | null;
  quoteProductId?: string;
  shownProductIds?: string[];
  petCount?: number | null;
  // Per-species breakdown for a mixed household (2026-07-24 live bug: "2 dogs + 1 cat"
  // was quoted and charged as 3 cats — a single quoteProductId x total petCount can't
  // represent a mixto household with species-specific products/prices). Set when a
  // mixto message names explicit counts per species; used to quote/charge each
  // species-specific product against its OWN count instead of the combined total.
  petSpeciesCounts?: { gato?: number; perro?: number };
  pets?: PetDetail[];
  // Set once all pets are collected and the summary is shown, awaiting "sí" or a
  // per-pet correction, before moving on to the human's own cédula/nombre/correo.
  petsAwaitingConfirmation?: boolean;
  cedula?: string;
  documentType?: DocumentType;
  nombre?: string;
  email?: string;
  // Set when the user rejected the DATA_CAPTURE summary without naming which field is
  // wrong — the next message is interpreted as naming it, so only that field resets
  // instead of forcing cédula+nombre+correo to be redone from scratch.
  awaitingCorrectionField?: boolean;
  // Set when the user mentions wanting a different category while a quote is still
  // pending confirmation (e.g. "para mí, qué hay" while viewing a mascotas quote) — the
  // current purchase is NOT interrupted; this category is offered as a follow-up only
  // after the current policy is issued and paid (see wompi-webhook.controller.ts).
  pendingCrossSell?: string | null;
  // Set by wompi-webhook.controller.ts right after a purchase, when it asks "¿Quieres
  // proteger algo más?" (or the pendingCrossSell-specific variant) — a decline here
  // ("No, está bien así.") must end the conversation politely instead of falling through
  // to DISCOVERY's generic "no entendí" acknowledgment, which read as the agent ignoring
  // a clear "I'm done" (real live-test bug, 2026-07-24).
  awaitingCrossSellResponse?: boolean;
  // Real live-test bug: two production conversations that had ALREADY completed a real,
  // Wompi-approved purchase ended up with conversations.state = 'abandoned' after the
  // customer later declined to buy anything more — policyId/policyIds are NOT carried
  // into the post-purchase followUpContext (they're purchase-specific, reset for the next
  // one), and awaitingCrossSellResponse is a one-shot flag cleared after a single turn, so
  // neither survives long enough to tell processMessage's abandonIntent check "this person
  // already bought something" a few turns later. This flag is set once, permanently, by
  // wompi-webhook.controller.ts on the first real payment approval and never cleared —
  // "abandoned before buying anything" and "bought something, then declined more" must
  // never share a conversation status.
  hasCompletedPurchase?: boolean;
  // Set when the user is buying 2+ products together in one purchase (e.g. "quiero los
  // dos") — each gets its own policy row and PDF, sharing one combined Wompi payment.
  // Falls back to quoteProductId (single) when unset/empty. Nothing in the live agent
  // flow sets this automatically anymore (see 2026-07-24 "restore the flow" change) —
  // the underlying multi-policy/one-payment machinery is kept because it degrades
  // cleanly to the single-product case, not because it's actively triggered.
  selectedProductIds?: string[];
  policyId?: string;
  policyIds?: string[];
  checkoutUrl?: string;
  // Set the instant DATA_CAPTURE starts, before phoneVerified is true — signals that the
  // next message is expected to be a Telegram contact-share (or another attempt) rather
  // than an answer to any real data-capture question. Cleared once verified.
  awaitingPhoneVerification?: boolean;
  // True once the user has shared their Telegram-verified phone number via the native
  // request_contact button. 2026-07-24 KYC feedback: "know the user is real" without a
  // separate SMS/Twilio provider — Telegram already verified this phone number when the
  // account was created, so a self-attested contact share (guaranteed by Telegram to be
  // the tapping user's own number, not an arbitrary forwarded card) is treated as
  // sufficient identity signal for a low-stakes micro-insurance purchase. Persisted across
  // a post-purchase cross-sell follow-up so a returning customer isn't asked to re-verify.
  phoneVerified?: boolean;
  verifiedPhone?: string;
  // Cosmetic/simulated selfie step (2026-07-24) — asked right after phone verification.
  // NOT a real identity check: no face matching, no liveness detection, just "a photo
  // was received." Placeholder to demonstrate the concept for judges/mentors; a real
  // deployment would swap this for an actual third-party identity-verification provider
  // to guard against a fake identity (see flujo-conversacional.md's KYC section).
  awaitingSelfie?: boolean;
  selfieProvided?: boolean;
  // Set after one gentle "that image looks too small" retry ask for a suspiciously tiny
  // photo (2026-07-24 feedback) — no real face detection, just a width/height sanity
  // check. Any reply after this (even another tiny photo) is accepted, same
  // never-loop-forever guarantee as every other KYC gate above.
  selfieRetryAsked?: boolean;
  // Payment method wording choice (2026-07-24 feedback) — "Tarjeta Colsubsidio" and
  // "link_pago" route to the exact same real Wompi checkout link; this only changes the
  // surrounding copy. Not a second payment rail, and never claims the payment already
  // succeeded before the user has actually paid via the link.
  awaitingPaymentMethodChoice?: boolean;
  paymentMethodChoice?: 'tarjeta_colsubsidio' | 'link_pago';
  // Conditional underwriting (2026-07-24 business feedback) — vida and both medicina
  // prepagada (gatos/perros) products need age, pre-existing illnesses, and clinical
  // history before the policy can be issued; every other product is direct-sell
  // (cédula/nombre/correo only). Asked once, right after correo — any reply is accepted
  // and stored verbatim (informational, not a structural gate like the KYC steps above).
  awaitingMedicalInfo?: boolean;
  medicalInfoProvided?: boolean;
  medicalInfo?: string;
}

interface Conversation {
  id: string;
  user_id: string;
  channel: string;
  state: ConversationState;
  context: ConversationContext;
  created_at: string;
  updated_at: string;
}

export { ConversationState, ConversationContext, Conversation, PetDetail, DocumentType };