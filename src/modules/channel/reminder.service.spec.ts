import { ReminderService } from './reminder.service';
import { ConversationState } from '../agent/types';

function makeTelegram() {
  return { sendText: jest.fn().mockResolvedValue(undefined) } as any;
}

function makeConversations(overrides?: { state?: ConversationState; context?: Record<string, unknown> }) {
  return {
    findById: jest.fn().mockResolvedValue({
      id: 'conv-1',
      state: overrides?.state ?? ConversationState.DISCOVERY,
      context: overrides?.context ?? {},
    }),
    saveState: jest.fn().mockResolvedValue(undefined),
  } as any;
}

describe('ReminderService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('sends the reminder text to the right user after 60s of no activity', () => {
    const telegram = makeTelegram();
    const service = new ReminderService(telegram, makeConversations());

    service.schedule('conv-1', 'user-1');
    jest.advanceTimersByTime(60_000);

    expect(telegram.sendText).toHaveBeenCalledTimes(1);
    expect(telegram.sendText).toHaveBeenCalledWith('user-1', expect.any(String));
  });

  it('does not fire before 60s have elapsed', () => {
    const telegram = makeTelegram();
    const service = new ReminderService(telegram, makeConversations());

    service.schedule('conv-1', 'user-1');
    jest.advanceTimersByTime(59_999);

    expect(telegram.sendText).not.toHaveBeenCalled();
  });

  // Core behavior: a new message from the same conversation proves the user is still
  // there — the pending reminder must not fire once they've responded.
  it('cancel() prevents a scheduled reminder from firing', () => {
    const telegram = makeTelegram();
    const service = new ReminderService(telegram, makeConversations());

    service.schedule('conv-1', 'user-1');
    service.cancel('conv-1');
    jest.advanceTimersByTime(60_000);

    expect(telegram.sendText).not.toHaveBeenCalled();
  });

  it('scheduling again for the same conversation replaces the previous timer instead of stacking two', () => {
    const telegram = makeTelegram();
    const service = new ReminderService(telegram, makeConversations());

    service.schedule('conv-1', 'user-1');
    jest.advanceTimersByTime(30_000);
    service.schedule('conv-1', 'user-1'); // re-armed — the clock should restart
    jest.advanceTimersByTime(30_000); // 60s since the FIRST schedule, only 30s since the second

    expect(telegram.sendText).not.toHaveBeenCalled();

    jest.advanceTimersByTime(30_000); // now 60s since the second schedule
    expect(telegram.sendText).toHaveBeenCalledTimes(1);
  });

  it('keeps independent timers for different conversations', () => {
    const telegram = makeTelegram();
    const service = new ReminderService(telegram, makeConversations());

    service.schedule('conv-1', 'user-1');
    service.schedule('conv-2', 'user-2');
    service.cancel('conv-1');
    jest.advanceTimersByTime(60_000);

    expect(telegram.sendText).toHaveBeenCalledTimes(1);
    expect(telegram.sendText).toHaveBeenCalledWith('user-2', expect.any(String));
  });

  it('cancel() on a conversation with no scheduled timer is a no-op, not a throw', () => {
    const telegram = makeTelegram();
    const service = new ReminderService(telegram, makeConversations());
    expect(() => service.cancel('never-scheduled')).not.toThrow();
  });

  // 2026-07-25 feature request: a conversation that goes quiet through the nudge AND the
  // extra 3-minute grace period afterward gets auto-closed, so it doesn't sit open forever.
  describe('auto-close after the nudge also goes unanswered', () => {
    // Real live-test bug (screenshot, 2026-07-26): the auto-close updated the DB but
    // never told the user anything — from the chat's own point of view, nothing
    // happened at all no matter how long they waited after the nudge. The whole point
    // of "chat ended due to lack of information" was a visible outcome.
    it('sends a closing message to the user, not just a silent DB update', async () => {
      const telegram = makeTelegram();
      const conversations = makeConversations({ state: ConversationState.DISCOVERY, context: {} });
      const service = new ReminderService(telegram, conversations);

      service.schedule('conv-1', 'user-1');
      await jest.advanceTimersByTimeAsync(60_000 + 180_000);

      // Called twice total: once for the 60s nudge, once for the close message.
      expect(telegram.sendText).toHaveBeenCalledTimes(2);
      expect(telegram.sendText).toHaveBeenNthCalledWith(2, 'user-1', expect.any(String));
      const closeText = telegram.sendText.mock.calls[1][1] as string;
      expect(closeText).not.toBe(telegram.sendText.mock.calls[0][1]); // distinct from the nudge text
    });

    it('closes as "insufficient_info" when no productCategory was ever captured', async () => {
      const telegram = makeTelegram();
      const conversations = makeConversations({ state: ConversationState.DISCOVERY, context: {} });
      const service = new ReminderService(telegram, conversations);

      service.schedule('conv-1', 'user-1');
      await jest.advanceTimersByTimeAsync(60_000 + 180_000);

      expect(conversations.saveState).toHaveBeenCalledWith(
        'conv-1',
        ConversationState.ABANDONED,
        expect.objectContaining({ abandonReason: 'insufficient_info' }),
      );
    });

    it('closes as "no_response" when a productCategory was already captured', async () => {
      const telegram = makeTelegram();
      const conversations = makeConversations({
        state: ConversationState.QUOTE_PRESENTED,
        context: { productCategory: 'mascotas' },
      });
      const service = new ReminderService(telegram, conversations);

      service.schedule('conv-1', 'user-1');
      await jest.advanceTimersByTimeAsync(60_000 + 180_000);

      expect(conversations.saveState).toHaveBeenCalledWith(
        'conv-1',
        ConversationState.ABANDONED,
        expect.objectContaining({ abandonReason: 'no_response', productCategory: 'mascotas' }),
      );
    });

    it('does not close a conversation that already reached a terminal state some other way, and does not message it either', async () => {
      const telegram = makeTelegram();
      const conversations = makeConversations({ state: ConversationState.COMPLETED });
      const service = new ReminderService(telegram, conversations);

      service.schedule('conv-1', 'user-1');
      await jest.advanceTimersByTimeAsync(60_000 + 180_000);

      expect(conversations.saveState).not.toHaveBeenCalled();
      // Only the 60s nudge should have gone out — no separate close message.
      expect(telegram.sendText).toHaveBeenCalledTimes(1);
    });

    it('a reply during the grace period (cancel) prevents the auto-close', async () => {
      const telegram = makeTelegram();
      const conversations = makeConversations();
      const service = new ReminderService(telegram, conversations);

      service.schedule('conv-1', 'user-1');
      await jest.advanceTimersByTimeAsync(60_000); // nudge fires, grace period starts
      service.cancel('conv-1'); // user replied
      await jest.advanceTimersByTimeAsync(180_000);

      expect(conversations.saveState).not.toHaveBeenCalled();
    });
  });
});
