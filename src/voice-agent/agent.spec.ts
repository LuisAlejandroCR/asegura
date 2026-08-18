// agent.spec.ts: verifies the voice persona actually has the cotizar tool wired in —
// the one thing regla #5 depends on for a real-time voice session. Doesn't touch
// main.ts (that file requires live LIVEKIT_*/GROQ/ElevenLabs env vars at import time by
// design — see its own header — so it's a script, not a unit under test).

import { VOICE_GREETING, createVoiceAgent } from './agent';

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

// The text channel gates on an AUTHORIZATION state; this worker holds no state, so the
// disclosure is a fixed spoken string and the gate is a prompt rule. Both are asserted here
// because nothing else can catch a silent regression on a legal requirement.
describe('Ley 1581 consent on the voice channel', () => {
  it('discloses the law, the transcription and asks for authorization', () => {
    expect(VOICE_GREETING).toContain('Ley 1581');
    expect(VOICE_GREETING.toLowerCase()).toContain('se transcribe');
    expect(VOICE_GREETING).toMatch(/¿.*autorizas.*\?/i);
  });

  it('stays speakable — TTS reads it aloud, so no markdown and no URLs', () => {
    expect(VOICE_GREETING).not.toMatch(/https?:\/\/|[*_\[\]`]/);
  });

  it('instructions forbid cotizar and personal questions before authorization', () => {
    const instructions = String(createVoiceAgent().instructions).toLowerCase();
    expect(instructions).toContain('autorizar el tratamiento de sus datos');
    expect(instructions).toMatch(/hasta que responda que sí[\s\S]*no uses la herramienta/);
  });
});
