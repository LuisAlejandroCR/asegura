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

// Colombian ID documents — not everyone has a CC: CE (extranjería), TI (minors), and the
// NIP/NUIP numbering used for newborns and special cases.
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
  // Per-species counts for a mixed household: one quoteProductId × a combined petCount
  // priced "2 dogs + 1 cat" as 3 cats.
  petSpeciesCounts?: { gato?: number; perro?: number };
  pets?: PetDetail[];
  petsAwaitingConfirmation?: boolean;
  cedula?: string;
  documentType?: DocumentType;
  nombre?: string;
  email?: string;
  // The summary was rejected without naming the wrong field; the next message names it,
  // so only that field resets.
  awaitingCorrectionField?: boolean;
  // A category mentioned while a quote is still pending: offered only after that policy
  // is issued and paid, never by interrupting the current purchase.
  pendingCrossSell?: string | null;
  // A decline here has to end the conversation politely, not fall through to DISCOVERY's
  // generic "no entendí", which read as the agent ignoring a clear "I'm done".
  awaitingCrossSellResponse?: boolean;
  // Never cleared: the only signal that lets abandonIntent tell "already bought" from
  // "never bought" once policyIds have been reset for the next purchase.
  hasCompletedPurchase?: boolean;
  // 2+ products in one purchase: a policy row and PDF each, one shared Wompi payment.
  selectedProductIds?: string[];
  policyId?: string;
  policyIds?: string[];
  // Never reset, unlike policyIds: what a later "¿qué cubre mi póliza?" reads from.
  purchasedProductIds?: string[];
  checkoutUrl?: string;
  // The next message is expected to be a contact share, not an answer to a question.
  awaitingPhoneVerification?: boolean;
  // Phone from Telegram's native request_contact — Telegram already verified the number
  // belongs to the person tapping. Persists across cross-sell.
  phoneVerified?: boolean;
  verifiedPhone?: string;
  // Cosmetic step: no face matching, no liveness detection, just "a photo was received".
  // A real deployment would swap this for a third-party identity provider.
  awaitingSelfie?: boolean;
  selfieProvided?: boolean;
  // One gentle retry for a suspiciously tiny photo; any reply after it is accepted.
  selfieRetryAsked?: boolean;
  // Wording only: both choices route to the same real Wompi checkout link.
  awaitingPaymentMethodChoice?: boolean;
  paymentMethodChoice?: 'tarjeta_colsubsidio' | 'link_pago';
  // vida and both medicina prepagada need age and clinical history before issuing. Asked
  // once, stored verbatim — informational, not a gate.
  awaitingMedicalInfo?: boolean;
  medicalInfoProvided?: boolean;
  medicalInfo?: string;
  // Set only when ReminderService auto-closes after silence, never by a plain "no".
  // 'insufficient_info': quiet before there was anything to quote. 'no_response': quiet after.
  abandonReason?: 'insufficient_info' | 'no_response';
  // Set only on a fresh AUTHORIZATION "sí", so a returning buyer is never re-interrogated.
  discoveryFilter?: boolean;
  // One-shot: the next message answers it, then it clears — an unrecognized reply falls
  // through to the normal F01 choices instead of being lost.
  awaitingWebModalityChoice?: boolean;
  // Also drives Wompi's redirect_url, so checkout returns the browser to the same page.
  webModality?: 'voz' | 'texto';
  // 0 is a real answer ("vivo solo"); undefined means never asked.
  dependents?: number;
  // One-shot: set in the same return that asks it, so a failed parse never loops.
  askedDependents?: boolean;
  // One-shot; a miss and a decline both proceed to DISCOVERY identically.
  awaitingAffiliateId?: boolean;
  // Kept for reference; scoring reads rangoSalarial, not this.
  serieId?: string;
  // Not persistent: it reflects the moment, not the person.
  urgency?: 'immediate' | 'exploring';
  // Income signal, consumed by QuotingService.budgetFromSalary.
  rangoSalarial?: string;
  // Family segment from the affiliate CSV, used in the recommendation reasons.
  segmentoGrupoFamiliar?: string;
  // The full affiliate CSV row, captured verbatim and persisted across restarts.
  affiliateProfile?: AffiliateRecord;
  // Session-scoped (not in PERSISTENT_FIELDS): a restart starts fresh.
  lastMessages?: Array<{ role: 'user' | 'agent'; text: string }>;
  // Reset on any understood turn; at the threshold the agent hands off to a human.
  consecutiveUnclearReplies?: number;
  awaitingContactConsent?: boolean;
  // Waitlist flow, set sequentially: name → email → phone.
  awaitingContactName?: boolean;
  awaitingContactEmail?: boolean;
  awaitingContactPhone?: boolean;
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
