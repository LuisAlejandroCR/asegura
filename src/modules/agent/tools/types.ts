// tools/types.ts: the contract every agent capability shares, so the text channel and the
// voice worker call one implementation instead of two. Logic functions stay free of any
// channel SDK type — the LiveKit wrapper lives in src/voice-agent.

import { ConversationContext } from '../types';

// Deps are passed in rather than injected: the voice worker runs outside NestJS DI.
export interface ToolDeps {
  quoting: import('../../quoting/quoting.service').QuotingService;
  affiliates?: { findBySerie(serie: string): unknown; isEnabled(): boolean };
  policies?: { issue(conversationId: string, context: ConversationContext): Promise<{ policyId: string }> };
  payments?: {
    isEnabled: boolean;
    createPaymentLink(params: { policyId: string; productName: string; amountCOP: number }): Promise<{ checkoutUrl: string }>;
  };
}

// A refusal is a value, not an exception: the model has to be able to read why and say it.
export type ToolOutcome<T> = ({ ok: true } & T) | { ok: false; motivo: string };

export const NOT_AUTHORIZED =
  'La persona todavía no ha autorizado el tratamiento de sus datos (Ley 1581). Pídelo antes de continuar.';

// Ley 1581 as a precondition of the code path, not an instruction the model may skip. The
// text channel has an AUTHORIZATION state for this; voice had only a prompt rule until now.
export function requireAuthorization(context: ConversationContext): { ok: false; motivo: string } | null {
  return context.autorizado === true ? null : { ok: false, motivo: NOT_AUTHORIZED };
}
