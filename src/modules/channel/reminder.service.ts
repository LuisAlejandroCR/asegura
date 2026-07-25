import { Injectable } from '@nestjs/common';
import { TelegramAdapter } from './telegram-adapter.service';

// 2026-07-25 feature request: nudge a user back to the chat if they go quiet after a
// prompt (a quote, the post-purchase cross-sell offer, etc.). This app is otherwise fully
// stateless — driven only by incoming Telegram messages — so this is the one place with
// an in-memory timer. Deliberately simple: it resets on every deploy/restart, which is an
// accepted tradeoff for the hackathon (recommended over a DB-polled job at this
// granularity — 30s is too short for cron-style polling to make sense).
const REMINDER_DELAY_MS = 30_000;
const REMINDER_TEXT = '¿Sigues ahí? Aquí estoy cuando quieras continuar 😊';

@Injectable()
export class ReminderService {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly telegram: TelegramAdapter) {}

  // Keyed by conversation id, not userId — a user could in principle run multiple
  // conversations (different channels), and conversation id is already the stable,
  // unique identifier used everywhere else in this codebase (saveState, etc.).
  schedule(conversationId: string, userId: string): void {
    this.cancel(conversationId);
    const timer = setTimeout(() => {
      this.timers.delete(conversationId);
      void this.telegram.sendText(userId, REMINDER_TEXT);
    }, REMINDER_DELAY_MS);
    this.timers.set(conversationId, timer);
  }

  cancel(conversationId: string): void {
    const existing = this.timers.get(conversationId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(conversationId);
    }
  }
}
