// reminder.service.ts: nudges a silent conversation after 60s and auto-closes it if
// still unanswered — with a much longer window when a payment link is outstanding,
// so nobody gets closed out mid-payment.

import { Injectable, Logger } from '@nestjs/common';
import { TelegramAdapter } from './telegram-adapter.service';
import { ConversationService } from '../agent/conversation.service';
import { ConversationState } from '../agent/types';

// The one in-memory timer in an otherwise message-driven app; it resets on every deploy.
// 60s, not 30s: a 29-second voice note alone ate the original window.
const REMINDER_DELAY_MS = 60_000;
const REMINDER_TEXT = '¿Sigues ahí? Aquí estoy cuando quieras continuar 😊';

// If the nudge also goes unanswered, close the chat so analytics stop counting it as live.
const CLOSE_DELAY_MS = 180_000;

// A real Wompi link stays payable for 30 minutes, so the generic 4-minute close abandoned
// conversations mid-payment. 60s nudge + 33 min = past Wompi's own expiry with a buffer.
const PAYMENT_CLOSE_DELAY_MS = 33 * 60 * 1000;
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
    private readonly telegram: TelegramAdapter,
    private readonly conversations: ConversationService,
  ) {}

  // Keyed by conversation id, not user id. hasPendingPayment switches to the long window so a
  // still-payable Wompi link is never abandoned mid-payment.
  schedule(conversationId: string, userId: string, hasPendingPayment = false): void {
    this.cancel(conversationId);
    const nudgeTimer = setTimeout(() => {
      this.nudgeTimers.delete(conversationId);
      void this.telegram.sendText(userId, REMINDER_TEXT);

      const closeDelay = hasPendingPayment ? PAYMENT_CLOSE_DELAY_MS : CLOSE_DELAY_MS;
      const closeTimer = setTimeout(() => {
        this.closeTimers.delete(conversationId);
        void this.closeIfStillStalled(conversationId, userId);
      }, closeDelay);
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

  private async closeIfStillStalled(conversationId: string, userId: string): Promise<void> {
    const conv = await this.conversations.findById(conversationId);
    if (!conv || TERMINAL_STATES.has(conv.state)) return;

    const reason = conv.context?.productCategory ? 'no_response' : 'insufficient_info';
    await this.telegram.sendText(userId, TIMEOUT_CLOSE_TEXT)
      .catch((err) => this.logger.warn(`closeIfStillStalled sendText failed: ${err}`));
    await this.conversations.saveState(conversationId, ConversationState.ABANDONED, {
      ...conv.context,
      abandonReason: reason,
    }).catch((err) => this.logger.warn(`closeIfStillStalled saveState failed: ${err}`));
  }
}
