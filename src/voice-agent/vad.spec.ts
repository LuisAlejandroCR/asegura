// vad.spec.ts: turn boundaries. Groq Whisper is batch, so a session with no VAD sends nothing to
// transcribe and answers nothing, and a session with no turn detection asks for a local
// end-of-turn executor this install excludes. Both shipped once and only showed on a live call.
import type { JobProcess } from '@livekit/agents';
import { VAD, initializeLogger, llm, voice } from '@livekit/agents';
import agent, { MAX_ITEMS_HISTORIAL, TURN_HANDLING, checkLlmAccess, checkTtsAccess, describeDisconnect, describeRequiredEnv, describeSessionError, describirProveedores, hayRespaldoElevenLabs, normalizarBaseUrl, usaElevenLabs, usaGroqLlm } from './main';

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

// Google devuelve sus fallos envueltos en un array, el SDK busca `error` en la raíz, no lo
// encuentra y descarta el texto: dos sesiones leyeron "(no body)" como si describiera la
// respuesta. Este chequeo pide el cuerpo por su cuenta antes de que el worker se registre.
describe('acceso al modelo de voz', () => {
  const respuesta = (status: number, body: string) =>
    (async () =>
      ({ ok: status === 200, status, text: async () => body }) as unknown as Response) as unknown as typeof fetch;

  const conProveedor = {
    VOICE_LLM_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    VOICE_LLM_MODEL: 'gemini-2.5-flash',
    VOICE_LLM_API_KEY: 'k',
  };

  // El 429 de Google gasta 180 caracteres en dos URLs de documentación antes de decir QUÉ cuota
  // se agotó, así que el corte del log dejaba fuera justo el dato que decide qué modelo usar.
  it('conserva el nombre de la cuota agotada, no las URLs de la documentación', async () => {
    const cuerpoReal = '[{ "error": { "code": 429, "message": "You exceeded your current quota, ' +
      'please check your plan and billing details. For more information on this error, head to: ' +
      'https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: ' +
      'https://ai.dev/rate-limit. * Quota exceeded for metric: generate_requests_per_model_per_day, ' +
      'limit: 20", "status": "RESOURCE_EXHAUSTED" } }]';

    const result = await checkLlmAccess(respuesta(429, cuerpoReal), conProveedor);

    expect(result.detail).toContain('generate_requests_per_model_per_day');
    expect(result.detail).toContain('limit: 20');
    expect(result.detail).not.toContain('https://ai.google.dev');
  });

  it('una cuota agotada no es fatal: se repone sola', async () => {
    const result = await checkLlmAccess(respuesta(429, 'quota'), conProveedor);
    expect(result).toMatchObject({ ok: false, fatal: false });
  });

  it('imprime el mensaje del proveedor, no el "(no body)" del SDK', async () => {
    const result = await checkLlmAccess(
      respuesta(400, '[{ "error": { "code": 400, "message": "Please pass a valid API key" } }]'),
      conProveedor,
    );

    expect(result).toMatchObject({ ok: false, fatal: true });
    expect(result.detail).toContain('Please pass a valid API key');
    expect(result.detail).not.toContain('no body');
  });

  it('nombra el modelo y la ruta, que es lo que un 404 no distingue', async () => {
    const result = await checkLlmAccess(respuesta(404, 'not found'), conProveedor);

    expect(result.detail).toContain('gemini-2.5-flash');
    expect(result.detail).toContain('generativelanguage.googleapis.com/v1beta/openai');
  });

  // Una cuota se repone sola: matar el worker por un 429 lo deja caído después del minuto malo.
  it('deja vivo al worker ante una cuota agotada', async () => {
    const result = await checkLlmAccess(respuesta(429, 'Insufficient balance'), conProveedor);

    expect(result).toMatchObject({ ok: false, fatal: false });
    expect(result.detail).toContain('Insufficient balance');
  });

  it('no gasta una petición cuando el modelo sale por la pasarela', async () => {
    const noDebeLlamarse = (async () => {
      throw new Error('no debió pedirse nada');
    }) as unknown as typeof fetch;

    await expect(checkLlmAccess(noDebeLlamarse, {})).resolves.toMatchObject({ ok: true });
  });

  it('pasa cuando el proveedor contesta', async () => {
    await expect(checkLlmAccess(respuesta(200, '{}'), conProveedor)).resolves.toMatchObject({
      ok: true,
      fatal: false,
    });
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

// El plan gratuito de ElevenLabs son 10.000 caracteres al mes: una demo los agota y el worker
// entra en bucle de reinicio. La pasarela de LiveKit sintetiza con las credenciales que el
// worker ya exige, así que no añade una cuota más que se pueda acabar sola.
describe('proveedor de voz', () => {
  it('usa la pasarela de LiveKit salvo que se pida ElevenLabs', () => {
    expect(usaElevenLabs({})).toBe(false);
    expect(usaElevenLabs({ VOICE_TTS: 'elevenlabs' })).toBe(true);
  });

  it('no exige las claves de ElevenLabs cuando no se usa', () => {
    const env = {
      LLM_API_KEY: 'k', LIVEKIT_URL: 'wss://x', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's',
    };

    expect(describeRequiredEnv(env).ok).toBe(true);
    expect(describeRequiredEnv(env).report).not.toContain('ELEVENLABS');
  });

  it('las sigue exigiendo cuando sí se usa', () => {
    const env = {
      VOICE_TTS: 'elevenlabs',
      LLM_API_KEY: 'k', LIVEKIT_URL: 'wss://x', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's',
    };

    expect(describeRequiredEnv(env).ok).toBe(false);
    expect(describeRequiredEnv(env).report).toContain('ELEVENLABS_API_KEY: MISSING');
  });
});

// El usuario pidió ElevenLabs de respaldo, no de reemplazo: si la pasarela falla a mitad de
// llamada, el adaptador cambia solo en vez de dejar la llamada muda.
describe('respaldo de voz', () => {
  it('hay respaldo cuando las claves de ElevenLabs están y no es la primaria', () => {
    expect(hayRespaldoElevenLabs({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v' })).toBe(true);
  });

  it('no hay respaldo sin claves', () => {
    expect(hayRespaldoElevenLabs({})).toBe(false);
    expect(hayRespaldoElevenLabs({ ELEVENLABS_API_KEY: 'k' })).toBe(false);
  });

  it('ElevenLabs no es su propio respaldo cuando ya es la primaria', () => {
    expect(hayRespaldoElevenLabs({ VOICE_TTS: 'elevenlabs', ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v' })).toBe(false);
  });
});

// El historial viaja entero en cada petición: en una llamada de ocho minutos el turno pasó de
// 1.844 a 3.711 tokens y el techo de 8.000 dejó de alcanzar para dos turnos por minuto.
describe('historial acotado', () => {
  it('recorta a un tope fijo en vez de crecer con la llamada', () => {
    const ctx = llm.ChatContext.empty();
    for (let i = 0; i < MAX_ITEMS_HISTORIAL + 15; i++) {
      ctx.addMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turno ${i}` });
    }

    expect(ctx.items.length).toBeGreaterThan(MAX_ITEMS_HISTORIAL);
    expect(ctx.copy().truncate(MAX_ITEMS_HISTORIAL).items.length).toBeLessThanOrEqual(MAX_ITEMS_HISTORIAL);
  });

  it('conserva los turnos más recientes, que son los que la venta necesita', () => {
    const ctx = llm.ChatContext.empty();
    for (let i = 0; i < MAX_ITEMS_HISTORIAL + 5; i++) {
      ctx.addMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turno ${i}` });
    }

    const recortado = JSON.stringify(ctx.copy().truncate(MAX_ITEMS_HISTORIAL).items);

    expect(recortado).toContain(`turno ${MAX_ITEMS_HISTORIAL + 4}`);
    expect(recortado).not.toContain('turno 0');
  });
});

// El gratuito de Groq son 8.000 tokens por minuto y 200.000 al día: el día entero se consumió a
// media mañana probando. La pasarela acepta las mismas herramientas, así que Groq queda de escape.
describe('proveedor del modelo', () => {
  it('usa la pasarela salvo que se pida Groq', () => {
    expect(usaGroqLlm({})).toBe(false);
    expect(usaGroqLlm({ VOICE_LLM: 'groq' })).toBe(true);
  });
});

// Un "ujum" duraba más de los 500 ms del default y cortaba al agente a media frase, porque
// `minWords` viene en 0: cualquier sonido cuenta como interrupción.
describe('respaldos verbales', () => {
  it('exige dos palabras para interrumpir, no un sonido', async () => {
    const proc = { userData: {} } as JobProcess<{ vad?: VAD }>;
    await agent.prewarm!(proc);

    const session = new voice.AgentSession({ vad: proc.userData.vad, turnHandling: TURN_HANDLING });

    expect(session.sessionOptions.turnHandling.interruption.minWords).toBeGreaterThanOrEqual(2);
  }, 30000);

  it('sigue reanudando cuando la interrupción resultó falsa', async () => {
    const proc = { userData: {} } as JobProcess<{ vad?: VAD }>;
    await agent.prewarm!(proc);

    const session = new voice.AgentSession({ vad: proc.userData.vad, turnHandling: TURN_HANDLING });

    expect(session.sessionOptions.turnHandling.interruption.resumeFalseInterruption).toBe(true);
  }, 30000);
});

// La barra final convierte la ruta en `openai//chat/completions`, que Google responde con un 404
// sin cuerpo: idéntico a un modelo inexistente o a una ruta equivocada.
describe('base URL del proveedor', () => {
  it('quita la barra final para no duplicarla al pegar la ruta', () => {
    expect(normalizarBaseUrl('https://x.dev/v1beta/openai/')).toBe('https://x.dev/v1beta/openai');
    expect(normalizarBaseUrl('https://x.dev/v1beta/openai///')).toBe('https://x.dev/v1beta/openai');
    expect(normalizarBaseUrl('  https://x.dev/v1beta/openai  ')).toBe('https://x.dev/v1beta/openai');
  });

  it('dice qué proveedor quedó puesto, sin filtrar la clave', () => {
    const dicho = describirProveedores({
      VOICE_LLM_BASE_URL: 'https://x.dev/v1beta/openai/',
      VOICE_LLM_MODEL: 'gemini-2.5-flash',
      VOICE_LLM_API_KEY: 'secreta-no-imprimir',
    });

    expect(dicho).toContain('gemini-2.5-flash');
    expect(dicho).toContain('https://x.dev/v1beta/openai');
    expect(dicho).not.toContain('secreta-no-imprimir');
  });

  // Google retiró `gemini-2.5-flash` para cuentas nuevas y responde 404: como el default vive en
  // tres sitios, el worker de Railway entró en bucle de reinicio sin que la variable local cambiara.
  it('el modelo por defecto del proveedor propio es el medido, no uno retirado', () => {
    const soloBase = { VOICE_LLM_BASE_URL: 'https://x.dev/v1beta/openai' };

    expect(describirProveedores(soloBase)).toContain('gemini-3.1-flash-lite');
    expect(describirProveedores(soloBase)).not.toContain('gemini-2.5-flash');
  });

  it('nombra la pasarela y Groq cuando son los que están puestos', () => {
    expect(describirProveedores({})).toContain('pasarela');
    expect(describirProveedores({ VOICE_LLM: 'groq' })).toContain('Groq');
  });
});
