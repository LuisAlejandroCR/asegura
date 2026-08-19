// generar-link-pago.tool.ts: turns an issued policy into a Wompi checkout URL. The amount
// comes from the catalog through the quoting engine, never from the model (rule #12).

import { ConversationContext } from '../types';
import { ToolDeps, ToolOutcome, requireAuthorization } from './types';

export function generarLinkPagoLogic(
  deps: Pick<ToolDeps, 'payments' | 'quoting'>,
  context: ConversationContext,
  args: { policyId: string },
): Promise<ToolOutcome<{ checkoutUrl: string }>> {
  const denied = requireAuthorization(context);
  if (denied) return Promise.resolve(denied);
  if (!args.policyId) {
    return Promise.resolve({ ok: false, motivo: 'Primero hay que emitir la póliza.' });
  }
  // A second link for the same policy is a second charge waiting to happen: hand back the one
  // already issued. The state machine does this; a tool-driven engine has to as well.
  if (context.checkoutUrl) {
    return Promise.resolve({ ok: true, checkoutUrl: context.checkoutUrl });
  }
  if (!deps.payments?.isEnabled) {
    return Promise.resolve({ ok: false, motivo: 'El pago en línea no está configurado.' });
  }

  const best = deps.quoting.bestQuote({
    productCategory: (context.productCategory ?? null) as never,
    petType: context.petType ?? undefined,
  });
  if (!best) {
    return Promise.resolve({ ok: false, motivo: 'No hay una cotización vigente para cobrar.' });
  }

  return deps.payments
    .createPaymentLink({
      policyId: args.policyId,
      productName: best.product.name,
      amountCOP: best.score.monthlyPremium,
    })
    .then((link) => ({ ok: true as const, checkoutUrl: link.checkoutUrl }))
    .catch((err) => ({ ok: false as const, motivo: `No se pudo crear el link de pago: ${err}` }));
}
