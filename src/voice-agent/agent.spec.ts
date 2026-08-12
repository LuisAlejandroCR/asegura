// agent.spec.ts: verifies the voice persona actually has the cotizar tool wired in —
// the one thing regla #5 depends on for a real-time voice session. Doesn't touch
// main.ts (that file requires live LIVEKIT_*/GROQ/ElevenLabs env vars at import time by
// design — see its own header — so it's a script, not a unit under test).

import { createVoiceAgent } from './agent';

describe('createVoiceAgent', () => {
  it('registers the cotizar tool', () => {
    const agent = createVoiceAgent();
    expect(agent.toolCtx.hasTool('cotizar')).toBe(true);
  });

  it('instructions tell the model to never state a price without calling cotizar', () => {
    const agent = createVoiceAgent();
    expect(String(agent.instructions)).toMatch(/cotizar/);
    expect(String(agent.instructions).toLowerCase()).toContain('nunca digas un precio');
  });
});
