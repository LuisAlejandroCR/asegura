// agent.spec.ts: verifies the voice persona actually has the cotizar tool wired in —
// the one thing regla #5 depends on for a real-time voice session. Doesn't touch
// main.ts (that file requires live LIVEKIT_*/GROQ/ElevenLabs env vars at import time by
// design — see its own header — so it's a script, not a unit under test).

import { VOICE_GREETING, VOICE_GREETING_AUTHORIZED, createVoiceAgent, greetingFor, faseDe, fichaDeVenta, herramientasDeFase } from './agent';
import { VoiceSessionState } from './session-state';

describe('createVoiceAgent', () => {
  it('registers the cotizar tool once the person authorized', () => {
    const state = new VoiceSessionState('conv-1');
    state.merge({ autorizado: true });
    expect(createVoiceAgent(state).toolCtx.hasTool('cotizar')).toBe(true);
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
  // Las fases reparten las herramientas para no mandar los once esquemas en cada turno; lo que
  // no puede perderse es que el canal siga llegando a todas, que es lo que cerró el 3.4.
  it('carries the whole flow, not just cotizar — this is what audit 3.4 was about', () => {
    const alcanzables = new Set<string>();
    for (const context of [{}, { autorizado: true }, { autorizado: true, quoteProductId: 'x' }]) {
      const state = new VoiceSessionState('conv-1');
      state.merge(context);
      for (const t of herramientasDeFase(state)) alcanzables.add((t as { name: string }).name);
    }
    for (const name of ['autorizar', 'consultar_afiliado', 'cotizar', 'seleccionar_producto', 'capturar_datos', 'registrar_mascotas', 'preguntas_aseguramiento', 'registrar_lead', 'escalar_a_humano', 'emitir_poliza', 'generar_link_pago']) {
      expect(alcanzables).toContain(name);
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

// Los esquemas de las herramientas son ~1.000 de los ~1.075 tokens fijos por petición, contra
// 8.000 por minuto en el plan gratuito: mandar las once en cada turno es lo que agota la cuota.
describe('herramientas por fase', () => {
  const nombres = (context: Record<string, unknown>) => {
    const state = new VoiceSessionState('conv-1');
    state.merge(context);
    return herramientasDeFase(state).map((t) => (t as { name: string }).name);
  };

  it('sin autorizar solo expone autorizar y escalar', () => {
    expect(faseDe({})).toBe('consentimiento');
    expect(nombres({})).toEqual(['autorizar', 'escalar_a_humano']);
  });

  it('autorizada y sin cotización, expone descubrimiento sin emitir ni cobrar', () => {
    expect(faseDe({ autorizado: true })).toBe('descubrimiento');
    const tools = nombres({ autorizado: true });
    expect(tools).toContain('cotizar');
    expect(tools).not.toContain('emitir_poliza');
    expect(tools).not.toContain('generar_link_pago');
  });

  it('con producto elegido expone el cierre completo', () => {
    expect(faseDe({ autorizado: true, quoteProductId: 'vida-pan-american' })).toBe('cierre');
    const tools = nombres({ autorizado: true, quoteProductId: 'vida-pan-american' });
    expect(tools).toContain('emitir_poliza');
    expect(tools).toContain('generar_link_pago');
    expect(tools).toContain('capturar_datos');
  });

  it('ninguna fase manda las once, que es lo que costaba la cuota', () => {
    expect(nombres({}).length).toBeLessThan(11);
    expect(nombres({ autorizado: true }).length).toBeLessThan(11);
    expect(nombres({ autorizado: true, quoteProductId: 'x' }).length).toBeLessThan(11);
  });

  it('escalar a un humano existe en todas las fases', () => {
    expect(nombres({})).toContain('escalar_a_humano');
    expect(nombres({ autorizado: true })).toContain('escalar_a_humano');
    expect(nombres({ autorizado: true, quoteProductId: 'x' })).toContain('escalar_a_humano');
  });
});

// El agente ofrecía otro seguro a mitad de la venta, así que la persona terminaba sin ninguno.
describe('una venta a la vez', () => {
  const instructions = () =>
    String(createVoiceAgent(new VoiceSessionState('conv-1')).instructions)
      .toLowerCase()
      .replace(/\s+/g, ' ');

  it('prohíbe ofrecer otro seguro antes de emitir y cobrar el actual', () => {
    expect(instructions()).toContain('una venta a la vez');
    expect(instructions()).toContain('emitida y pagada');
  });
});

// El historial se recorta a 20 ítems, así que a los pocos minutos el modelo ya no ve la
// cotización ni la póliza: preguntaba el correo dos veces, olvidaba el pago pendiente y
// terminaba ofreciendo otro seguro. El estado vive en las tools; esto se lo enseña.
describe('ficha de la venta en curso', () => {
  it('no dice nada cuando todavía no hay nada que recordar', () => {
    expect(fichaDeVenta({ autorizado: true })).toBe('');
  });

  it('nombra el producto, el precio y lo que falta', () => {
    const ficha = fichaDeVenta({
      autorizado: true,
      quoteSnapshot: {
        productId: 'vida-pan-american', producto: 'Seguro de vida', aseguradora: 'Pan American Life',
        precioMensual: 12000, coberturas: [],
      },
      quoteProductId: 'vida-pan-american',
      cedula: '1234567890',
      nombre: 'Ana Gómez',
    });

    expect(ficha).toContain('Seguro de vida');
    expect(ficha).toContain('12000');
    expect(ficha).toContain('correo');
  });

  it('avisa que hay una póliza esperando pago, que es lo que se olvidaba', () => {
    const ficha = fichaDeVenta({
      autorizado: true,
      quoteProductId: 'vida-pan-american',
      policyId: 'pol-1',
      checkoutUrl: 'https://checkout.wompi.co/l/x',
    });

    expect(ficha).toContain('pol-1');
    expect(ficha).toContain('pago');
  });

  it('no repite como pendiente un dato ya capturado', () => {
    const ficha = fichaDeVenta({
      autorizado: true, quoteProductId: 'x',
      cedula: '1234567890', documentType: 'CC', nombre: 'Ana Gómez', email: 'ana@ejemplo.co',
    });

    expect(ficha).not.toContain('Falta');
  });
});

// Quien ya compró vuelve con cédula, nombre y correo en la fila. La llamada se los preguntaba
// otra vez de a uno —cuatro turnos de interrogatorio— porque el modelo no ve la fila.
describe('datos de una compra anterior', () => {
  const contextoDeQuienYaCompro = {
    autorizado: true,
    quoteProductId: 'exequial-recordar',
    hasCompletedPurchase: true,
    cedula: '1234567890',
    documentType: 'CC' as const,
    nombre: 'Ana Gómez',
    email: 'ana@ejemplo.co',
  };

  it('se los dicta al modelo con la orden de confirmarlos, no de preguntarlos', () => {
    const ficha = fichaDeVenta(contextoDeQuienYaCompro);

    expect(ficha).toContain('1234567890');
    expect(ficha).toContain('Ana Gómez');
    expect(ficha).toContain('ana@ejemplo.co');
    expect(ficha).toContain('No se los preguntes de nuevo');
    expect(ficha).toContain('confirme');
  });

  it('lee el tipo de documento en palabras, que es como suena por teléfono', () => {
    expect(fichaDeVenta(contextoDeQuienYaCompro)).toContain('cédula de ciudadanía 1234567890');
    expect(fichaDeVenta({ ...contextoDeQuienYaCompro, documentType: 'PEP' })).toContain('PEP 1234567890');
  });

  // Una cédula archivada antes de la Sesión 131 no trae tipo, y sin preguntarlo la póliza sale
  // impresa como cédula de ciudadanía sin que nadie lo haya dicho.
  it('pregunta de qué documento es un número guardado sin tipo', () => {
    const { documentType, ...sinTipo } = contextoDeQuienYaCompro;
    void documentType;
    const ficha = fichaDeVenta(sinTipo);

    expect(ficha).toContain('Falta por capturar');
    expect(ficha).toContain('de qué documento es ese número');
    expect(ficha).not.toContain('la cédula,');
  });

  it('sigue pidiendo lo que de verdad falta', () => {
    const ficha = fichaDeVenta({
      autorizado: true, quoteProductId: 'exequial-recordar',
      cedula: '1234567890', documentType: 'CC', nombre: 'Ana Gómez',
    });

    expect(ficha).toContain('Falta por capturar: el correo');
  });

  it('las instrucciones prohíben volver a pedir lo que el estado ya trae', () => {
    const instructions = String(createVoiceAgent(new VoiceSessionState('conv-1')).instructions)
      .toLowerCase()
      .replace(/\s+/g, ' ');

    expect(instructions).toContain('son de una compra anterior y no se vuelven a preguntar');
    expect(instructions).toContain('si te corrige alguno, pide solo ese');
  });
});
