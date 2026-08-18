// web-session-token.service.spec.ts: same optional-integration contract as every other
// external/security-sensitive service in this codebase (LiveKitTokenService, WompiService)
// — disabled without a crash when JWT_SECRET is unset, tamper-proof via timingSafeEqual
// when it is.

import { WebSessionTokenService } from './web-session-token.service';

function makeConfig(values: Record<string, string | undefined>) {
  return { get: jest.fn((key: string) => values[key]) } as any;
}

describe('WebSessionTokenService — JWT_SECRET not set', () => {
  it('isEnabled is false, sign and verify both return null instead of throwing', () => {
    const service = new WebSessionTokenService(makeConfig({}));
    expect(service.isEnabled).toBe(false);
    expect(service.sign({ conversationId: 'conv-1' })).toBeNull();
    expect(service.verify('anything')).toBeNull();
  });
});

describe('WebSessionTokenService — configured', () => {
  const config = makeConfig({ JWT_SECRET: 'a-real-secret-value' });

  it('round-trips a signed token back to the same conversationId', () => {
    const service = new WebSessionTokenService(config);
    const token = service.sign({ conversationId: 'conv-42' });
    expect(token).not.toBeNull();
    const payload = service.verify(token as string);
    expect(payload?.conversationId).toBe('conv-42');
  });

  it('rejects a token signed with a different secret (tampered/forged)', () => {
    const service = new WebSessionTokenService(config);
    const otherService = new WebSessionTokenService(makeConfig({ JWT_SECRET: 'a-different-secret' }));
    const token = otherService.sign({ conversationId: 'conv-42' }) as string;
    expect(service.verify(token)).toBeNull();
  });

  it('rejects a token whose payload segment was edited after signing', () => {
    const service = new WebSessionTokenService(config);
    const token = service.sign({ conversationId: 'conv-42' }) as string;
    const [, sig] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ conversationId: 'conv-99', exp: Date.now() + 999_999 })).toString('base64url');
    expect(service.verify(`${tamperedPayload}.${sig}`)).toBeNull();
  });

  it('rejects malformed tokens (missing segments, garbage input) without throwing', () => {
    const service = new WebSessionTokenService(config);
    expect(service.verify('')).toBeNull();
    expect(service.verify('no-dot-here')).toBeNull();
    expect(service.verify('a.b.c')).toBeNull();
  });

  it('rejects an expired token', () => {
    const service = new WebSessionTokenService(config);
    const realNow = Date.now;
    Date.now = () => realNow() - 1000 * 60 * 200; // signed 200 minutes ago
    const token = service.sign({ conversationId: 'conv-42' }) as string;
    Date.now = realNow;
    expect(service.verify(token)).toBeNull();
  });
});
