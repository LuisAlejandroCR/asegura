// escalar.tool.ts: handing the conversation to a person. Two ways in — the model asking, and
// the router counting turns where every tool refused — because a model that is stuck rarely
// says so, and the state machine escalated on a count for exactly that reason.

import { ConversationContext } from '../types';
import { ToolOutcome } from './types';

export const ESCALATION_THRESHOLD = 3;

export const ESCALATION_TEXT =
  'Parece que no te estoy ayudando bien, serás redirigido a mi líder de servicio 🙏';

export function escalarAHumanoLogic(
  context: ConversationContext,
  args: { motivo: string },
): ToolOutcome<{ texto: string; motivo: string }> {
  const motivo = (args.motivo ?? '').trim();
  if (!motivo) {
    return { ok: false, motivo: 'Dime por qué hay que escalar, para pasárselo a la persona que atienda.' };
  }
  return { ok: true, texto: ESCALATION_TEXT, motivo };
}

// A turn where every tool call was refused is the router's version of "I did not understand":
// the person keeps giving something the contract cannot accept.
export function contarTurnoFallido(
  context: ConversationContext,
  todosRechazados: boolean,
): { consecutiveUnclearReplies: number; debeEscalar: boolean } {
  const previos = context.consecutiveUnclearReplies ?? 0;
  const count = todosRechazados ? previos + 1 : 0;
  return { consecutiveUnclearReplies: count, debeEscalar: count >= ESCALATION_THRESHOLD };
}
