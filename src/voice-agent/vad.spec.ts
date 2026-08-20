// vad.spec.ts: turn boundaries. Groq Whisper is batch, so a session with no VAD sends nothing to
// transcribe and answers nothing, and a session with no turn detection asks for a local
// end-of-turn executor this install excludes. Both shipped once and only showed on a live call.
import type { JobProcess } from '@livekit/agents';
import { VAD, initializeLogger, voice } from '@livekit/agents';
import agent, { TURN_HANDLING, checkTtsAccess, describeDisconnect, describeSessionError } from './main';

// AgentSession logs from its field initializers; outside cli.runApp nothing has set the logger up.
beforeAll(() => initializeLogger({ pretty: false, level: 'silent' }));

describe('voice worker VAD', () => {
  it('prewarm loads a VAD the AgentSession will accept', async () => {
    const proc = { userData: {} } as JobProcess<{ vad?: VAD }>;

    await agent.prewarm!(proc);

    expect(proc.userData.vad).toBeInstanceOf(VAD);
  }, 30000);

  it('resolves turn detection to the VAD instead of an inference turn detector', async () => {
    const proc = { userData: {} } as JobProcess<{ vad?: VAD }>;
    await agent.prewarm!(proc);

    const session = new voice.AgentSession({
      vad: proc.userData.vad,
      turnHandling: TURN_HANDLING,
    });

    expect(session.turnDetection).toBe('vad');
  }, 30000);

  // Four full requests per turn against a free tier of 8k tokens per minute is a 429 by the
  // second turn, which the session reports only as "failed to generate LLM completion".
  it('sends one request per turn instead of preempting three more', async () => {
    const proc = { userData: {} } as JobProcess<{ vad?: VAD }>;
    await agent.prewarm!(proc);

    const session = new voice.AgentSession({
      vad: proc.userData.vad,
      turnHandling: TURN_HANDLING,
    });

    expect(session.sessionOptions.turnHandling.preemptiveGeneration.enabled).toBe(false);
  }, 30000);
});

describe('voice worker error reporting', () => {
  it('names the provider status and limit instead of the wrapper message', () => {
    const apiError = Object.assign(new Error('Rate limit reached'), {
      statusCode: 429,
      body: { message: 'Limit 8000, Used 7899, Requested 1082' },
    });

    const described = describeSessionError({ type: 'llm_error', error: apiError });

    expect(described).toContain('429');
    expect(described).toContain('Limit 8000');
  });

  it('falls back to the message when the provider sent no body', () => {
    const described = describeSessionError({ type: 'tts_error', error: new Error('socket hang up') });

    expect(described).toContain('tts_error');
    expect(described).toContain('socket hang up');
  });
});

describe('voice worker TTS access', () => {
  const fakeFetch = (status: number, message?: string) =>
    (async () =>
      ({
        ok: status === 200,
        status,
        json: async () => ({ detail: { message } }),
      }) as unknown as Response) as unknown as typeof fetch;

  // A library voice on a free plan answers 402 forever: every call connects, transcribes and
  // then says nothing at all, which no other check in this worker would catch.
  it('treats a plan or key rejection as fatal and quotes the provider', async () => {
    const result = await checkTtsAccess(
      fakeFetch(402, 'Free users cannot use library voices via the API.'),
      { ELEVENLABS_VOICE_ID: 'v', ELEVENLABS_API_KEY: 'k' },
    );

    expect(result).toMatchObject({ ok: false, fatal: true });
    expect(result.detail).toContain('402');
    expect(result.detail).toContain('library voices');
  });

  it('keeps the worker alive when the provider is merely unreachable', async () => {
    const failing = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;

    const result = await checkTtsAccess(failing, { ELEVENLABS_VOICE_ID: 'v', ELEVENLABS_API_KEY: 'k' });

    expect(result).toMatchObject({ ok: false, fatal: false });
  });

  it('passes when the voice actually synthesizes', async () => {
    const result = await checkTtsAccess(fakeFetch(200), { ELEVENLABS_VOICE_ID: 'v', ELEVENLABS_API_KEY: 'k' });

    expect(result).toMatchObject({ ok: true, fatal: false });
  });
});

// "participant disconnect" es lo único que dejaba el worker cuando la llamada se cortaba, y no
// distingue a alguien colgando de una identidad duplicada, que es lo que pasa con dos pestañas.
describe('motivo de desconexión', () => {
  it('nombra el motivo que manda LiveKit', () => {
    expect(describeDisconnect(1)).toContain('CLIENT_INITIATED');
    expect(describeDisconnect(2)).toContain('DUPLICATE_IDENTITY');
    expect(describeDisconnect(14)).toContain('CONNECTION_TIMEOUT');
  });

  it('no se calla cuando no viene motivo ni cuando es uno que no conoce', () => {
    expect(describeDisconnect(undefined)).toBe('sin motivo reportado');
    expect(describeDisconnect(99)).toContain('99');
  });
});
