// vad.spec.ts: a session built without a VAD answers nothing and shows no error — Groq Whisper
// is batch, so with no turn boundary no audio is ever sent to transcribe. That shipped once and
// was only visible on a live call, hence this test.
import type { JobProcess } from '@livekit/agents';
import { VAD } from '@livekit/agents';
import agent from './main';

describe('voice worker VAD', () => {
  it('prewarm loads a VAD the AgentSession will accept', async () => {
    const proc = { userData: {} } as JobProcess<{ vad?: VAD }>;

    await agent.prewarm!(proc);

    expect(proc.userData.vad).toBeInstanceOf(VAD);
  }, 30000);
});
