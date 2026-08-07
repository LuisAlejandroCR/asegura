// persistent-context.ts: This script is for defining which ConversationContext fields
// survive a conversation restart (ABANDONED/REJECTED -> GREETING): durable facts about the
// person, not session-scoped state. Diseño preguntas.docx: "la siguiente conversación nunca
// debe empezar desde cero".
//
// No session table -- ConversationService keeps one row per (user_id, channel), so
// "remembering" means not wiping that row's context to {} on restart.
import { ConversationContext } from './types';

// Excludes `autorizado` (Ley 1581 consent is re-confirmed, never assumed) and
// `productCategory` (what someone wants THIS time can differ).
//
// 2026-07-26 -- also excludes `petType`/`petSpeciesCounts`/`pets` (live bug): stale values
// satisfied every gate in handleDiscovery's mixto flow, jumping straight to a one-species
// quote the user never restated. They describe THIS inquiry, not the person -- always
// re-ask. `petCount` still persists: a plain total from the CSV's PET_COUNT, it never gates.
const PERSISTENT_FIELDS = [
  'petCount',
  'dependents', 'beneficiaries', 'budget',
  'cedula', 'documentType', 'nombre', 'email', 'phoneVerified', 'verifiedPhone',
  'hasCompletedPurchase', 'policyIds',
  // 2026-07-26 — unlike policyIds, never reset for a new purchase: it's what a post-restart
  // "¿qué cubre mi póliza?" has left to answer from.
  'purchasedProductIds',
  // 2026-07-26 — never changes; re-doing the ID lookup on every restart is pointless.
  'rangoSalarial', 'serieId', 'segmentoGrupoFamiliar',
  // 2026-07-26 — full affiliate CSV row: exactly the durable fact this allowlist exists for.
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
