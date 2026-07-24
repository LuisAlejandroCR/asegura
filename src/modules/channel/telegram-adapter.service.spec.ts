import { Logger } from '@nestjs/common';
import { TelegramAdapter } from './telegram-adapter.service';

function makeConfig(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: '', // disabled — normalize() doesn't need a real bot for these checks
    ...overrides,
  };
  return { get: jest.fn((key: string, def?: unknown) => values[key] ?? def) } as any;
}

function makeCtx(message: Record<string, unknown>) {
  return {
    message: {
      chat: { id: 111 },
      from: { id: 222 },
      date: 1700000000,
      ...message,
    },
    update: { update_id: 1 },
  } as any;
}

describe('TelegramAdapter.normalize — unsupported media', () => {
  const adapter = new TelegramAdapter(makeConfig());

  it('regression — a photo sets unsupportedInput to "image" instead of silently returning empty text', async () => {
    const result = await adapter.normalize(makeCtx({ photo: [{ file_id: 'photo-1', width: 100, height: 100 }] }));
    expect(result.unsupportedInput).toBe('image');
  });

  it('a document (e.g. PDF/file upload) also sets unsupportedInput to "image" (generic unreadable media)', async () => {
    const result = await adapter.normalize(makeCtx({ document: { file_id: 'doc-1', file_name: 'contract.pdf' } }));
    expect(result.unsupportedInput).toBe('image');
  });

  it('a sticker sets unsupportedInput to "image"', async () => {
    const result = await adapter.normalize(makeCtx({ sticker: { file_id: 'sticker-1' } }));
    expect(result.unsupportedInput).toBe('image');
  });

  it('a video sets unsupportedInput to "image"', async () => {
    const result = await adapter.normalize(makeCtx({ video: { file_id: 'video-1' } }));
    expect(result.unsupportedInput).toBe('image');
  });

  it('regression — a voice note longer than the threshold sets unsupportedInput to "audio_too_long" without attempting transcription', async () => {
    const result = await adapter.normalize(makeCtx({ voice: { file_id: 'voice-1', duration: 120 } }));
    expect(result.unsupportedInput).toBe('audio_too_long');
    expect(result.text).toBe('');
  });

  it('a short voice note (within threshold) does NOT set unsupportedInput', async () => {
    // TELEGRAM_BOT_TOKEN is empty in this config, so transcription itself no-ops and
    // returns '' — we only assert that the length check doesn't reject a short voice note.
    const result = await adapter.normalize(makeCtx({ voice: { file_id: 'voice-1', duration: 10 } }));
    expect(result.unsupportedInput).toBeUndefined();
  });

  it('a normal text message has no unsupportedInput', async () => {
    const result = await adapter.normalize(makeCtx({ text: 'hola' }));
    expect(result.unsupportedInput).toBeUndefined();
    expect(result.text).toBe('hola');
  });
});

describe('TelegramAdapter — transcribeVoice error handling', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  function makeEnabledConfig() {
    return {
      get: jest.fn((key: string, def?: unknown) => {
        const values: Record<string, string> = {
          TELEGRAM_BOT_TOKEN: 'bot-token',
          LLM_API_KEY: 'llm-key',
        };
        return values[key] ?? def;
      }),
    } as any;
  }

  function mockBotWithFile(adapter: TelegramAdapter) {
    (adapter as any).bot = { api: { getFile: jest.fn().mockResolvedValue({ file_path: 'voice/file123.oga' }) } };
  }

  // Regression: a non-2xx response from Groq's transcription endpoint (rate limit, bad
  // audio format, auth failure) was never checked — if the error body happened to be
  // valid JSON without a `text` field, transcribeVoice silently returned '' as if the
  // user had said nothing, with NO log at all distinguishing "transcription failed" from
  // "user was silent". It must still degrade gracefully (empty text, no crash) but the
  // failure has to be visible to whoever operates the bot.
  it('regression — a non-2xx Groq response is logged as an error, not silently swallowed', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }) // telegram file download
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' }) as any; // groq transcription

    const adapter = new TelegramAdapter(makeEnabledConfig());
    mockBotWithFile(adapter);

    const result = await adapter.normalize(makeCtx({ voice: { file_id: 'voice-1', duration: 10 } }));
    expect(result.text).toBe('');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('429'));
    errorSpy.mockRestore();
  });

  // Regression: transcribeVoice() returned '' immediately when LLM_API_KEY was unset,
  // with zero logging — indistinguishable from "user sent a silent voice note" in every
  // log and every downstream conversation. This is the exact live-test symptom "voice
  // still not identified": whoever operates the bot had no way to tell, from logs alone,
  // that voice was completely disabled by a missing env var (same var also breaks NLP,
  // but that path at least logs a warning on failure).
  it('regression — missing LLM_API_KEY is logged as a warning, not silently swallowed', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const config = {
      get: jest.fn((key: string, def?: unknown) => {
        const values: Record<string, string> = { TELEGRAM_BOT_TOKEN: 'bot-token' }; // no LLM_API_KEY
        return values[key] ?? def;
      }),
    } as any;
    const adapter = new TelegramAdapter(config);
    mockBotWithFile(adapter);

    const result = await adapter.normalize(makeCtx({ voice: { file_id: 'voice-1', duration: 10 } }));
    expect(result.text).toBe('');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('LLM_API_KEY'));
    warnSpy.mockRestore();
  });

  it('returns the transcribed text on a successful 2xx Groq response', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ text: 'hola quiero un seguro' }) }) as any;

    const adapter = new TelegramAdapter(makeEnabledConfig());
    mockBotWithFile(adapter);

    const result = await adapter.normalize(makeCtx({ voice: { file_id: 'voice-1', duration: 10 } }));
    expect(result.text).toBe('hola quiero un seguro');
  });
});
