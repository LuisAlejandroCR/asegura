// main.ts: AseguraWeb voice worker — a SEPARATE always-on process from the NestJS backend.
// LiveKit workers register and receive job dispatches; they never answer HTTP. Runs as its
// own Railway service via railway.voice.json. STT on Groq; LLM y TTS por la pasarela de
// LiveKit, con Groq y ElevenLabs como escape por variable de entorno.
import { type JobContext, type JobProcess, type VAD, ServerOptions, cli, defineAgent, inference, tts as ttsLib, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as silero from '@livekit/agents-plugin-silero';
import * as krisp from '@livekit/agents-plugin-krisp';
import * as fs from 'fs';
import dotenv from 'dotenv';
import { greetingFor, createVoiceAgent, faseDe, herramientasDeFase, instruccionesCon } from './agent';
import { VoiceSessionState } from './session-state';
import { buildVoiceDeps, buildConversationLoader, buildConversationSaver } from './deps';
import { AcumuladorDeTurno } from './latencia';
import { describirHerramientasEjecutadas } from './herramientas-log';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to run the voice-agent worker — see .env.example`);
  }
  return value;
}

// ElevenLabs cobra su propia cuota —10.000 caracteres al mes en el gratuito, que una demo
// agota a mitad de camino— y su voz española exige plan pago. La pasarela de LiveKit sintetiza
// contra las credenciales que el worker ya necesita para existir, así que va primero y
// ElevenLabs queda de respaldo: si la primaria falla, el adaptador pasa a la otra sola.
export function usaElevenLabs(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VOICE_TTS === 'elevenlabs';
}

export function hayRespaldoElevenLabs(env: NodeJS.ProcessEnv = process.env): boolean {
  return !usaElevenLabs(env) && !!env.ELEVENLABS_API_KEY && !!env.ELEVENLABS_VOICE_ID;
}

// Flash v2.5 gasta 1 crédito por cada 2 caracteres —la mitad que multilingual v2, o sea el doble
// de llamadas por el mismo plan— y sintetiza en ~75 ms contra los cientos del otro. Lo paga con
// expresividad, que en un asesor de seguros cuesta menos que dejar un silencio. Ajustable en vivo
// por si una demo prefiere la voz rica, como el endpointing de la Sesión 121.
export function modeloElevenLabs(env: NodeJS.ProcessEnv = process.env): string {
  return env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
}

// Adri (`accent: colombian`, biblioteca compartida de ElevenLabs). El voice id que corría era
// una voz `premade` INGLESA leyendo español, que es lo que suena a robot — no el modelo. Se
// oyó contra Aitana (peninsular) y Alma (latinoamericana) antes de elegir.
export const VOZ_COLOMBIANA = '3pwz9prJRqL2Ws5zBmTh';

// BVC quita las voces de OTRAS personas y deja la del hablante principal; no es un filtro de
// ruido ambiente. Pesa más aquí que en otro proyecto: sin el detector semántico de fin de turno
// —excluido del install por 2 GB— el VAD de Silero es el único juez de que la persona terminó, y
// una conversación de fondo lo dispara igual que su voz. Se factura aparte desde el 2026-05-01,
// así que se apaga por variable sin tocar código.
export function usaCancelacionDeVoces(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VOICE_BVC !== 'off';
}

// Construirlo puede fallar donde el binario nativo no cargue. Una llamada con ruido es peor que
// una limpia y muchísimo mejor que ninguna, así que un fallo aquí degrada en vez de tumbar la
// sesión — el mismo trato que se le da a cada integración externa de este repo.
type OpcionesDeEntrada = { noiseCancellation?: ReturnType<typeof krisp.voiceIsolation> };

export function opcionesDeEntrada(
  env: NodeJS.ProcessEnv = process.env,
  construir: typeof krisp.voiceIsolation = krisp.voiceIsolation,
): OpcionesDeEntrada {
  if (!usaCancelacionDeVoces(env)) return {};
  try {
    return { noiseCancellation: construir() };
  } catch (err) {
    console.warn(
      '[asegura-voice] BVC no disponible, la llamada sigue sin él:',
      err instanceof Error ? err.message : err,
    );
    return {};
  }
}

// Checked at startup, not inside entry(): a key missing there lets the worker register and
// then fail per call with LiveKit's opaque "error in entry function" — no name, no stack.
const REQUIRED_BASE = ['LLM_API_KEY', 'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const;
const REQUIRED_ELEVENLABS = ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'] as const;
const REQUIRED_LLM_PROPIO = ['VOICE_LLM_API_KEY'] as const;

function requiredEnvNames(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return [
    ...REQUIRED_BASE,
    ...(env.VOICE_LLM_BASE_URL ? REQUIRED_LLM_PROPIO : []),
    ...(usaElevenLabs(env) ? REQUIRED_ELEVENLABS : []),
  ];
}

// Reports the state of EVERY required variable, not just the first missing one. Failing on
// the first says nothing about the other five, which turns "it is set" versus "the worker
// says it is not" into guesswork — and variables are per service, so the answer is usually
// that they live on a different one.
export function describeRequiredEnv(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  report: string;
} {
  const names = requiredEnvNames(env);
  const lines = names.map((name) => {
    const value = env[name];
    if (value === undefined) return `  ${name}: MISSING (not set on this service)`;
    if (!value) return `  ${name}: EMPTY (set, but with no value)`;
    return `  ${name}: ok (${value.length} chars)`;
  });
  return { ok: names.every((name) => !!env[name]), report: lines.join('\n') };
}

// No impiden arrancar —una llamada sin vuelta de Wompi sigue siendo una llamada— pero su
// ausencia no se nota hasta que alguien paga y se queda mirando el recibo. Las variables de
// Railway son por servicio y este worker es un servicio aparte del backend: estar puestas allá
// no las pone aquí. Verificado contra la API de Wompi: `redirect_url: null` en un link creado
// por esta ruta.
const RECOMENDADAS: Record<string, string> = {
  WEB_APP_URL: 'sin ella, el checkout de Wompi termina en su recibo y no vuelve a AseguraWeb',
  JWT_SECRET: 'sin él no se firma el token de vuelta, así que Wompi tampoco recibe redirect_url',
};

export function describirEnvRecomendado(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const faltantes = Object.keys(RECOMENDADAS).filter((name) => !env[name]);
  if (!faltantes.length) return undefined;
  return faltantes.map((name) => `  ${name}: MISSING — ${RECOMENDADAS[name]}`).join('\n');
}

type VoiceProcessData = { vad?: VAD };

// The retry loop logs the provider error as a structured field the container log drops, so a
// quota wall reads as "failed to generate LLM completion" with no status and no limit.
export function describeSessionError(error: unknown): string {
  const wrapped = (error as { error?: unknown })?.error;
  const cause = (wrapped instanceof Error ? wrapped : error) as Error & {
    statusCode?: number;
    body?: { message?: string } | null;
  };
  const parts = [(error as { type?: string })?.type ?? 'error'];
  if (cause?.statusCode !== undefined) parts.push('status=' + cause.statusCode);
  if (cause?.body?.message) parts.push(cause.body.message);
  else if (cause?.message) parts.push(cause.message);
  return parts.join(' ');
}

// Leídos de participant_pb: el worker solo registra "participant disconnect", que no
// distingue a alguien colgando de una identidad duplicada o de una caída de señal.
const MOTIVOS_DESCONEXION: Record<number, string> = {
  0: 'UNKNOWN_REASON', 1: 'CLIENT_INITIATED', 2: 'DUPLICATE_IDENTITY', 3: 'SERVER_SHUTDOWN',
  4: 'PARTICIPANT_REMOVED', 5: 'ROOM_DELETED', 6: 'STATE_MISMATCH', 7: 'JOIN_FAILURE',
  8: 'MIGRATION', 9: 'SIGNAL_CLOSE', 10: 'ROOM_CLOSED', 11: 'USER_UNAVAILABLE',
  12: 'USER_REJECTED', 13: 'SIP_TRUNK_FAILURE', 14: 'CONNECTION_TIMEOUT',
};

export function describeDisconnect(reason: number | undefined): string {
  if (reason === undefined) return 'sin motivo reportado';
  return `${MOTIVOS_DESCONEXION[reason] ?? 'motivo desconocido'} (${reason})`;
}

// Left unset, AgentSession builds an InferenceTurnDetector and asks for the local end-of-turn
// executor on every turn — excluded from the install, so it fails and end-of-turn degrades to a
// positive default. The Silero VAD is the only turn boundary this worker has.
//
// Preemptive generation defaults to on with maxRetries 3, so one turn can send four full
// requests — instructions plus eleven tool schemas, ~1.1k tokens each — and Groq's free tier
// allows 8k tokens per minute. Off, a turn costs one request instead of four.
// El historial entra entero en cada petición, así que una llamada larga se encarece sola: en
// una de ocho minutos los turnos pasaron de 1.844 a 3.711 tokens y el techo de 8.000 dejó de
// alcanzar para dos turnos por minuto. Lo que la venta necesita recordar vive en el estado y en
// las tools, no en la transcripción.
export const MAX_ITEMS_HISTORIAL = 20;

// `minWords` viene en 0, así que cualquier sonido de más de medio segundo corta al agente:
// un "ujum" o un "ajá" lo dejaban con la frase a medias. Con dos palabras, el respaldo verbal
// deja de interrumpir y una objeción de verdad sigue entrando.
// Sin el detector semántico de fin de turno —excluido del install por 2 GB— el único juez de que
// la persona terminó es el silencio, y los 550 ms del VAD son una pausa para pensar: el agente
// arrancaba encima de quien todavía estaba hablando. En modo VAD esto vale max(silencio, minDelay),
// así que sube la espera sin tocar el VAD, y se ajusta en vivo por variable.
export const ENDPOINTING_MIN_MS = 900;
const ENDPOINTING_MIN_PISO = 300;
const ENDPOINTING_MIN_TECHO = 3000;

// `minDuration` viene en 500 ms: en una llamada por altavoz, medio segundo es una silla que se
// mueve o alguien pasando, y con eso el agente se callaba a mitad de frase. Un segundo obliga a
// hablar de verdad para interrumpirlo. Es la única palanca que queda: el detector adaptativo de
// LiveKit —el que sabe distinguir un "ajá" de una objeción— exige un STT en streaming con
// transcripción alineada, y Groq Whisper es por lotes, así que se desactiva solo.
// El prompt inicial de Whisper: no es una instrucción, es vocabulario esperado, y sesga el
// decodificador hacia estas palabras. "Exequial", "Colsubsidio" y los nombres de aseguradora no
// salen en un modelo general, y "arroba" y "punto" son la mitad de un correo dictado. Se queda
// corto a propósito: un prompt largo, Whisper lo escupe dentro de la transcripción.
// `prompt` sí existe en las opciones del STT y `withGroq` lo reenvía con un spread, pero su
// firma no lo declara. Se ensancha el tipo en vez de construir el STT a mano: hacerlo a mano
// perdería el `useRealtime: false` que withGroq pone, o sea cambiar el transporte por una palabra.
type OpcionesStt = Parameters<typeof openai.STT.withGroq>[0] & { prompt?: string };

const VOCABULARIO =
  'Colsubsidio, Asegura, seguro exequial, accidentes personales, asistencias médicas, ' +
  'medicina prepagada para mascotas, MetLife, Chubb, Pan American Life, GEA, Grupo Recordar, ' +
  'BMI, VetPlus, Wompi, póliza, prima mensual, cédula de ciudadanía, cédula de extranjería, ' +
  'PEP, arroba, punto.';

export const INTERRUPCION_MIN_MS = 1000;
const INTERRUPCION_MIN_PISO = 300;
const INTERRUPCION_MIN_TECHO = 2000;

function msDeEnv(valor: string | undefined, porDefecto: number, piso: number, techo: number): number {
  const pedido = Number(valor);
  if (!valor || !Number.isFinite(pedido)) return porDefecto;
  return Math.min(Math.max(pedido, piso), techo);
}

export function turnHandlingCon(env: NodeJS.ProcessEnv = process.env) {
  const minDelay = msDeEnv(env.VOICE_ENDPOINTING_MIN_MS, ENDPOINTING_MIN_MS, ENDPOINTING_MIN_PISO, ENDPOINTING_MIN_TECHO);
  const minDuration = msDeEnv(env.VOICE_INTERRUPTION_MIN_MS, INTERRUPCION_MIN_MS, INTERRUPCION_MIN_PISO, INTERRUPCION_MIN_TECHO);

  return {
    turnDetection: 'vad',
    preemptiveGeneration: { enabled: false },
    interruption: {
      minWords: 2,
      minDuration,
      // Si tras cortarlo no llega ninguna transcripción, retoma la frase en vez de dar el turno
      // por cerrado. Es el default de la librería, escrito aquí porque es justo lo que evita que
      // un ruido deje al modelo completando de memoria una frase que nunca terminó.
      falseInterruptionTimeout: 2000,
      resumeFalseInterruption: true,
    },
    endpointing: { minDelay },
  } as const;
}

export const TURN_HANDLING = turnHandlingCon();

export default defineAgent<VoiceProcessData>({
  // Groq Whisper is batch, not streaming: without a VAD nothing decides where a user turn
  // ends, so no audio is ever sent to transcribe and the caller waits forever.
  prewarm: async (proc: JobProcess<VoiceProcessData>) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext<VoiceProcessData>) => {
    try {
      return await runSession(ctx);
    } catch (err) {
      // LiveKit reduces the cause to "error in entry function"; surface the real one.
      console.error('[asegura-voice] entry failed:', err instanceof Error ? err.stack ?? err.message : err);
      throw err;
    }
  },
});

function construirElevenLabs() {
  return new elevenlabs.TTS({
    apiKey: requireEnv('ELEVENLABS_API_KEY'),
    voiceId: requireEnv('ELEVENLABS_VOICE_ID'),
    model: modeloElevenLabs(),
    language: 'es',
  });
}

// El plan gratuito de Groq no da para una demo: 8.000 tokens por minuto y 200.000 al día, que
// una llamada larga agota — probado, con el día entero consumido a media mañana. La pasarela
// acepta las mismas herramientas (verificado: Gemini y GPT-4.1-mini llaman `cotizar` en menos de
// un segundo), así que Groq queda de escape con VOICE_LLM=groq.
export function usaGroqLlm(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VOICE_LLM === 'groq';
}

// El SDK pega `/chat/completions` a la base tal cual: con la barra final queda `openai//chat`,
// que Google responde 404 sin cuerpo, indistinguible de un modelo inexistente.
export function normalizarBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

// Sin esto, un 404 sin cuerpo no dice si sobra una barra, falta `v1beta/openai` o el modelo no
// existe. La clave nunca se imprime.
export function describirProveedores(env: NodeJS.ProcessEnv = process.env): string {
  const modelo = env.VOICE_LLM_BASE_URL
    ? `${env.VOICE_LLM_MODEL || 'gemini-3.1-flash-lite'} vía ${normalizarBaseUrl(env.VOICE_LLM_BASE_URL)}`
    : usaGroqLlm(env)
      ? `${env.LLM_MODEL || 'openai/gpt-oss-120b'} vía Groq`
      : `${env.VOICE_LLM_MODEL || 'google/gemini-2.5-flash'} vía la pasarela de LiveKit`;
  const voz = usaElevenLabs(env)
    ? 'ElevenLabs propia'
    : `${env.VOICE_TTS_MODEL || `elevenlabs/${modeloElevenLabs(env)}`} por la pasarela` +
      (hayRespaldoElevenLabs(env) ? ' con ElevenLabs de respaldo' : ' sin respaldo');
  return `modelo: ${modelo} | voz: ${voz}`;
}

function construirLlm() {
  // Groq y la pasarela se agotaron el mismo día, cada una por su lado. Con una base URL
  // compatible con OpenAI —Google AI Studio, Cerebras, OpenRouter— cambiar de proveedor deja de
  // ser un cambio de código y pasa a ser una variable.
  const baseURL = process.env.VOICE_LLM_BASE_URL;
  if (baseURL) {
    return new openai.LLM({
      model: process.env.VOICE_LLM_MODEL || 'gemini-3.1-flash-lite',
      apiKey: requireEnv('VOICE_LLM_API_KEY'),
      baseURL: normalizarBaseUrl(baseURL),
    });
  }
  if (usaGroqLlm()) {
    return openai.LLM.withGroq({
      model: process.env.LLM_MODEL || 'openai/gpt-oss-120b',
      apiKey: requireEnv('LLM_API_KEY'),
    });
  }
  return new inference.LLM({ model: process.env.VOICE_LLM_MODEL || 'google/gemini-2.5-flash' });
}

function construirTts() {
  if (usaElevenLabs()) return construirElevenLabs();

  // Adri, no Aitana: las dos son nativas, pero Aitana es peninsular y esto se vende en
  // Colombia. La ruta directa y la pasarela comparten voz a propósito — tenerlas distintas
  // fue justo el bug: la voz española estaba puesta aquí mientras la llamada real salía por
  // la otra ruta con una voz inglesa leyendo español, y sonaba a robot.
  const pasarela = new inference.TTS({
    model: process.env.VOICE_TTS_MODEL || `elevenlabs/${modeloElevenLabs()}`,
    voice: process.env.VOICE_TTS_VOICE || VOZ_COLOMBIANA,
    language: 'es',
  });
  if (!hayRespaldoElevenLabs()) return pasarela;

  return new ttsLib.FallbackAdapter({ ttsInstances: [pasarela, construirElevenLabs()] });
}

async function runSession(ctx: JobContext<VoiceProcessData>): Promise<void> {
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad ?? (await silero.VAD.load()),
      turnHandling: turnHandlingCon(),
      stt: openai.STT.withGroq({
        model: 'whisper-large-v3-turbo',
        apiKey: requireEnv('LLM_API_KEY'),
        language: 'es',
        prompt: VOCABULARIO,
      } as OpcionesStt),
      llm: construirLlm(),
      tts: construirTts(),
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      console.error('[asegura-voice] ' + describeSessionError(ev.error));
    });

    // Una sola línea por turno con las cuatro etapas del silencio: cuál se arregla no se
    // decide leyendo el código, sino viendo cuál de las cuatro se lleva el tiempo.
    const latencia = new AcumuladorDeTurno();
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      const linea = latencia.registrar(ev.metrics);
      if (linea) console.log('[asegura-voice] ' + linea);
    });

    await ctx.connect();

    // The identity the token was minted with IS the conversationId (voice.controller.ts
    // passes it), so a call opened from a chat link can close the sale against that same
    // conversation. A standalone voz.html visit has a random identity and can only quote.
    const participant = await ctx.waitForParticipant();
    const guardar = buildConversationSaver();
    const state = new VoiceSessionState(participant.identity, (context) => {
      void guardar(participant.identity, context);
    });
    state.hidratar(await buildConversationLoader()(participant.identity));

    const deps = buildVoiceDeps();
    const agent = createVoiceAgent(state, deps);

    // Sin esto la llamada se queda con las herramientas de la fase inicial: se autoriza y no
    // hay con qué cotizar. El evento llega justo cuando una herramienta cambió el estado.
    let fase = faseDe(state.context);
    let instrucciones = instruccionesCon(state.context);
    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
      const corridas = describirHerramientasEjecutadas(ev.functionCalls, ev.functionCallOutputs);
      if (corridas) console.log('[asegura-voice] ' + corridas);

      // El recorte del historial deja fuera la cotización y la póliza a los pocos minutos, así
      // que la venta en curso viaja en las instrucciones, que el recorte sí conserva.
      const siguientesInstrucciones = instruccionesCon(state.context);
      if (siguientesInstrucciones !== instrucciones) {
        instrucciones = siguientesInstrucciones;
        void agent.updateInstructions(siguientesInstrucciones);
      }

      const siguiente = faseDe(state.context);
      if (siguiente === fase) return;
      fase = siguiente;
      void agent.updateTools(herramientasDeFase(state, deps, siguiente));
    });

    ctx.room.on('participantDisconnected', (p: { identity?: string; disconnectReason?: number }) => {
      console.error('[asegura-voice] se fue el participante: ' + describeDisconnect(p.disconnectReason));
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, () => {
      const historial = agent.chatCtx;
      if (historial.items.length <= MAX_ITEMS_HISTORIAL) return;
      void agent.updateChatCtx(historial.copy().truncate(MAX_ITEMS_HISTORIAL));
    });

    await session.start({ agent, room: ctx.room, inputOptions: opcionesDeEntrada() });

    // say(), not generateReply(): the Ley 1581 notice has to come out word for word. Which
    // greeting depends on whether the chat already holds this person's consent.
    session.say(greetingFor(state.context));
}

// A key and a voice id that exist still buy nothing: a free plan answers 402 for library
// voices, the plugin drops the frame as an unknown context, and the caller hears a worker that
// looks healthy in every log. Only a real synthesis proves the pair can speak.
export async function checkTtsAccess(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; fatal: boolean; detail: string }> {
  try {
    const response = await fetchImpl(
      `https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}`,
      {
        method: 'POST',
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY ?? '', 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hola', model_id: modeloElevenLabs(env) }),
      },
    );
    if (response.ok) return { ok: true, fatal: false, detail: 'ok' };

    const body = (await response.json().catch(() => null)) as { detail?: { message?: string } } | null;
    return {
      ok: false,
      fatal: [401, 402, 403, 404].includes(response.status),
      detail: `${response.status} ${body?.detail?.message ?? 'no message'}`,
    };
  } catch (err) {
    return { ok: false, fatal: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

// El SDK del modelo busca `error` DENTRO del cuerpo del fallo. Google lo envuelve en un array
// —`[{"error":{...}}]`— así que no lo encuentra, y como el cuerpo sí era JSON válido tampoco
// conserva el texto crudo: todo fallo suyo llega como "400 status code (no body)", sea la clave,
// el modelo o la ruta. Una petición propia es lo único que imprime lo que el proveedor dijo.
// El 429 de Google gasta 180 caracteres en dos URLs de documentación antes de nombrar la cuota
// agotada, que es el dato que decide si el modelo sirve para una demo.
export function resumirCuerpoDeError(cuerpo: string): string {
  return cuerpo.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
}

export async function checkLlmAccess(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; fatal: boolean; detail: string }> {
  const baseURL = env.VOICE_LLM_BASE_URL;
  if (!baseURL) return { ok: true, fatal: false, detail: 'sin proveedor propio' };

  const model = env.VOICE_LLM_MODEL || 'gemini-3.1-flash-lite';
  const destino = normalizarBaseUrl(baseURL);
  try {
    const response = await fetchImpl(`${destino}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.VOICE_LLM_API_KEY ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 }),
    });
    if (response.ok) return { ok: true, fatal: false, detail: `${model} responde` };

    const cuerpo = resumirCuerpoDeError(await response.text().catch(() => ''));
    return {
      ok: false,
      // Una cuota agotada se repone sola; una clave, un modelo o una ruta mala no.
      fatal: [400, 401, 403, 404].includes(response.status),
      detail: `${model} vía ${destino} -> ${response.status} ${cuerpo.slice(0, 300) || '(cuerpo vacío)'}`,
    };
  } catch (err) {
    return { ok: false, fatal: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

// Only start the worker when this file runs directly, never as a side effect of an import.
if (require.main === module) {
  // Fail here, by name, instead of registering a worker that dies on every call.
  const env = describeRequiredEnv();
  if (!env.ok) {
    // Written to fd 2 directly: console output is an async pipe in a container and the throw
    // below has dropped this line before.
    try {
      fs.writeSync(2, `voice-agent env check:\n${env.report}\n`);
    } catch {
      // fd 2 closed: the throw still names the first offender.
    }
  }
  for (const name of requiredEnvNames()) requireEnv(name);
  void startWorker();
}

async function startWorker(): Promise<void> {
  // Solo ElevenLabs cobra aparte y puede quedarse sin cuota a mitad de mes; la pasarela de
  // LiveKit usa las credenciales que ya se verificaron por nombre.
  const tts = usaElevenLabs() ? await checkTtsAccess() : { ok: true, fatal: false, detail: 'livekit' };
  if (!tts.ok) {
    fs.writeSync(2, `voice-agent tts check: ${tts.detail}\n`);
    if (tts.fatal) process.exit(1);
  }

  const modelo = await checkLlmAccess();
  if (!modelo.ok) {
    fs.writeSync(2, `voice-agent llm check: ${modelo.detail}\n`);
    if (modelo.fatal) process.exit(1);
  }

  const recomendadas = describirEnvRecomendado();
  if (recomendadas) fs.writeSync(2, `voice-agent env recomendado:\n${recomendadas}\n`);

  fs.writeSync(1, `voice-agent ${describirProveedores()}
`);
  cli.runApp(
    new ServerOptions({
      agent: __filename,
      agentName: 'asegura-voice',
      // Sized for the container, not the CPU count. The default prewarms min(cores, 4) job
      // processes in production and each one re-imports this file, measured at ~2.5 GB total.
      // One idle process means the second concurrent caller waits for a cold start.
      numIdleProcesses: 1,
      wsURL: requireEnv('LIVEKIT_URL'),
      apiKey: requireEnv('LIVEKIT_API_KEY'),
      apiSecret: requireEnv('LIVEKIT_API_SECRET'),
    }),
  );
}
