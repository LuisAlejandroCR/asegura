import { ReminderService } from './reminder.service';

function makeTelegram() {
  return { sendText: jest.fn().mockResolvedValue(undefined) } as any;
}

describe('ReminderService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('sends the reminder text to the right user after 30s of no activity', () => {
    const telegram = makeTelegram();
    const service = new ReminderService(telegram);

    service.schedule('conv-1', 'user-1');
    jest.advanceTimersByTime(30_000);

    expect(telegram.sendText).toHaveBeenCalledTimes(1);
    expect(telegram.sendText).toHaveBeenCalledWith('user-1', expect.any(String));
  });

  it('does not fire before 30s have elapsed', () => {
    const telegram = makeTelegram();
    const service = new ReminderService(telegram);

    service.schedule('conv-1', 'user-1');
    jest.advanceTimersByTime(29_999);

    expect(telegram.sendText).not.toHaveBeenCalled();
  });

  // Core behavior: a new message from the same conversation proves the user is still
  // there — the pending reminder must not fire once they've responded.
  it('cancel() prevents a scheduled reminder from firing', () => {
    const telegram = makeTelegram();
    const service = new ReminderService(telegram);

    service.schedule('conv-1', 'user-1');
    service.cancel('conv-1');
    jest.advanceTimersByTime(30_000);

    expect(telegram.sendText).not.toHaveBeenCalled();
  });

  it('scheduling again for the same conversation replaces the previous timer instead of stacking two', () => {
    const telegram = makeTelegram();
    const service = new ReminderService(telegram);

    service.schedule('conv-1', 'user-1');
    jest.advanceTimersByTime(15_000);
    service.schedule('conv-1', 'user-1'); // re-armed — the clock should restart
    jest.advanceTimersByTime(15_000); // 30s since the FIRST schedule, only 15s since the second

    expect(telegram.sendText).not.toHaveBeenCalled();

    jest.advanceTimersByTime(15_000); // now 30s since the second schedule
    expect(telegram.sendText).toHaveBeenCalledTimes(1);
  });

  it('keeps independent timers for different conversations', () => {
    const telegram = makeTelegram();
    const service = new ReminderService(telegram);

    service.schedule('conv-1', 'user-1');
    service.schedule('conv-2', 'user-2');
    service.cancel('conv-1');
    jest.advanceTimersByTime(30_000);

    expect(telegram.sendText).toHaveBeenCalledTimes(1);
    expect(telegram.sendText).toHaveBeenCalledWith('user-2', expect.any(String));
  });

  it('cancel() on a conversation with no scheduled timer is a no-op, not a throw', () => {
    const telegram = makeTelegram();
    const service = new ReminderService(telegram);
    expect(() => service.cancel('never-scheduled')).not.toThrow();
  });
});
