// lead.service.ts: deja constancia de quien se fue sin quedar asegurado, para que una persona
// del equipo lo llame de vuelta. Una conversación en ABANDONED es un estado que nadie consulta;
// una fila en `leads` es una lista de llamadas.
//
// Nunca interrumpe el flujo: si Supabase falla, se registra el fallo y la conversación sigue
// cerrándose igual. Perder un lead es malo; dejar a la persona esperando en pantalla, peor.
import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../database/supabase.service';
import { Conversation, ConversationState } from '../agent/types';

export type MotivoDeLead = 'web_session_ended' | 'no_response' | 'insufficient_info';

// Los estados en los que ya no hay nada que perseguir: la venta se cerró o está esperando el
// webhook de Wompi. Llamar a alguien que acaba de pagar es peor que no llamarlo.
const SIN_SEGUIMIENTO = new Set<ConversationState>([
  ConversationState.PAYMENT,
  ConversationState.POLICY_ISSUED,
  ConversationState.COMPLETED,
]);

export function mereceSeguimiento(conv: Pick<Conversation, 'state' | 'context'>): boolean {
  if (SIN_SEGUIMIENTO.has(conv.state)) return false;
  // Un link de pago abierto es una venta en vuelo aunque el estado todavía no lo diga.
  const ctx = conv.context ?? {};
  return !ctx.checkoutUrl && !ctx.policyId && !ctx.policyIds?.length;
}

@Injectable()
export class LeadService {
  private readonly logger = new Logger(LeadService.name);

  constructor(private readonly supabase: SupabaseService) {}

  // `onConflict` sobre conversation_id: pulsar "Terminar", volver y volver a pulsarlo es una
  // sola persona a quien llamar, con los datos de la última vez.
  async registrar(conv: Conversation, reason: MotivoDeLead): Promise<void> {
    const ctx = conv.context ?? {};
    const { error } = await this.supabase.db
      .from('leads')
      .upsert({
        conversation_id: conv.id,
        user_id: conv.user_id,
        channel: conv.channel,
        last_state: conv.state,
        reason,
        product_category: ctx.productCategory ?? null,
        quote_product_id: ctx.quoteProductId ?? null,
        nombre: ctx.nombre ?? ctx.contactName ?? null,
        cedula: ctx.cedula ?? null,
        document_type: ctx.documentType ?? null,
        email: ctx.email ?? ctx.contactEmail ?? null,
        phone: ctx.verifiedPhone ?? ctx.contactPhone ?? null,
        status: 'pending',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'conversation_id' });

    if (error) {
      this.logger.warn(`no se pudo registrar el lead de ${conv.id}: ${error.message}`);
      return;
    }
    this.logger.log(`lead registrado para seguimiento: ${conv.id} (${reason}, ${conv.state})`);
  }
}
