// persistent-context.ts: defines which ConversationContext fields survive a restart
// (ABANDONED/REJECTED → GREETING) — durable facts about the person, not session state.
// There is no session table: one row per (user_id, channel) is the whole memory.
import { ConversationContext } from './types';

// Excludes `autorizado` (Ley 1581 consent is re-confirmed, never assumed) and everything
// that describes THIS inquiry rather than the person: productCategory, petType,
// petSpeciesCounts, pets — stale pet values jumped straight to a quote nobody restated.
const PERSISTENT_FIELDS = [
  'petCount',
  'dependents', 'beneficiaries', 'budget',
  'cedula', 'documentType', 'nombre', 'email', 'phoneVerified', 'verifiedPhone',
  'hasCompletedPurchase', 'policyIds',
  'purchasedProductIds',
  'rangoSalarial', 'serieId', 'segmentoGrupoFamiliar',
  'affiliateProfile',
] as const satisfies readonly (keyof ConversationContext)[];

function pickPersistentFields(context: ConversationContext): ConversationContext {
  const persisted: ConversationContext = {};
  for (const field of PERSISTENT_FIELDS) {
    const value = context[field];
    if (value !== undefined) {
      (persisted as Record<string, unknown>)[field] = value;
    }
  }
  return persisted;
}

// True when there's any remembered fact worth a "welcome back" acknowledgment.
function hasRememberedProfile(context: ConversationContext): boolean {
  return PERSISTENT_FIELDS.some((field) => context[field] !== undefined);
}

export { PERSISTENT_FIELDS, pickPersistentFields, hasRememberedProfile };
