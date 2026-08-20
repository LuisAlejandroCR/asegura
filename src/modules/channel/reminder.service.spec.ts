// reminder.service.spec.ts: tests the nudge and auto-close timers — independent timers per
// conversation, cancel() as a no-op, the extended window while a Wompi payment link is still
// valid, and that both messages leave through the channel the conversation came in on.

import { ReminderService } from './reminder.service';
import { ConversationState } from '../agent/types';

function makeChannels() {
  const telegram = { sendText: jest.fn().mockResolvedValue(undefined) };
  const whatsapp = { sendText: jest.fn().mockResolvedValue(undefined) };
  const registry = {
    get: jest.fn((channel: string) => (channel === 'whatsapp' ? whatsapp : telegram)),
  } as any;
  return { registry, telegram, whatsapp };
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
    const { registry, telegram } = makeChannels();
    const service = new ReminderService(registry, makeConversations());

    service.schedule('conv-1', 'user-1', 'telegram');
    jest.advanceTimersByTime(60_000);

    expect(telegram.sendText).toHaveBeenCalledTimes(1);
    expect(telegram.sendText).toHaveBeenCalledWith('user-1', expect.any(String));
  });

  it('does not fire before 60s have elapsed', () => {
    const { registry, telegram } = makeChannels();
    const service = new ReminderService(registry, makeConversations());

    service.schedule('conv-1', 'user-1', 'telegram');
    jest.advanceTimersByTime(59_999);

    expect(telegram.sendText).not.toHaveBeenCalled();
  });

  // Core behavior: a new message from the same conversation proves the user is still
  // there — the pending reminder must not fire once they've responded.
  it('cancel() prevents a scheduled reminder from firing', () => {
    const { registry, telegram } = makeChannels();
    const service = new ReminderService(registry, makeConversations());

    service.schedule('conv-1', 'user-1', 'telegram');
    service.cancel('conv-1');
    jest.advanceTimersByTime(60_000);

    expect(telegram.sendText).not.toHaveBeenCalled();
  });

  it('scheduling again for the same conversation replaces the previous timer instead of stacking two', () => {
    const { registry, telegram } = makeChannels();
    const service = new ReminderService(registry, makeConversations());

    service.schedule('conv-1', 'user-1', 'telegram');
    jest.advanceTimersByTime(30_000);
    service.schedule('conv-1', 'user-1', 'telegram'); // re-armed — the clock should restart
    jest.advanceTimersByTime(30_000); // 60s since the FIRST schedule, only 30s since the second

    expect(telegram.sendText).not.toHaveBeenCalled();

    jest.advanceTimersByTime(30_000); // now 60s since the second schedule
    expect(telegram.sendText).toHaveBeenCalledTimes(1);
  });

  it('keeps independent timers for different conversations', () => {
    const { registry, telegram } = makeChannels();
    const service = new ReminderService(registry, makeConversations());

    service.schedule('conv-1', 'user-1', 'telegram');
    service.schedule('conv-2', 'user-2', 'telegram');
    service.cancel('conv-1');
    jest.advanceTimersByTime(60_000);

    expect(telegram.sendText).toHaveBeenCalledTimes(1);
    expect(telegram.sendText).toHaveBeenCalledWith('user-2', expect.any(String));
  });

  it('cancel() on a conversation with no scheduled timer is a no-op, not a throw', () => {
    const { registry } = makeChannels();
    const service = new ReminderService(registry, makeConversations());
    expect(() => service.cancel('never-scheduled')).not.toThrow();
  });

  // A conversation that goes quiet through the nudge AND the
  // extra 3-minute grace period afterward gets auto-closed, so it doesn't sit open forever.
  describe('auto-close after the nudge also goes unanswered', () => {
    // The auto-close updated the DB but
    // never told the user anything — from the chat's own point of view, nothing
    // happened at all no matter how long they waited after the nudge. The whole point
    // of "chat ended due to lack of information" was a visible outcome.
    it('sends a closing message to the user, not just a silent DB update', async () => {
      const { registry, telegram } = makeChannels();
      const conversations = makeConversations({ state: ConversationState.DISCOVERY, context: {} });
      const service = new ReminderService(registry, conversations);

      service.schedule('conv-1', 'user-1', 'telegram');
      await jest.advanceTimersByTimeAsync(60_000 + 180_000);

      // Called twice total: once for the 60s nudge, once for the close message.
      expect(telegram.sendText).toHaveBeenCalledTimes(2);
      expect(telegram.sendText).toHaveBeenNthCalledWith(2, 'user-1', expect.any(String));
      const closeText = telegram.sendText.mock.calls[1][1] as string;
      expect(closeText).not.toBe(telegram.sendText.mock.calls[0][1]); // distinct from the nudge text
    });

    it('closes as "insufficient_info" when no productCategory was ever captured', async () => {
      const { registry } = makeChannels();
      const conversations = makeConversations({ state: ConversationState.DISCOVERY, context: {} });
      const service = new ReminderService(registry, conversations);

      service.schedule('conv-1', 'user-1', 'telegram');
      await jest.advanceTimersByTimeAsync(60_000 + 180_000);

      expect(conversations.saveState).toHaveBeenCalledWith(
        'conv-1',
        ConversationState.ABANDONED,
        expect.objectContaining({ abandonReason: 'insufficient_info' }),
      );
    });

    it('closes as "no_response" when a productCategory was already captured', async () => {
      const { registry } = makeChannels();
      const conversations = makeConversations({
        state: ConversationState.QUOTE_PRESENTED,
        context: { productCategory: 'mascotas' },
      });
      const service = new ReminderService(registry, conversations);

      service.schedule('conv-1', 'user-1', 'telegram');
      await jest.advanceTimersByTimeAsync(60_000 + 180_000);

      expect(conversations.saveState).toHaveBeenCalledWith(
        'conv-1',
        ConversationState.ABANDONED,
        expect.objectContaining({ abandonReason: 'no_response', productCategory: 'mascotas' }),
      );
    });

    it('does not close a conversation that already reached a terminal state some other way, and does not message it either', async () => {
      const { registry, telegram } = makeChannels();
      const conversations = makeConversations({ state: ConversationState.COMPLETED });
      const service = new ReminderService(registry, conversations);

      service.schedule('conv-1', 'user-1', 'telegram');
      await jest.advanceTimersByTimeAsync(60_000 + 180_000);

      expect(conversations.saveState).not.toHaveBeenCalled();
      // Only the 60s nudge should have gone out — no separate close message.
      expect(telegram.sendText).toHaveBeenCalledTimes(1);
    });

    it('a reply during the grace period (cancel) prevents the auto-close', async () => {
      const { registry } = makeChannels();
      const conversations = makeConversations();
      const service = new ReminderService(registry, conversations);

      service.schedule('conv-1', 'user-1', 'telegram');
      await jest.advanceTimersByTimeAsync(60_000); // nudge fires, grace period starts
      service.cancel('conv-1'); // user replied
      await jest.advanceTimersByTimeAsync(180_000);

      expect(conversations.saveState).not.toHaveBeenCalled();
    });
  });

  // A real Wompi payment link is valid for
  // 30 minutes ("El link vence en 30 minutos"), but the conversation auto-abandoned on
  // the regular 4-minute (60s nudge + 180s grace) window regardless — closing the chat
  // while the link was still perfectly payable.
  describe('hasPendingPayment — extended auto-close while a Wompi link is still valid', () => {
    it('does NOT auto-close at the regular 4-minute mark when hasPendingPayment is true', async () => {
      const { registry, telegram } = makeChannels();
      const conversations = makeConversations({ state: ConversationState.PAYMENT, context: { checkoutUrl: 'https://checkout.wompi.co/l/test' } });
      const service = new ReminderService(registry, conversations);

      service.schedule('conv-1', 'user-1', 'telegram', true);
      await jest.advanceTimersByTimeAsync(60_000 + 180_000); // the old, regular close point

      expect(conversations.saveState).not.toHaveBeenCalled();
      // Ni el aviso: con el checkout abierto la persona está pagando, no ausente.
      expect(telegram.sendText).not.toHaveBeenCalled();
    });

    it('auto-closes once the link expired, and that is the only message it sends', async () => {
      const { registry, telegram } = makeChannels();
      const conversations = makeConversations({ state: ConversationState.PAYMENT, context: { checkoutUrl: 'https://checkout.wompi.co/l/test' } });
      const service = new ReminderService(registry, conversations);

      service.schedule('conv-1', 'user-1', 'telegram', true);
      await jest.advanceTimersByTimeAsync(33 * 60_000);

      expect(conversations.saveState).toHaveBeenCalledWith(
        'conv-1',
        ConversationState.ABANDONED,
        expect.anything(),
      );
      expect(telegram.sendText).toHaveBeenCalledTimes(1);
    });

    it('hasPendingPayment defaults to false — unchanged 4-minute behavior when omitted', async () => {
      const { registry } = makeChannels();
      const conversations = makeConversations({ state: ConversationState.DISCOVERY, context: {} });
      const service = new ReminderService(registry, conversations);

      service.schedule('conv-1', 'user-1', 'telegram');
      await jest.advanceTimersByTimeAsync(60_000 + 180_000);

      expect(conversations.saveState).toHaveBeenCalledWith('conv-1', ConversationState.ABANDONED, expect.anything());
    });
  });

  // The service used to hold a TelegramAdapter directly, so a WhatsApp conversation got
  // neither the nudge nor the closing message — both were pushed at a Telegram chat id that
  // does not exist. ChannelRegistry is what the rest of the app already routes through.
  describe('routes through the channel the conversation belongs to', () => {
    it('nudges a WhatsApp conversation on WhatsApp, not Telegram', () => {
      const { registry, telegram, whatsapp } = makeChannels();
      const service = new ReminderService(registry, makeConversations());

      service.schedule('conv-1', 'whatsapp:+573001112233', 'whatsapp');
      jest.advanceTimersByTime(60_000);

      expect(whatsapp.sendText).toHaveBeenCalledWith('whatsapp:+573001112233', expect.any(String));
      expect(telegram.sendText).not.toHaveBeenCalled();
    });

    it('closes a WhatsApp conversation on WhatsApp too', async () => {
      const { registry, telegram, whatsapp } = makeChannels();
      const service = new ReminderService(registry, makeConversations());

      service.schedule('conv-1', 'whatsapp:+573001112233', 'whatsapp');
      await jest.advanceTimersByTimeAsync(60_000 + 180_000);

      expect(whatsapp.sendText).toHaveBeenCalledTimes(2);
      expect(telegram.sendText).not.toHaveBeenCalled();
    });

    it('still uses Telegram for a Telegram conversation', () => {
      const { registry, telegram, whatsapp } = makeChannels();
      const service = new ReminderService(registry, makeConversations());

      service.schedule('conv-1', 'user-1', 'telegram');
      jest.advanceTimersByTime(60_000);

      expect(telegram.sendText).toHaveBeenCalledTimes(1);
      expect(whatsapp.sendText).not.toHaveBeenCalled();
    });
  });
});
