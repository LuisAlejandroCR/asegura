// twilio-webhook.guard.spec.ts: tests TwilioWebhookGuard against real HMAC-SHA1
// signatures computed the same way Twilio's own docs describe, plus the dev-only bypass
// and fail-closed behavior (same contract as TelegramWebhookGuard).

import { createHmac } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { TwilioWebhookGuard } from './twilio-webhook.guard';

function makeContext(headers: Record<string, string> = {}, body: Record<string, string> = {}) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers, body }),
    }),
  } as any;
}

function makeConfig(values: Record<string, string | undefined>) {
  return { get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback) } as any;
}

function computeSignature(authToken: string, url: string, params: Record<string, string>): string {
  const sorted = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], '');
  return createHmac('sha1', authToken).update(url + sorted).digest('base64');
}

const AUTH_TOKEN = 'test-auth-token';
const PUBLIC_URL = 'https://asegura.example.com';
const WEBHOOK_URL = `${PUBLIC_URL}/webhook/whatsapp`;
const BODY = { From: 'whatsapp:+15551234567', To: 'whatsapp:+14155238886', Body: 'hola' };

describe('TwilioWebhookGuard — auth token configured', () => {
  it('allows a request with a valid signature', () => {
    const guard = new TwilioWebhookGuard(makeConfig({ TWILIO_AUTH_TOKEN: AUTH_TOKEN, PUBLIC_URL, NODE_ENV: 'production' }));
    const signature = computeSignature(AUTH_TOKEN, WEBHOOK_URL, BODY);
    const ctx = makeContext({ 'x-twilio-signature': signature }, BODY);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects a request with a wrong signature', () => {
    const guard = new TwilioWebhookGuard(makeConfig({ TWILIO_AUTH_TOKEN: AUTH_TOKEN, PUBLIC_URL, NODE_ENV: 'production' }));
    const ctx = makeContext({ 'x-twilio-signature': 'not-the-real-signature==' }, BODY);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects a request with no signature header at all', () => {
    const guard = new TwilioWebhookGuard(makeConfig({ TWILIO_AUTH_TOKEN: AUTH_TOKEN, PUBLIC_URL, NODE_ENV: 'production' }));
    expect(() => guard.canActivate(makeContext({}, BODY))).toThrow(UnauthorizedException);
  });

  // Real signing bug this guards against: computing the signature over a hardcoded
  // subset of fields instead of every field actually received would accept a request
  // whose extra/tampered params were never checked.
  it('rejects when a body param was tampered with after signing', () => {
    const guard = new TwilioWebhookGuard(makeConfig({ TWILIO_AUTH_TOKEN: AUTH_TOKEN, PUBLIC_URL, NODE_ENV: 'production' }));
    const signature = computeSignature(AUTH_TOKEN, WEBHOOK_URL, BODY);
    const tamperedBody = { ...BODY, Body: 'mensaje distinto al firmado' };
    const ctx = makeContext({ 'x-twilio-signature': signature }, tamperedBody);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects when the signed URL does not match PUBLIC_URL + the webhook path', () => {
    const guard = new TwilioWebhookGuard(makeConfig({ TWILIO_AUTH_TOKEN: AUTH_TOKEN, PUBLIC_URL: 'https://wrong-host.example.com', NODE_ENV: 'production' }));
    const signature = computeSignature(AUTH_TOKEN, WEBHOOK_URL, BODY);
    const ctx = makeContext({ 'x-twilio-signature': signature }, BODY);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});

describe('TwilioWebhookGuard — auth token NOT configured (dev convenience bypass)', () => {
  it('allows the request when NODE_ENV is explicitly "development"', () => {
    const guard = new TwilioWebhookGuard(makeConfig({ TWILIO_AUTH_TOKEN: undefined, NODE_ENV: 'development' }));
    expect(guard.canActivate(makeContext())).toBe(true);
  });

  it('throws when NODE_ENV is "production"', () => {
    const guard = new TwilioWebhookGuard(makeConfig({ TWILIO_AUTH_TOKEN: undefined, NODE_ENV: 'production' }));
    expect(() => guard.canActivate(makeContext())).toThrow(UnauthorizedException);
  });

  it('fails closed when NODE_ENV is undefined, not just when it is "production"', () => {
    const guard = new TwilioWebhookGuard(makeConfig({ TWILIO_AUTH_TOKEN: undefined, NODE_ENV: undefined }));
    expect(() => guard.canActivate(makeContext())).toThrow(UnauthorizedException);
  });
});
