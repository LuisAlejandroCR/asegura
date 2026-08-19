// seleccionar-producto.tool.ts: pins the quote to a product the conversation actually saw.
// The state machine resolved "la primera opción" / "prefiero la anterior" with regexes over
// shownProductIds; the model reads the transcript instead, but it may only pick from what was
// offered — otherwise a back-reference silently becomes a different price.

import { ConversationContext } from '../types';
import { ToolDeps, ToolOutcome, requireAuthorization } from './types';

export interface ProductoSeleccionado {
  productId: string;
  producto: string;
  precioMensual: number;
}

export function seleccionarProductoLogic(
  deps: Pick<ToolDeps, 'quoting' | 'catalog'>,
  context: ConversationContext,
  args: { productId: string },
): ToolOutcome<ProductoSeleccionado> {
  const denied = requireAuthorization(context);
  if (denied) return denied;

  const shown = context.shownProductIds ?? [];
  const id = (args.productId ?? '').trim();

  if (!shown.includes(id)) {
    return {
      ok: false,
      motivo: shown.length
        ? `Solo puedes elegir una de las opciones ya ofrecidas: ${shown.join(', ')}.`
        : 'Todavía no se le ha ofrecido ninguna opción a la persona. Usa "cotizar" primero.',
    };
  }

  const product = deps.catalog?.getProduct(id);
  if (!product) {
    return { ok: false, motivo: `El producto ${id} no existe en el catálogo.` };
  }

  // Priced through the engine, never from the model: the same rule cotizar follows.
  const score = deps.quoting.score({ productCategory: null }).find((s) => s.productId === id);
  return {
    ok: true,
    productId: id,
    producto: product.name,
    precioMensual: score?.monthlyPremium ?? 0,
  };
}
