// meta-webhook.guard.spec.ts: tests MetaWebhookGuard against real HMAC-SHA256 signatures
// computed the way Meta's webhook docs describe, the raw-body requirement, and the
// dev-only bypass / fail-closed behavior (same contract as TelegramWebhookGuard).

import { createHmac } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { MetaWebhookGuard } from './meta-webhook.guard';

function makeContext(headers: Record<string, string> = {}, rawBody?: Buffer) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers, rawBody }),
    }),
  } as any;
}

function makeConfig(values: Record<string, string | undefined>) {
  return { get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback) } as any;
}

function sign(secret: string, raw: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

const APP_SECRET = 'test-app-secret';
const RAW = Buffer.from(
  JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '573001234567', text: { body: 'hola' } }] } }] }] }),
);

describe('MetaWebhookGuard — app secret configured', () => {
  const guard = new MetaWebhookGuard(makeConfig({ WHATSAPP_APP_SECRET: APP_SECRET, NODE_ENV: 'production' }));

  it('allows a request with a valid signature', () => {
    expect(guard.canActivate(makeContext({ 'x-hub-signature-256': sign(APP_SECRET, RAW) }, RAW))).toBe(true);
  });

  it('rejects a wrong signature', () => {
    expect(() => guard.canActivate(makeContext({ 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }, RAW)))
      .toThrow(UnauthorizedException);
  });

  it('rejects a missing signature header', () => {
    expect(() => guard.canActivate(makeContext({}, RAW))).toThrow(UnauthorizedException);
  });

  it('rejects a signature without the sha256= prefix', () => {
    const bare = sign(APP_SECRET, RAW).slice('sha256='.length);
    expect(() => guard.canActivate(makeContext({ 'x-hub-signature-256': bare }, RAW))).toThrow(UnauthorizedException);
  });

  it('rejects a body tampered with after signing', () => {
    const signature = sign(APP_SECRET, RAW);
    const tampered = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ text: { body: 'otro' } }] } }] }] }));
    expect(() => guard.canActivate(makeContext({ 'x-hub-signature-256': signature }, tampered)))
      .toThrow(UnauthorizedException);
  });

  // The reason main.ts creates the app with rawBody: true. Meta escapes non-ASCII as \uXXXX
  // before signing, so re-serializing the parsed body would break on any message with a
  // tilde — refusing is the only honest answer when the bytes are gone.
  it('rejects when rawBody is unavailable, instead of falling back to the parsed body', () => {
    expect(() => guard.canActivate(makeContext({ 'x-hub-signature-256': sign(APP_SECRET, RAW) }, undefined)))
      .toThrow(UnauthorizedException);
  });

  it('verifies a body containing non-ASCII exactly as sent', () => {
    const accented = Buffer.from(JSON.stringify({ text: { body: '¿Qué seguro necesito para mi mamá?' } }));
    expect(guard.canActivate(makeContext({ 'x-hub-signature-256': sign(APP_SECRET, accented) }, accented))).toBe(true);
  });
});

describe('MetaWebhookGuard — app secret NOT configured (dev convenience bypass)', () => {
  it('allows the request when NODE_ENV is explicitly "development"', () => {
    const guard = new MetaWebhookGuard(makeConfig({ WHATSAPP_APP_SECRET: undefined, NODE_ENV: 'development' }));
    expect(guard.canActivate(makeContext())).toBe(true);
  });

  it('throws when NODE_ENV is "production"', () => {
    const guard = new MetaWebhookGuard(makeConfig({ WHATSAPP_APP_SECRET: undefined, NODE_ENV: 'production' }));
    expect(() => guard.canActivate(makeContext())).toThrow(UnauthorizedException);
  });

  it('fails closed when NODE_ENV is undefined, not just when it is "production"', () => {
    const guard = new MetaWebhookGuard(makeConfig({ WHATSAPP_APP_SECRET: undefined, NODE_ENV: undefined }));
    expect(() => guard.canActivate(makeContext())).toThrow(UnauthorizedException);
  });
});
