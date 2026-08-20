// agent.spec.ts: verifies the voice persona actually has the cotizar tool wired in —
// the one thing regla #5 depends on for a real-time voice session. Doesn't touch
// main.ts (that file requires live LIVEKIT_*/GROQ/ElevenLabs env vars at import time by
// design — see its own header — so it's a script, not a unit under test).

import { VOICE_GREETING, VOICE_GREETING_AUTHORIZED, createVoiceAgent, greetingFor } from './agent';
import { VoiceSessionState } from './session-state';

describe('createVoiceAgent', () => {
  it('registers the cotizar tool', () => {
    const agent = createVoiceAgent(new VoiceSessionState('conv-1'));
    expect(agent.toolCtx.hasTool('cotizar')).toBe(true);
  });

  it('instructions tell the model to never state a price without calling cotizar', () => {
    const agent = createVoiceAgent(new VoiceSessionState('conv-1'));
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
    expect(VOICE_GREETING).not.toMatch(/https?:\/\/|[*_[\]`]/);
  });

  it('instructions forbid personal questions and tools before authorization', () => {
    const raw = String(createVoiceAgent(new VoiceSessionState('conv-1')).instructions).toLowerCase();
    // The prompt is hard-wrapped, so compare on normalised whitespace.
    const instructions = raw.replace(/\s+/g, ' ');
    expect(instructions).toContain('autorizar el tratamiento de sus datos');
    expect(instructions).toContain('hasta que autorice no preguntes nada personal ni uses otra herramienta');
  });

  // Consent lives in the conversation row, so a call opened from the chat spent its first
  // turn re-collecting an answer the person had already given.
  it('skips the consent question when the chat already holds it', () => {
    expect(greetingFor({ autorizado: true })).toBe(VOICE_GREETING_AUTHORIZED);
    expect(VOICE_GREETING_AUTHORIZED).not.toMatch(/¿.*autorizas.*\?/i);
    expect(VOICE_GREETING_AUTHORIZED).not.toMatch(/https?:\/\/|[*_[\]`]/);
  });

  it('still asks when nothing says the person authorized', () => {
    expect(greetingFor({})).toBe(VOICE_GREETING);
    expect(greetingFor({ autorizado: false })).toBe(VOICE_GREETING);
  });

  // The prompt is now the polite half. The binding half is that the shared tools refuse
  // without context.autorizado, which is asserted in modules/agent/tools/tools.spec.ts.
  it('carries the whole flow, not just cotizar — this is what audit 3.4 was about', () => {
    const agent = createVoiceAgent(new VoiceSessionState('conv-1'));
    for (const name of ['autorizar', 'consultar_afiliado', 'cotizar', 'seleccionar_producto', 'capturar_datos', 'registrar_mascotas', 'preguntas_aseguramiento', 'registrar_lead', 'escalar_a_humano', 'emitir_poliza', 'generar_link_pago']) {
      expect(agent.toolCtx.hasTool(name)).toBe(true);
    }
  });
});

// A call is not a form: the model asked for several things in one breath and re-asked what
// it already knew, so a minute of talking captured three fields.
describe('turn discipline on a call', () => {
  const instructions = () =>
    String(createVoiceAgent(new VoiceSessionState('conv-1')).instructions)
      .toLowerCase()
      .replace(/\s+/g, ' ');

  it('demands one question per turn and forbids bundling', () => {
    expect(instructions()).toContain('una sola pregunta por turno');
    expect(instructions()).toContain('nunca pidas dos datos a la vez');
  });

  it('tells the model not to re-ask what it already knows', () => {
    expect(instructions()).toContain('si ya sabes algo, no lo vuelvas a preguntar');
  });

  it('asks for cedula, nombre and correo one per turn instead of in one list', () => {
    expect(instructions()).toContain('uno por turno');
  });
});
