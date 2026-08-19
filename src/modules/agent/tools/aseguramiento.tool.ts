// aseguramiento.tool.ts: the underwriting questions vida and the pet prepaid plans require
// before a policy may be issued. Kept as a precondition of emitirPoliza rather than a prompt
// rule — the same reason Ley 1581 lives in the contract.

import { ConversationContext } from '../types';
import { ToolDeps, ToolOutcome, requireAuthorization } from './types';

// Mirrors the state machine: an explicit multi-product selection wins over the single quote.
export function productsInPlay(context: ConversationContext): string[] {
  if (context.selectedProductIds?.length) return context.selectedProductIds;
  return context.quoteProductId ? [context.quoteProductId] : [];
}

export function requiresUnderwriting(
  deps: Pick<ToolDeps, 'catalog'>,
  context: ConversationContext,
): boolean {
  if (!deps.catalog) return false;
  return productsInPlay(context).some((id) => deps.catalog?.getProduct(id)?.requiresUnderwriting === true);
}

export function registrarAseguramientoLogic(
  deps: Pick<ToolDeps, 'catalog'>,
  context: ConversationContext,
  args: { respuestas: string },
): ToolOutcome<{ registrado: true }> {
  const denied = requireAuthorization(context);
  if (denied) return denied;

  if (!requiresUnderwriting(deps, context)) {
    return { ok: false, motivo: 'Este producto no requiere preguntas de aseguramiento.' };
  }
  const respuestas = (args.respuestas ?? '').trim();
  if (respuestas.length < 2) {
    return { ok: false, motivo: 'Necesito la respuesta de la persona sobre su estado de salud.' };
  }
  return { ok: true, registrado: true };
}
