// persistent-context.ts: This script is for defining which ConversationContext fields
// survive a conversation restart (ABANDONED/REJECTED -> GREETING) -- the durable "what we
// already know about this person" facts (Diseño preguntas.docx: "Memoria Permanente...
// la siguiente conversación nunca debe empezar desde cero"), as opposed to session-scoped
// state (the current quote in progress, one-shot KYC gates, etc.) that must reset for a
// fresh inquiry.
//
// This app has no separate "session" table -- ConversationService keeps a single row per
// (user_id, channel) for the whole relationship (see conversation.service.ts findByUser).
// So "remembering across conversations" here means: don't wipe that one row's context to
// {} on restart, carry the persistent subset forward instead.
import { ConversationContext } from './types';

// Deliberately excludes `autorizado` (Ley 1581 consent is re-confirmed each time a fresh
// authorization flow starts, never assumed) and `productCategory` (what someone wants
// THIS time can differ from last time -- only the underlying facts that inform scoring
// persist, not the last-asked category).
//
// 2026-07-26 -- also deliberately excludes `petType`, `petSpeciesCounts`, and `pets`
// (real live-test bug, screenshot): these used to persist on the same "durable fact"
// reasoning as dependents/budget, but that broke the very question they answer. Tapping
// "Mi mascota" on a FRESH post-restart conversation set productCategory='mascotas' fresh
// (never persisted, same as always) while a stale `petType` (e.g. narrowed to 'perro' by
// an earlier, unrelated inquiry) and `petSpeciesCounts` from before silently survived --
// together they satisfied every gate in handleDiscovery's mixto-clarification flow with
// zero re-confirmation, jumping straight to a one-species quote for a species/count
// breakdown the user never restated this conversation. Unlike dependents/budget/cedula
// (facts about the PERSON that don't change turn to turn), petType/petSpeciesCounts/pets
// describe THIS SPECIFIC inquiry's resolution -- exactly like productCategory, a fresh
// mascota inquiry may legitimately differ (a different pet, a different species split)
// and must always re-ask, never silently reuse. `petCount` (a plain total, often
// pre-filled straight from the affiliate CSV's own PET_COUNT column -- a genuine
// standalone fact about the person, not derived from this conversation) still persists;
// it never gates or skips the species question on its own.
const PERSISTENT_FIELDS = [
  'petCount',
  'dependents', 'beneficiaries', 'budget',
  'cedula', 'documentType', 'nombre', 'email', 'phoneVerified', 'verifiedPhone',
  'hasCompletedPurchase', 'policyIds',
  // 2026-07-26 — durable purchase-history record (see the field comment in types.ts) —
  // unlike policyIds, this is never reset for a new purchase, so it's what a post-restart
  // "¿qué cubre mi póliza?" question actually has left to answer from.
  'purchasedProductIds',
  // 2026-07-26 — the affiliate's own historical salary band never changes turn to turn;
  // re-doing the ID lookup on every restart would be pointless when we already have it.
  'rangoSalarial', 'serieId', 'segmentoGrupoFamiliar',
  // 2026-07-26 — the full affiliate CSV row (see types.ts's field comment) is exactly
  // the kind of durable "what Colsubsidio already knows about this person" fact this
  // allowlist exists for — re-doing the SERIE lookup on every restart would be pointless.
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
