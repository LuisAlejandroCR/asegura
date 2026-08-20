// main.ts: AseguraWeb voice worker — a SEPARATE always-on process from the NestJS backend.
// LiveKit workers register and receive job dispatches; they never answer HTTP. Runs as its
// own Railway service via railway.voice.json. STT/LLM on Groq, TTS on ElevenLabs.
import { type JobContext, type JobProcess, type VAD, ServerOptions, cli, defineAgent, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as silero from '@livekit/agents-plugin-silero';
import * as fs from 'fs';
import dotenv from 'dotenv';
import { greetingFor, createVoiceAgent, faseDe, herramientasDeFase } from './agent';
import { VoiceSessionState } from './session-state';
import { buildVoiceDeps, buildConversationLoader } from './deps';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to run the voice-agent worker — see .env.example`);
  }
  return value;
}

// Checked at startup, not inside entry(): a key missing there lets the worker register and
// then fail per call with LiveKit's opaque "error in entry function" — no name, no stack.
const REQUIRED_ENV = [
  'LLM_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID',
  'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET',
] as const;

// Reports the state of EVERY required variable, not just the first missing one. Failing on
// the first says nothing about the other five, which turns "it is set" versus "the worker
// says it is not" into guesswork — and variables are per service, so the answer is usually
// that they live on a different one.
export function describeRequiredEnv(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  report: string;
} {
  const lines = REQUIRED_ENV.map((name) => {
    const value = env[name];
    if (value === undefined) return `  ${name}: MISSING (not set on this service)`;
    if (!value) return `  ${name}: EMPTY (set, but with no value)`;
    return `  ${name}: ok (${value.length} chars)`;
  });
  return { ok: REQUIRED_ENV.every((name) => !!env[name]), report: lines.join('\n') };
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
export const TURN_HANDLING = {
  turnDetection: 'vad',
  preemptiveGeneration: { enabled: false },
} as const;

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

async function runSession(ctx: JobContext<VoiceProcessData>): Promise<void> {
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad ?? (await silero.VAD.load()),
      turnHandling: TURN_HANDLING,
      stt: openai.STT.withGroq({
        model: 'whisper-large-v3-turbo',
        apiKey: requireEnv('LLM_API_KEY'),
        language: 'es',
      }),
      llm: openai.LLM.withGroq({
        model: process.env.LLM_MODEL || 'openai/gpt-oss-120b',
        apiKey: requireEnv('LLM_API_KEY'),
      }),
      tts: new elevenlabs.TTS({
        apiKey: requireEnv('ELEVENLABS_API_KEY'),
        voiceId: requireEnv('ELEVENLABS_VOICE_ID'),
        model: 'eleven_multilingual_v2',
        language: 'es',
      }),
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      console.error('[asegura-voice] ' + describeSessionError(ev.error));
    });

    await ctx.connect();

    // The identity the token was minted with IS the conversationId (voice.controller.ts
    // passes it), so a call opened from a chat link can close the sale against that same
    // conversation. A standalone voz.html visit has a random identity and can only quote.
    const participant = await ctx.waitForParticipant();
    const state = new VoiceSessionState(participant.identity);
    state.merge(await buildConversationLoader()(participant.identity));

    const deps = buildVoiceDeps();
    const agent = createVoiceAgent(state, deps);

    // Sin esto la llamada se queda con las herramientas de la fase inicial: se autoriza y no
    // hay con qué cotizar. El evento llega justo cuando una herramienta cambió el estado.
    let fase = faseDe(state.context);
    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, () => {
      const siguiente = faseDe(state.context);
      if (siguiente === fase) return;
      fase = siguiente;
      void agent.updateTools(herramientasDeFase(state, deps, siguiente));
    });

    ctx.room.on('participantDisconnected', (p: { identity?: string; disconnectReason?: number }) => {
      console.error('[asegura-voice] se fue el participante: ' + describeDisconnect(p.disconnectReason));
    });

    await session.start({ agent, room: ctx.room });

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
        body: JSON.stringify({ text: 'Hola', model_id: 'eleven_multilingual_v2' }),
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
  for (const name of REQUIRED_ENV) requireEnv(name);
  void startWorker();
}

async function startWorker(): Promise<void> {
  const tts = await checkTtsAccess();
  if (!tts.ok) {
    fs.writeSync(2, `voice-agent tts check: ${tts.detail}\n`);
    if (tts.fatal) process.exit(1);
  }
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
