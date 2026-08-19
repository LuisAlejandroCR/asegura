// emitir-poliza.tool.ts: issues the policy row. Money and PII, so authorization and the
// captured data are preconditions here — never something the model is trusted to check.

import { ConversationContext } from '../types';
import { ToolDeps, ToolOutcome, requireAuthorization } from './types';
import { isValidCedula, isValidEmail, isValidName } from './validar-datos.tool';

export function emitirPolizaLogic(
  deps: Pick<ToolDeps, 'policies'>,
  conversationId: string,
  context: ConversationContext,
): Promise<ToolOutcome<{ policyId: string }>> {
  const denied = requireAuthorization(context);
  if (denied) return Promise.resolve(denied);

  const faltan: string[] = [];
  if (!context.cedula || !isValidCedula(context.cedula)) faltan.push('cédula');
  if (!context.nombre || !isValidName(context.nombre)) faltan.push('nombre');
  if (context.email && !isValidEmail(context.email)) faltan.push('correo');
  if (!context.quoteProductId) faltan.push('el producto cotizado');
  if (faltan.length) {
    return Promise.resolve({ ok: false, motivo: `Falta ${faltan.join(', ')} antes de emitir.` });
  }
  if (!deps.policies) {
    return Promise.resolve({ ok: false, motivo: 'La emisión de pólizas no está disponible en este canal.' });
  }

  return deps.policies
    .issue(conversationId, context)
    .then((policy) => ({ ok: true as const, policyId: policy.policyId }))
    .catch((err) => ({ ok: false as const, motivo: `No se pudo emitir la póliza: ${err}` }));
}
