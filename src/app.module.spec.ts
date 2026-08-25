// app.module.spec.ts: proves the global rate limiter is actually wired and that the routes
// which must never be throttled (signed webhooks, Railway's healthcheck) are exempt.
import { APP_GUARD } from '@nestjs/core';
import { ExecutionContext, Type } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { HealthController } from './health/health.controller';
import { WebSessionController } from './modules/agent/web-session.controller';
import { TelegramWebhookController } from './modules/channel/telegram-webhook.controller';
import { MetaWebhookController } from './modules/channel/meta-webhook.controller';
import { WompiWebhookController } from './modules/payments/wompi-webhook.controller';
import { VoiceController } from './modules/voice/voice.controller';

// ConfigModule.forRoot() runs env validation while app.module.ts is being imported, and a
// failure calls process.exit(1) — which killed the jest worker in CI, where there is no
// .env. Hence the assignments before the require, and require instead of a hoisted import.
for (const [key, value] of Object.entries({
  NODE_ENV: 'test',
  CORS_ORIGIN: 'http://localhost:3000',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
})) {
  process.env[key] ??= value;
}
const { AppModule } = require('./app.module') as typeof import('./app.module');

// Mirrors AppModule's ThrottlerModule.forRoot so the numbers under test are the shipped ones.
const GLOBAL_LIMIT = 100;

function contextFor(classRef: Type<unknown>, method: string, ip: string): ExecutionContext {
  const res = { header: jest.fn() };
  const req = { ip, headers: {} };
  return {
    getClass: () => classRef,
    getHandler: () => (classRef.prototype as any)[method],
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

describe('global rate limiting', () => {
  let guard: ThrottlerGuard;
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: GLOBAL_LIMIT }])],
      providers: [ThrottlerGuard],
    }).compile();
    // compile() alone leaves this.throttlers undefined — the guard builds it in onModuleInit.
    await moduleRef.init();
    guard = moduleRef.get(ThrottlerGuard);
  });

  // The storage service keeps a live timer per key; leaving it open hangs the runner.
  afterEach(async () => {
    await moduleRef.close();
  });

  async function allowedCalls(classRef: Type<unknown>, method: string, ip: string, n: number) {
    let allowed = 0;
    for (let i = 0; i < n; i++) {
      try {
        await guard.canActivate(contextFor(classRef, method, ip));
        allowed++;
      } catch {
        break;
      }
    }
    return allowed;
  }

  it('binds ThrottlerGuard as APP_GUARD — registering the module alone counted nothing', () => {
    const providers: any[] = Reflect.getMetadata('providers', AppModule) ?? [];
    expect(providers).toContainEqual({ provide: APP_GUARD, useClass: ThrottlerGuard });
  });

  it('caps /voice/session at 5 per minute — every call bills LiveKit, Groq and ElevenLabs', async () => {
    expect(await allowedCalls(VoiceController, 'createSession', '1.1.1.1', 20)).toBe(5);
  });

  it('keeps a separate bucket per IP, so one abuser cannot lock everyone out', async () => {
    await allowedCalls(VoiceController, 'createSession', '1.1.1.1', 20);
    expect(await allowedCalls(VoiceController, 'createSession', '2.2.2.2', 6)).toBe(5);
  });

  it('applies the 100/min default to the AseguraWeb session endpoints', async () => {
    expect(await allowedCalls(WebSessionController, 'postMessage', '3.3.3.3', GLOBAL_LIMIT + 5))
      .toBe(GLOBAL_LIMIT);
  });

  // A 429 on these is worse than the flood: a dropped payment event is an unissued policy,
  // and a throttled healthcheck restarts the deploy.
  it.each([
    ['wompi webhook', WompiWebhookController, 'handleWebhook'],
    ['telegram webhook', TelegramWebhookController, 'handle'],
    ['meta whatsapp webhook', MetaWebhookController, 'handle'],
    ['health', HealthController, 'check'],
  ])('never throttles %s', async (_name, classRef, method) => {
    const attempts = GLOBAL_LIMIT * 3;
    expect(await allowedCalls(classRef as Type<unknown>, method as string, '4.4.4.4', attempts))
      .toBe(attempts);
  });
});
