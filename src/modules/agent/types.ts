// types.ts: the conversation domain model — ConversationState, ConversationContext
// (everything remembered about the person mid-flow), PetDetail and DocumentType.

import type { AffiliateRecord } from '../quoting/affiliate-lookup.service';

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
  // Live bug: two conversations with a Wompi-approved purchase ended up 'abandoned' after
  // the customer declined to buy more. policyIds are reset for the next purchase and
  // awaitingCrossSellResponse is one-shot, so neither survives to tell abandonIntent
  // "already bought". Set once by wompi-webhook.controller.ts, never cleared.
  hasCompletedPurchase?: boolean;
  // 2+ products in one purchase: each gets its own policy row and PDF, one shared Wompi
  // payment. Falls back to quoteProductId when unset. Nothing sets this automatically
  // anymore (2026-07-24 "restore the flow"); kept because it degrades cleanly to single.
  selectedProductIds?: string[];
  policyId?: string;
  policyIds?: string[];
  // Accumulates every product id ever ISSUED here and is never reset, unlike policyIds.
  // It's what a later "¿qué cubre mi póliza?" in COMPLETED reads from.
  purchasedProductIds?: string[];
  checkoutUrl?: string;
  // Set the instant DATA_CAPTURE starts: the next message is expected to be a contact
  // share, not an answer to a data-capture question. Cleared once verified.
  awaitingPhoneVerification?: boolean;
  // Phone shared via Telegram's native request_contact. 2026-07-24 KYC feedback: proves
  // the user is real without SMS/Twilio — Telegram already verified the number and
  // guarantees it's the tapping user's own. Enough for a low-stakes micro-insurance
  // purchase. Persists across cross-sell so a returning customer isn't re-asked.
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
  // Set only when ReminderService auto-closes after silence — distinguishes a stalled chat
  // from a manual decline (a plain "no"), which doesn't set this.
  // 'insufficient_info': quiet before a productCategory existed, nothing to quote.
  // 'no_response': quiet after that — the agent could act, the person never answered.
  abandonReason?: 'insufficient_info' | 'no_response';
  // 2026-07-26 — set ONLY in AUTHORIZATION→isAffirmative, right after a fresh "sí". Acts
  // as a firewall: existing DISCOVERY contexts (specs, cross-sell follow-up) never set it,
  // so the `dependents` question never fires for them and a returning buyer isn't
  // re-interrogated.
  discoveryFilter?: boolean;
  // 2026-08-12 (plan-17 §11) — set the moment DISCOVERY entry offers the AseguraWeb
  // "¿hablar o escribir?" choice (only when WEB_APP_URL is configured). One-shot: the
  // NEXT message is interpreted as answering it, whatever it says, then always cleared —
  // an unrecognized reply falls through to the normal F01 category choices, never lost.
  awaitingWebModalityChoice?: boolean;
  // 2026-08-12 (plan-17 §12) — set once a texto.html/voz.html link was actually sent
  // (resolveWebModalityChoice), never cleared. Lets createPaymentLinkFlow mint a FRESH
  // web-session token and pass Wompi's real redirect_url param so checkout returns the
  // browser to the SAME page instead of leaving it stranded on Wompi's own confirmation
  // screen — only set for a session that's actually using AseguraWeb.
  webModality?: 'voz' | 'texto';
  // Live-captured signal for QuotingService's hyper-personalization tier. 0 is a real
  // answer ("vivo solo"); undefined means never asked.
  dependents?: number;
  // One-shot guard: asked at most once, set in the SAME return that asks it, so the next
  // turn quotes whether or not the answer parsed (never-loop-forever, like every KYC gate).
  askedDependents?: boolean;
  // 2026-07-26 — set right after AUTHORIZATION's "sí". One-shot: the next message is
  // either an ID to look up or a decline, never asked again. Never blocks — a miss and a
  // decline both proceed to DISCOVERY identically, just without the rangoSalarial boost.
  awaitingAffiliateId?: boolean;
  // The SERIE the user provided, IF a lookup succeeded — kept for reference/debugging,
  // not read by scoring directly (rangoSalarial below is what QuotingService uses).
  serieId?: string;
  // 2026-07-26 (Matriz 2, C05) — inferred by the NLP from "urgente"/"ya", never captured
  // before. NOT persistent: it reflects the moment, not the person, so a restart re-derives
  // it like productCategory.
  urgency?: 'immediate' | 'exploring';
  // Income signal from the affiliate's historical record. Its scoring consumer
  // (QuotingService.budgetFromSalary) was unreachable live until this got populated.
  rangoSalarial?: string;
  // 2026-07-26 — family segment from the affiliate CSV (e.g. FAMILIA MONOPARENTAL,
  // FAMILIA NUCLEAR INTEGRAL). Populated by handleAffiliateId when the lookup succeeds;
  // passed through to AffiliateSignals for personalized recommendation reasons.
  segmentoGrupoFamiliar?: string;
  // 2026-07-26 — the FULL affiliate CSV row, not just the two fields wired into scoring
  // above. Captured verbatim (rule #12) and persisted across restarts. See
  // affiliate-lookup.service.ts for which parts are consumed vs. only captured.
  affiliateProfile?: AffiliateRecord;
  // Last N conversation exchanges for LLM context (role + text). Trimmed to
  // MAX_HISTORY_LENGTH on each save. Session-scoped (not in PERSISTENT_FIELDS) so a
  // restart starts fresh — durable facts already live in the other persistent fields.
  lastMessages?: Array<{ role: 'user' | 'agent'; text: string }>;
  // 2026-07-26 — consecutive turns the agent failed to understand. Reset to 0 on any
  // understood turn; at the threshold it hands off to a human instead of repeating itself
  // a 4th time. NOT persistent: it describes this session's confusion, not the person.
  consecutiveUnclearReplies?: number;
  // Set when a pet-specific product has been exhausted and the waitlist offer is shown
  // to the user ("no tenemos más oferta, ¿compartes tus datos?").
  awaitingContactConsent?: boolean;
  // Contact info collection flags for the waitlist flow — set sequentially as each field
  // is collected (name → email → phone), before the conversation returns to QUOTE_PRESENTED.
  awaitingContactName?: boolean;
  awaitingContactEmail?: boolean;
  awaitingContactPhone?: boolean;
  // Captured contact info from the waitlist flow.
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
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