// persistencia.ts: writes what the call captured back into the conversation row. The worker
// only ever read that row, so a sale closed by voice left no trace: the web bar stayed on
// step 1 and the payment link died inside the process.
import { ConversationContext, ConversationState } from '../modules/agent/types';

// Solo cuenta la venta en curso. `hasCompletedPurchase`, la cédula y el correo sobreviven a la
// compra anterior a propósito, así que leerlos como progreso ponía a quien vuelve en el último
// paso desde el saludo, con la llamada apenas empezando.
export function estadoDeVoz(context: ConversationContext): ConversationState {
  if (context.policyId || context.policyIds?.length || context.checkoutUrl) return ConversationState.PAYMENT;

  const hayCotizacion = !!context.quoteProductId || !!context.selectedProductIds?.length;
  if (hayCotizacion) {
    const tieneDatos = !!context.cedula || !!context.nombre || !!context.email;
    return tieneDatos ? ConversationState.DATA_CAPTURE : ConversationState.QUOTE_PRESENTED;
  }

  if (context.autorizado) return ConversationState.DISCOVERY;
  return ConversationState.GREETING;
}

export type EscrituraConversacion = (
  id: string,
  estado: ConversationState,
  context: ConversationContext,
) => Promise<void>;

export type GuardadorDeVoz = (
  conversationId: string | undefined,
  context: ConversationContext,
) => Promise<void>;

export function crearGuardador(escribir: EscrituraConversacion): GuardadorDeVoz {
  let enVuelo: Promise<void> = Promise.resolve();
  let pendiente: { id: string; context: ConversationContext } | undefined;

  const vaciar = async (): Promise<void> => {
    while (pendiente) {
      const { id, context } = pendiente;
      pendiente = undefined;
      try {
        await escribir(id, estadoDeVoz(context), context);
      } catch (error) {
        console.error('[asegura-voice] no se pudo guardar el contexto de la llamada: ' +
          (error instanceof Error ? error.message : String(error)));
      }
    }
  };

  return (conversationId, context) => {
    if (!conversationId) return Promise.resolve();
    pendiente = { id: conversationId, context };
    enVuelo = enVuelo.then(vaciar);
    return enVuelo;
  };
}
