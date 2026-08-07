// reminder.service.ts: nudges a silent conversation after 60s and auto-closes it if
// still unanswered — with a much longer window when a payment link is outstanding,
// so nobody gets closed out mid-payment.

import { Injectable, Logger } from '@nestjs/common';
import { TelegramAdapter } from './telegram-adapter.service';
import { ConversationService } from '../agent/conversation.service';
import { ConversationState } from '../agent/types';

// 2026-07-25 — nudge a user who goes quiet after a prompt. The app is otherwise stateless
// (driven only by incoming messages), so this is the one in-memory timer. It resets on
// every deploy: accepted tradeoff, 60s is too short for cron-style DB polling.
//
// 2026-07-25 live test: the original 30s fired while the user was still recording a voice
// reply to DISCOVERY — a 29s voice note alone ate the window. Doubled to 60s.
const REMINDER_DELAY_MS = 60_000;
const REMINDER_TEXT = '¿Sigues ahí? Aquí estoy cuando quieras continuar 😊';

// 2026-07-25 feature request: if the nudge above ALSO goes unanswered, the conversation
// shouldn't just sit open forever in the DB — close it out so analytics/the dashboard
// don't keep counting a truly-dead chat as still "in progress". 3 more minutes after the
// nudge (4 total since the user's last message) before giving up.
const CLOSE_DELAY_MS = 180_000;

// Real live-test bug (2026-07-26): a user who received a real Wompi payment link (valid
// for 30 minutes — see the "El link vence en 30 minutos" text sent alongside it) had
// their conversation auto-closed to ABANDONED after the same generic 4-minute window as
// any other prompt — while the link was still perfectly payable. Closing the chat before
// the payment window itself even expires is misleading (the conversation says "closed"
// while a real charge could still land) and forces the user to restart from scratch if
// they come back to pay a few minutes later. 60s nudge + 33 more minutes = 34 minutes
// total from the last message — past Wompi's own 30-minute expiry plus a small buffer,
// same margin pattern as the regular 4-minute window (1 extra minute past the 3-minute
// nudge-to-close gap there).
const PAYMENT_CLOSE_DELAY_MS = 33 * 60 * 1000;
// Real live-test bug (2026-07-25/26, screenshot): the auto-close above updated the DB
// (ABANDONED + abandonReason) but never told the USER anything — from the chat's own
// point of view, nothing happened at all after the nudge, no matter how long you waited.
// The whole point of "chat ended due to lack of information" was a visible outcome, not
// a silent analytics label.
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

  // Keyed by conversation id, not userId — a user could in principle run multiple
  // conversations (different channels), and conversation id is already the stable,
  // unique identifier used everywhere else in this codebase (saveState, etc.).
  //
  // hasPendingPayment: true when a real Wompi checkoutUrl was just sent and is still
  // unconfirmed — uses PAYMENT_CLOSE_DELAY_MS instead of the default so the conversation
  // doesn't auto-abandon while the link itself is still payable. Defaults to false so
  // every other call site (including the post-purchase cross-sell reminder scheduled
  // from wompi-webhook.controller.ts once a payment IS confirmed) keeps today's behavior
  // unchanged.
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
