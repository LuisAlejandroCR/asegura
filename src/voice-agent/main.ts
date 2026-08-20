// main.ts: AseguraWeb voice worker — a SEPARATE always-on process from the NestJS backend.
// LiveKit workers register and receive job dispatches; they never answer HTTP. Runs as its
// own Railway service via railway.voice.json. STT/LLM on Groq, TTS on ElevenLabs.
import { type JobContext, type JobProcess, type VAD, ServerOptions, cli, defineAgent, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as silero from '@livekit/agents-plugin-silero';
import * as fs from 'fs';
import dotenv from 'dotenv';
import { VOICE_GREETING, createVoiceAgent } from './agent';
import { VoiceSessionState } from './session-state';
import { buildVoiceDeps } from './deps';

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

// Left unset, AgentSession builds an InferenceTurnDetector and asks for the local end-of-turn
// executor on every turn — excluded from the install, so it fails and end-of-turn degrades to a
// positive default. The Silero VAD is the only turn boundary this worker has.
export const TURN_HANDLING = { turnDetection: 'vad' } as const;

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

    await ctx.connect();

    // The identity the token was minted with IS the conversationId (voice.controller.ts
    // passes it), so a call opened from a chat link can close the sale against that same
    // conversation. A standalone voz.html visit has a random identity and can only quote.
    const participant = await ctx.waitForParticipant();
    const state = new VoiceSessionState(participant.identity);

    await session.start({ agent: createVoiceAgent(state, buildVoiceDeps()), room: ctx.room });

    // say(), not generateReply(): the Ley 1581 notice has to come out word for word. The
    // consent gate itself lives in the agent instructions — this worker holds no state.
    session.say(VOICE_GREETING);
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
