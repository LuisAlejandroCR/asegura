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
const PERSISTENT_FIELDS = [
  'petType', 'petCount', 'pets', 'petSpeciesCounts',
  'dependents', 'beneficiaries', 'budget',
  'cedula', 'documentType', 'nombre', 'email', 'phoneVerified', 'verifiedPhone',
  'hasCompletedPurchase', 'policyIds',
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
