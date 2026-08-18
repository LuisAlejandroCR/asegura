// main.ts: AseguraWeb voice worker — a SEPARATE always-on process from the NestJS backend.
// LiveKit workers register and receive job dispatches; they never answer HTTP. Runs as its
// own Railway service via railway.voice.json. STT/LLM on Groq, TTS on ElevenLabs.
import { type JobContext, ServerOptions, cli, defineAgent, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
// Namespace import, not default: allowSyntheticDefaultImports without esModuleInterop makes
// `import dotenv from` type-check but emit `.default.config()`, which dotenv's CJS lacks.
import * as dotenv from 'dotenv';
import { createVoiceAgent } from './agent';

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
const ENTRY_REQUIRED_ENV = ['LLM_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'] as const;

export default defineAgent({
  entry: async (ctx: JobContext) => {
    try {
      return await runSession(ctx);
    } catch (err) {
      // LiveKit reduces the cause to "error in entry function"; surface the real one.
      console.error('[asegura-voice] entry failed:', err instanceof Error ? err.stack ?? err.message : err);
      throw err;
    }
  },
});

async function runSession(ctx: JobContext): Promise<void> {
    const session = new voice.AgentSession({
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

    await session.start({ agent: createVoiceAgent(), room: ctx.room });
    await ctx.connect();

    // The greeting is spoken, not read from STATE_RESPONSES[GREETING] — this is a
    // genuinely different channel (real-time voice, no Ley 1581 button/text flow yet;
    // see plan 17 for why AseguraWeb's own authorization step isn't built here).
    await session.generateReply({
      instructions: 'Saluda brevemente como Asegura y pregunta qué le gustaría proteger.',
    });
}

// Guard mirrors LiveKit's own documented pattern (there, `process.argv[1] ===
// fileURLToPath(import.meta.url)` for ESM) — only start the worker/CLI when this file
// runs directly, never as a side effect of another module importing it.
if (require.main === module) {
  // Fail here, by name, instead of registering a worker that dies on every call.
  for (const name of ENTRY_REQUIRED_ENV) requireEnv(name);
  cli.runApp(
    new ServerOptions({
      agent: __filename,
      agentName: 'asegura-voice',
      wsURL: requireEnv('LIVEKIT_URL'),
      apiKey: requireEnv('LIVEKIT_API_KEY'),
      apiSecret: requireEnv('LIVEKIT_API_SECRET'),
    }),
  );
}
