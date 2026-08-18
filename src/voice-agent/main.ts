// main.ts: entry point for the AseguraWeb voice worker. This is a SEPARATE, always-on
// process from the NestJS backend (`dist/main`) — LiveKit Agents workers register with
// LiveKit's server and receive job dispatches, they don't answer HTTP requests. Deploy it
// as its own Railway service (see package.json's voice-agent:* scripts).
//
// STT/LLM via Groq (openai.STT/LLM.withGroq — confirmed against the plugin's real .d.ts,
// same OpenAI-compatible endpoint groq-nlp.service.ts already uses), TTS via ElevenLabs
// (already validated for Spanish/Colombian audio — Sesión 76's pitch narration).
import { type JobContext, ServerOptions, cli, defineAgent, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
// Namespace import, not default: tsconfig has allowSyntheticDefaultImports without
// esModuleInterop, so `import dotenv from 'dotenv'` type-checks but emits
// `dotenv_1.default.config()` — and dotenv's CJS export has no `.default`, so the worker
// died on this line before doing anything. (helmet in main.ts survives only because it
// happens to set module.exports.default.)
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

export default defineAgent({
  entry: async (ctx: JobContext) => {
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
  },
});

// Guard mirrors LiveKit's own documented pattern (there, `process.argv[1] ===
// fileURLToPath(import.meta.url)` for ESM) — only start the worker/CLI when this file
// runs directly, never as a side effect of another module importing it.
if (require.main === module) {
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
