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
