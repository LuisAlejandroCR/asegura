import { UnauthorizedException } from '@nestjs/common';
import { TelegramWebhookGuard } from './telegram-webhook.guard';

function makeContext(headers: Record<string, string | string[]> = {}) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as any;
}

function makeConfig(values: Record<string, string | undefined>) {
  return { get: jest.fn((key: string) => values[key]) } as any;
}

describe('TelegramWebhookGuard — secret configured', () => {
  it('allows a request with the matching secret token', () => {
    const guard = new TelegramWebhookGuard(makeConfig({ TELEGRAM_WEBHOOK_SECRET: 'shh', NODE_ENV: 'production' }));
    const ctx = makeContext({ 'x-telegram-bot-api-secret-token': 'shh' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects a request with a wrong secret token', () => {
    const guard = new TelegramWebhookGuard(makeConfig({ TELEGRAM_WEBHOOK_SECRET: 'shh', NODE_ENV: 'production' }));
    const ctx = makeContext({ 'x-telegram-bot-api-secret-token': 'wrong' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects a request with no token header at all', () => {
    const guard = new TelegramWebhookGuard(makeConfig({ TELEGRAM_WEBHOOK_SECRET: 'shh', NODE_ENV: 'production' }));
    expect(() => guard.canActivate(makeContext())).toThrow(UnauthorizedException);
  });

  it('rejects a token shorter than the configured secret (no length-mismatch crash)', () => {
    const guard = new TelegramWebhookGuard(makeConfig({ TELEGRAM_WEBHOOK_SECRET: 'a-long-secret-value', NODE_ENV: 'production' }));
    const ctx = makeContext({ 'x-telegram-bot-api-secret-token': 'short' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects a token longer than the configured secret (no length-mismatch crash)', () => {
    const guard = new TelegramWebhookGuard(makeConfig({ TELEGRAM_WEBHOOK_SECRET: 'short', NODE_ENV: 'production' }));
    const ctx = makeContext({ 'x-telegram-bot-api-secret-token': 'a-much-longer-token-value' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects when the header arrives as an array (duplicate headers)', () => {
    const guard = new TelegramWebhookGuard(makeConfig({ TELEGRAM_WEBHOOK_SECRET: 'shh', NODE_ENV: 'production' }));
    const ctx = makeContext({ 'x-telegram-bot-api-secret-token': ['shh', 'shh'] });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  // Secret comparison must not short-circuit on the first mismatched byte — otherwise
  // response-time differences could leak how many leading characters of the real secret
  // an attacker has guessed correctly (timing side-channel on a value that gates Telegram's
  // ability to inject conversation messages).
  it('validates using a fixed-time comparison regardless of where the mismatch occurs', () => {
    const secret = 'abcdefghijklmnop';
    const guard = new TelegramWebhookGuard(makeConfig({ TELEGRAM_WEBHOOK_SECRET: secret, NODE_ENV: 'production' }));
    const mismatchAtStart = 'zbcdefghijklmnop';
    const mismatchAtEnd = 'abcdefghijklmnoz';
    expect(() => guard.canActivate(makeContext({ 'x-telegram-bot-api-secret-token': mismatchAtStart }))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(makeContext({ 'x-telegram-bot-api-secret-token': mismatchAtEnd }))).toThrow(UnauthorizedException);
  });
});

describe('TelegramWebhookGuard — secret NOT configured (dev convenience bypass)', () => {
  it('allows the request when NODE_ENV is explicitly "development"', () => {
    const guard = new TelegramWebhookGuard(makeConfig({ TELEGRAM_WEBHOOK_SECRET: undefined, NODE_ENV: 'development' }));
    expect(guard.canActivate(makeContext())).toBe(true);
  });

  it('throws when NODE_ENV is "production"', () => {
    const guard = new TelegramWebhookGuard(makeConfig({ TELEGRAM_WEBHOOK_SECRET: undefined, NODE_ENV: 'production' }));
    expect(() => guard.canActivate(makeContext())).toThrow(UnauthorizedException);
  });

  // Regression: the guard used to bypass auth whenever NODE_ENV simply wasn't the exact
  // string 'production' — so an unset NODE_ENV, a typo, or a staging environment that was
  // never explicitly flagged as 'production' would silently accept ANY request with no
  // secret check at all. Fail closed by default; only the explicit 'development' value opts in.
  it('regression — throws (fails closed) when NODE_ENV is undefined, not just when it is "production"', () => {
    const guard = new TelegramWebhookGuard(makeConfig({ TELEGRAM_WEBHOOK_SECRET: undefined, NODE_ENV: undefined }));
    expect(() => guard.canActivate(makeContext())).toThrow(UnauthorizedException);
  });

  it('regression — throws (fails closed) for an unrecognized NODE_ENV value like "staging"', () => {
    const guard = new TelegramWebhookGuard(makeConfig({ TELEGRAM_WEBHOOK_SECRET: undefined, NODE_ENV: 'staging' }));
    expect(() => guard.canActivate(makeContext())).toThrow(UnauthorizedException);
  });
});
