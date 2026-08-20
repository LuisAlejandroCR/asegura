// env-check.spec.ts: the worker used to fail on the first missing variable, which said nothing
// about the other five — so "it is set" and "the worker says it is not" could not be told
// apart. This reports every one, and distinguishes absent from set-but-empty.
import { describeRequiredEnv } from './main';

// VOICE_TTS=elevenlabs porque este spec cubre el caso de las seis variables; con la pasarela
// de LiveKit por defecto, las dos de ElevenLabs ya no son obligatorias.
const full = {
  VOICE_TTS: 'elevenlabs',
  LLM_API_KEY: 'gsk_x', ELEVENLABS_API_KEY: 'el_x', ELEVENLABS_VOICE_ID: 'voice',
  LIVEKIT_URL: 'wss://x', LIVEKIT_API_KEY: 'api', LIVEKIT_API_SECRET: 'secret',
};

describe('describeRequiredEnv', () => {
  it('pasa cuando las seis están', () => {
    const { ok, report } = describeRequiredEnv(full);
    expect(ok).toBe(true);
    expect(report).not.toContain('MISSING');
  });

  it('distingue ausente de vacía — no es lo mismo al depurar', () => {
    const { ok, report } = describeRequiredEnv({ ...full, LLM_API_KEY: '', ELEVENLABS_VOICE_ID: undefined });
    expect(ok).toBe(false);
    expect(report).toContain('LLM_API_KEY: EMPTY');
    expect(report).toContain('ELEVENLABS_VOICE_ID: MISSING');
  });

  it('reporta las seis, no solo la primera que falla', () => {
    const { report } = describeRequiredEnv({ VOICE_TTS: 'elevenlabs' });
    for (const name of ['LLM_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) {
      expect(report).toContain(name);
    }
  });

  it('con la pasarela de LiveKit reporta las cuatro que sí hacen falta', () => {
    const { report } = describeRequiredEnv({});
    for (const name of ['LLM_API_KEY', 'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) {
      expect(report).toContain(name);
    }
    expect(report).not.toContain('ELEVENLABS');
  });

  it('nunca imprime el valor, solo su longitud', () => {
    const { report } = describeRequiredEnv(full);
    expect(report).not.toContain('gsk_x');
    expect(report).toContain('5 chars');
  });
});
