// vad.spec.ts: turn boundaries. Groq Whisper is batch, so a session with no VAD sends nothing to
// transcribe and answers nothing, and a session with no turn detection asks for a local
// end-of-turn executor this install excludes. Both shipped once and only showed on a live call.
import type { JobProcess } from '@livekit/agents';
import { VAD, initializeLogger, voice } from '@livekit/agents';
import agent, { TURN_HANDLING } from './main';

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
});
