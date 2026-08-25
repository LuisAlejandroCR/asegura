// generar-link-pago.tool.ts: turns an issued policy into a Wompi checkout URL. The amount
// comes from the catalog through the quoting engine, never from the model (rule #12), and it
// prices the product the person ACTUALLY approved — never a fresh "best" one.

import { ConversationContext } from '../types';
import { InsuranceProduct } from '../../quoting/types';
import { computeTotalPremium } from '../../quoting/pricing';
import { ToolDeps, ToolOutcome, requireAuthorization } from './types';

// The right per-pet count for THIS product's price: a species-restricted product uses its own
// species' count from the breakdown, never the combined total. Mirrors the state machine's
// petCountForProduct — the two must agree or the quote and the charge diverge.
function petCountForProduct(
  context: ConversationContext,
  product: InsuranceProduct,
): number | null | undefined {
  if (context.petSpeciesCounts && product.eligibility.pet === 'gato') {
    return context.petSpeciesCounts.gato ?? context.petCount;
  }
  if (context.petSpeciesCounts && product.eligibility.pet === 'perro') {
    return context.petSpeciesCounts.perro ?? context.petCount;
  }
  if (context.petSpeciesCounts && (context.petType === 'gato' || context.petType === 'perro')) {
    return context.petSpeciesCounts[context.petType] ?? context.petCount;
  }
  return context.petCount;
}

export function generarLinkPagoLogic(
  deps: Pick<ToolDeps, 'payments' | 'catalog'>,
  context: ConversationContext,
  args: { policyId: string; redirectUrl?: string },
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

  // This used to call bestQuote(), which re-runs scoring and returns whatever wins NOW —
  // so someone who approved Asistencias múltiples at $20.000 could be charged $12.000 for
  // Vida, while emitir_poliza issued the policy for the product they actually picked. The
  // charge now comes from the same pinned ids the policy does.
  const productIds = context.selectedProductIds?.length
    ? context.selectedProductIds
    : context.quoteProductId
      ? [context.quoteProductId]
      : [];
  const products = productIds
    .map((id) => deps.catalog?.getProduct(id))
    .filter((p): p is InsuranceProduct => !!p);

  if (products.length === 0) {
    // Refusing beats charging: the state machine used to fall back to a flat amount here and
    // billed people for something they were never quoted.
    return Promise.resolve({
      ok: false,
      motivo: 'No hay un producto elegido para cobrar. Usa "seleccionar_producto" antes.',
    });
  }

  const amountCOP = products.reduce(
    (sum, p) => sum + computeTotalPremium(p, petCountForProduct(context, p)),
    0,
  );
  const productName =
    products.length > 1 ? `${products.length} seguros Colsubsidio` : products[0].name;

  return deps.payments
    .createPaymentLink({
      policyId: args.policyId,
      productName,
      amountCOP,
      // Without it Wompi's receipt is a dead end: paid, rejected or out of funds, the browser
      // has nowhere to go back to. The state machine has always sent one; this path did not.
      ...(args.redirectUrl && { redirectUrl: args.redirectUrl }),
    })
    .then((link) => ({ ok: true as const, checkoutUrl: link.checkoutUrl }))
    .catch((err) => ({ ok: false as const, motivo: `No se pudo crear el link de pago: ${err}` }));
}
