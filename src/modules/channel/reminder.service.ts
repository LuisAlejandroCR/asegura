// reminder.service.ts: nudges a silent conversation after 60s and auto-closes it if
// still unanswered — with a much longer window when a payment link is outstanding,
// so nobody gets closed out mid-payment.

import { Injectable, Logger } from '@nestjs/common';
import { ChannelRegistry } from './channel-registry.service';
import { ConversationService } from '../agent/conversation.service';
import { ConversationState } from '../agent/types';
import { LeadService, mereceSeguimiento } from '../leads/lead.service';

// The one in-memory timer in an otherwise message-driven app; it resets on every deploy.
// 60s, not 30s: a 29-second voice note alone ate the original window.
const REMINDER_DELAY_MS = 60_000;
const REMINDER_TEXT = '¿Sigues ahí? Aquí estoy cuando quieras continuar 😊';

// If the nudge also goes unanswered, close the chat so analytics stop counting it as live.
const CLOSE_DELAY_MS = 180_000;

// A real Wompi link stays payable for 30 minutes, so the generic 4-minute close abandoned
// conversations mid-payment. Past Wompi's own expiry with a buffer.
const PAYMENT_CLOSE_DELAY_MS = 7 * 60 * 1000;
// The close has to be visible to the user, not just an analytics label written to the DB.
const TIMEOUT_CLOSE_TEXT = 'Como no he sabido de ti en un rato, cierro esta conversación por ahora. Cuando quieras continuar, aquí estoy — 24/7, sin esperas 😊';

const TERMINAL_STATES = new Set<ConversationState>([
  ConversationState.COMPLETED,
  ConversationState.ABANDONED,
  ConversationState.REJECTED,
]);

@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);
  private readonly nudgeTimers = new Map<string, NodeJS.Timeout>();
  private readonly closeTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly channels: ChannelRegistry,
    private readonly conversations: ConversationService,
    private readonly leads: LeadService,
  ) {}

  // Keyed by conversation id, not user id. awayOnAnotherSurface — un checkout de Wompi abierto o
  // AseguraWeb — significa que la persona salió del chat a propósito: ni aviso ni cierre corto.
  schedule(conversationId: string, userId: string, channel: 'telegram' | 'whatsapp', awayOnAnotherSurface = false): void {
    this.cancel(conversationId);

    // Con un link de pago abierto el silencio no es abandono: la persona está en el checkout,
    // fuera del chat. Preguntarle "¿sigues ahí?" a los 60 segundos la interrumpe pagando, así
    // que ahí solo queda el cierre, ya vencido el link.
    if (awayOnAnotherSurface) {
      const closeTimer = setTimeout(() => {
        this.closeTimers.delete(conversationId);
        void this.closeIfStillStalled(conversationId, userId, channel);
      }, PAYMENT_CLOSE_DELAY_MS);
      this.closeTimers.set(conversationId, closeTimer);
      return;
    }

    const nudgeTimer = setTimeout(() => {
      this.nudgeTimers.delete(conversationId);
      void this.channels.get(channel).sendText(userId, REMINDER_TEXT);

      const closeTimer = setTimeout(() => {
        this.closeTimers.delete(conversationId);
        void this.closeIfStillStalled(conversationId, userId, channel);
      }, CLOSE_DELAY_MS);
      this.closeTimers.set(conversationId, closeTimer);
    }, REMINDER_DELAY_MS);
    this.nudgeTimers.set(conversationId, nudgeTimer);
  }

  cancel(conversationId: string): void {
    const nudge = this.nudgeTimers.get(conversationId);
    if (nudge) {
      clearTimeout(nudge);
      this.nudgeTimers.delete(conversationId);
    }
    const close = this.closeTimers.get(conversationId);
    if (close) {
      clearTimeout(close);
      this.closeTimers.delete(conversationId);
    }
  }

  // La persona pulsó "Terminar" en AseguraWeb: no es silencio, es una decisión, así que el chat
  // se entera en el momento en vez de esperar a que venza un temporizador.
  async closeNow(conversationId: string, texto: string): Promise<void> {
    this.cancel(conversationId);
    const conv = await this.conversations.findById(conversationId);
    if (!conv || TERMINAL_STATES.has(conv.state)) return;

    // Con el pago hecho o en curso, "Terminar" no es abandonar: es colgar después de comprar.
    // Marcarlo ABANDONED borraba una venta del embudo y, encima del recibo de Wompi, le llegaba
    // un "cerramos la sesión de AseguraWeb" al chat mientras esperaba su póliza. De aquí en
    // adelante manda el webhook de Wompi, que es quien sabe cómo terminó la transacción.
    if (!mereceSeguimiento(conv)) {
      this.logger.log(`closeNow: ${conversationId} tiene un pago en curso — ni cierre ni aviso`);
      return;
    }

    // Se fue antes de quedar asegurada: queda anotada para que alguien la llame. Va primero
    // porque después de saveState la conversación ya es ABANDONED y el contexto es historia.
    await this.leads.registrar(conv, 'web_session_ended');

    await this.channels.get(conv.channel as 'telegram' | 'whatsapp').sendText(conv.user_id, texto)
      .catch((err) => this.logger.warn(`closeNow sendText failed: ${err}`));
    await this.conversations.saveState(conversationId, ConversationState.ABANDONED, {
      ...conv.context,
      abandonReason: 'web_session_ended',
    }).catch((err) => this.logger.warn(`closeNow saveState failed: ${err}`));
  }

  private async closeIfStillStalled(conversationId: string, userId: string, channel: 'telegram' | 'whatsapp'): Promise<void> {
    const conv = await this.conversations.findById(conversationId);
    if (!conv || TERMINAL_STATES.has(conv.state)) return;

    const reason = conv.context?.productCategory ? 'no_response' : 'insufficient_info';
    // El cierre por inactividad merece la misma llamada de vuelta que pulsar "Terminar": en
    // los dos casos la persona se quedó sin seguro y nadie se entera si solo se guarda un estado.
    if (mereceSeguimiento(conv)) await this.leads.registrar(conv, reason);
    await this.channels.get(channel).sendText(userId, TIMEOUT_CLOSE_TEXT)
      .catch((err) => this.logger.warn(`closeIfStillStalled sendText failed: ${err}`));
    await this.conversations.saveState(conversationId, ConversationState.ABANDONED, {
      ...conv.context,
      abandonReason: reason,
    }).catch((err) => this.logger.warn(`closeIfStillStalled saveState failed: ${err}`));
  }
}
