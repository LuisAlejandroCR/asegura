// livekit-token.service.spec.ts: same optional-integration contract as every other
// external service in this codebase (disabled without a crash when unconfigured), plus
// the real AccessToken/VideoGrant shape a session actually needs.

import { LiveKitTokenService, VoiceSession } from './livekit-token.service';

function makeConfig(values: Record<string, string | undefined>) {
  return { get: jest.fn((key: string) => values[key]) } as any;
}

// createSession() returns null only when LIVEKIT_* is missing. The tests below configure it,
// so a null there is the failure itself — worth a named error rather than eight `!`.
async function session(service: LiveKitTokenService, identity?: string): Promise<VoiceSession> {
  const created = await service.createSession(identity);
  if (!created) throw new Error('createSession() returned null despite LIVEKIT_* being set');
  return created;
}

describe('LiveKitTokenService — LIVEKIT_* not fully set', () => {
  it('isEnabled is false and createSession returns null instead of throwing', async () => {
    const service = new LiveKitTokenService(makeConfig({}));
    expect(service.isEnabled).toBe(false);
    await expect(service.createSession()).resolves.toBeNull();
  });

  it('a partially-configured set (missing secret) still disables cleanly', async () => {
    const service = new LiveKitTokenService(makeConfig({
      LIVEKIT_URL: 'wss://x.livekit.cloud', LIVEKIT_API_KEY: 'key',
    }));
    expect(service.isEnabled).toBe(false);
  });
});

describe('LiveKitTokenService — configured', () => {
  const config = makeConfig({
    LIVEKIT_URL: 'wss://asegura.livekit.cloud',
    LIVEKIT_API_KEY: 'APItest',
    LIVEKIT_API_SECRET: 'secrettest',
  });

  it('returns a session with the configured url and a JWT-shaped token', async () => {
    const service = new LiveKitTokenService(config);
    const created = await session(service);
    expect(created.url).toBe('wss://asegura.livekit.cloud');
    // A real LiveKit access token is a signed JWT: three base64url segments.
    expect(created.token.split('.')).toHaveLength(3);
    expect(created.roomName).toMatch(/^asegura-/);
  });

  it('never reuses a room name across sessions — one throwaway room per session', async () => {
    const service = new LiveKitTokenService(config);
    const a = await session(service);
    const b = await session(service);
    expect(a.roomName).not.toBe(b.roomName);
  });

  // Live bug (2026-08-18): voz.html sat on "Te escucho…" forever. The worker registered
  // with LiveKit fine, but ServerOptions sets agentName: 'asegura-voice', and LiveKit
  // DISABLES automatic dispatch as soon as a worker is named — it only joins rooms it is
  // explicitly dispatched to. This token carried a VideoGrant and nothing else, so the
  // browser joined an empty room and waited for an agent nobody had asked for.
  it('dispatches the voice agent into the room — without this the browser joins a room no agent is ever sent to', async () => {
    const { TokenVerifier } = await import('livekit-server-sdk');
    const service = new LiveKitTokenService(config);
    const created = await session(service, 'afiliado-123');

    const verifier = new TokenVerifier('APItest', 'secrettest');
    const claims = await verifier.verify(created.token);
    expect(claims.roomConfig?.agents?.[0]?.agentName).toBe('asegura-voice');
  });

  it('the issued token actually grants roomJoin for the returned room, not a different one', async () => {
    const { TokenVerifier } = await import('livekit-server-sdk');
    const service = new LiveKitTokenService(config);
    const created = await session(service, 'afiliado-123');

    const verifier = new TokenVerifier('APItest', 'secrettest');
    const claims = await verifier.verify(created.token);
    expect(claims.video?.room).toBe(created.roomName);
    expect(claims.video?.roomJoin).toBe(true);
    expect(claims.sub).toBe('afiliado-123');
  });
});
