// telegram-adapter.service.spec.ts: tests TelegramAdapter.normalize — photo size
// selection, sender fields, and which media types are flagged as unsupported input.

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

  // 2026-07-24: a plain photo is no longer generically "unsupported" — the cosmetic
  // selfie-KYC step needs to receive one as a valid answer (see AgentService's
  // awaitingSelfie step). It carries width/height instead of a bare `true`, and
  // AgentService decides what that means based on conversation state (expected selfie
  // vs. a stray unrelated photo).
  it('regression — a plain photo sets photo dimensions instead of unsupportedInput, so a cosmetic selfie-KYC step can receive it', async () => {
    const result = await adapter.normalize(makeCtx({ photo: [{ file_id: 'photo-1', width: 100, height: 100 }] }));
    expect(result.photo).toEqual({ width: 100, height: 100 });
    expect(result.unsupportedInput).toBeUndefined();
  });

  // Telegram sends the SAME photo as an array of several resolutions (thumbnail up to
  // full size) — a tiny-image sanity check must look at the actual sent photo's real
  // size, not accidentally pick the smallest thumbnail and reject a perfectly good photo.
  it('picks the LARGEST of several Telegram-provided photo sizes for the dimensions', async () => {
    const result = await adapter.normalize(makeCtx({
      photo: [
        { file_id: 'thumb', width: 90, height: 90 },
        { file_id: 'medium', width: 320, height: 320 },
        { file_id: 'full', width: 1280, height: 960 },
      ],
    }));
    expect(result.photo).toEqual({ width: 1280, height: 960 });
  });

  it('sets messageId from the Telegram message_id', async () => {
    const result = await adapter.normalize(makeCtx({ message_id: 4242, text: 'hola' }));
    expect(result.messageId).toBe(4242);
  });

  // 2026-07-26 stuck-loop escalation feature — a human being handed the conversation
  // needs to know who to look for in Telegram (@handle), not just an opaque numeric id.
  it('captures the sender\'s Telegram @username when present', async () => {
    const result = await adapter.normalize(makeCtx({ from: { id: 222, username: 'alejoo_o' }, text: 'hola' }));
    expect(result.username).toBe('alejoo_o');
  });

  it('leaves username unset when Telegram provides none (not every account has one)', async () => {
    const result = await adapter.normalize(makeCtx({ text: 'hola' }));
    expect(result.username).toBeUndefined();
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

describe('TelegramAdapter.sendText — typing pacing (2026-07-24 gamification feedback)', () => {
  // Real feedback: a bot that instantly dumps text feels like an IVR menu, not a
  // conversation. A brief "typing..." indicator + pause reads as alive — no buttons or
  // menus involved (AGENTS.md rule 10 stays intact, this is pure pacing).
  function mockSendableBot() {
    return { api: { sendChatAction: jest.fn().mockResolvedValue(undefined), sendMessage: jest.fn().mockResolvedValue(undefined) } };
  }

  it('shows a typing indicator, then sends the message', async () => {
    const adapter = new TelegramAdapter(makeConfig());
    const bot = mockSendableBot();
    (adapter as any).bot = bot;

    await adapter.sendText('222', 'hola');
    expect(bot.api.sendChatAction).toHaveBeenCalledWith(222, 'typing');
    expect(bot.api.sendMessage).toHaveBeenCalledWith(222, 'hola', { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
  }, 10000);

  it('still sends the message even if the typing indicator call fails', async () => {
    const adapter = new TelegramAdapter(makeConfig());
    const bot = mockSendableBot();
    bot.api.sendChatAction.mockRejectedValue(new Error('rate limited'));
    (adapter as any).bot = bot;

    await adapter.sendText('222', 'hola');
    expect(bot.api.sendMessage).toHaveBeenCalledWith(222, 'hola', { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
  }, 10000);
});

describe('TelegramAdapter.normalize — contact sharing (2026-07-24 KYC feedback)', () => {
  const adapter = new TelegramAdapter(makeConfig());

  it('a contact shared via the native request_contact button sets the contact field', async () => {
    // makeCtx defaults from.id to 222 — a self-shared contact carries the same user_id,
    // which is exactly what Telegram guarantees for a request_contact button tap.
    const result = await adapter.normalize(makeCtx({
      contact: { phone_number: '+573001234567', first_name: 'Juan', user_id: 222 },
    }));
    expect(result.contact).toEqual({ phoneNumber: '+573001234567', firstName: 'Juan' });
  });

  it('regression — a forwarded contact card for someone else (user_id mismatch) is not treated as identity verification', async () => {
    const result = await adapter.normalize(makeCtx({
      contact: { phone_number: '+573009999999', first_name: 'Otro', user_id: 999 },
    }));
    expect(result.contact).toBeUndefined();
  });

  it('a contact with no user_id at all (non-Telegram contact) is not treated as identity verification', async () => {
    const result = await adapter.normalize(makeCtx({
      contact: { phone_number: '+573009999999', first_name: 'Otro' },
    }));
    expect(result.contact).toBeUndefined();
  });
});

describe('TelegramAdapter.sendContactRequest (2026-07-24 KYC feedback)', () => {
  function mockSendableBot() {
    return { api: { sendChatAction: jest.fn().mockResolvedValue(undefined), sendMessage: jest.fn().mockResolvedValue(undefined) } };
  }

  it('sends the prompt with a request_contact reply keyboard, not a free-form menu', async () => {
    const adapter = new TelegramAdapter(makeConfig());
    const bot = mockSendableBot();
    (adapter as any).bot = bot;

    await adapter.sendContactRequest('222', 'Confirmemos que eres tú');

    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      222,
      'Confirmemos que eres tú',
      expect.objectContaining({
        parse_mode: 'Markdown',
        reply_markup: expect.objectContaining({
          keyboard: [[expect.objectContaining({ request_contact: true })]],
        }),
      }),
    );
  }, 10000);
});

// 2026-07-26 Step 4 hybrid buttons — mirrors sendContactRequest's structure exactly.
// Reply keyboard ONLY, never InlineKeyboard: a tap arrives back as ordinary text on the
// same webhook, so it's a shortcut over the NLP path, not a separate callback_query flow.
describe('TelegramAdapter.sendChoices (2026-07-26 hybrid buttons)', () => {
  function mockSendableBot() {
    return { api: { sendChatAction: jest.fn().mockResolvedValue(undefined), sendMessage: jest.fn().mockResolvedValue(undefined) } };
  }

  it('sends the prompt with a plain reply keyboard (never inline_keyboard) offering the given choices', async () => {
    const adapter = new TelegramAdapter(makeConfig());
    const bot = mockSendableBot();
    (adapter as any).bot = bot;

    await adapter.sendChoices('222', '¿Qué te preocupa más?', ['❤️ Mi familia', '🏥 Mi salud', '🐾 Mi mascota']);

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const call = bot.api.sendMessage.mock.calls[0];
    expect(call[0]).toBe(222);
    expect(call[1]).toBe('¿Qué te preocupa más?');
    expect(call[2]).not.toHaveProperty('reply_markup.inline_keyboard');
    const keyboard = call[2].reply_markup.keyboard as { text: string }[][];
    const flatLabels = keyboard.flat().map((b) => b.text);
    expect(flatLabels).toEqual(['❤️ Mi familia', '🏥 Mi salud', '🐾 Mi mascota']);
  }, 10000);

  it('lays out 2 buttons per row', async () => {
    const adapter = new TelegramAdapter(makeConfig());
    const bot = mockSendableBot();
    (adapter as any).bot = bot;

    await adapter.sendChoices('222', 'Elige', ['A', 'B', 'C', 'D', 'E']);

    const keyboard = bot.api.sendMessage.mock.calls[0][2].reply_markup.keyboard as { text: string }[][];
    expect(keyboard.map((row) => row.length)).toEqual([2, 2, 1]);
  }, 10000);

  it('does nothing when the bot is disabled (no token)', async () => {
    const adapter = new TelegramAdapter(makeConfig());
    await expect(adapter.sendChoices('222', 'Elige', ['A', 'B'])).resolves.toBeUndefined();
  });
});

// 2026-07-24 feedback: "is there a way to show an animated successfully check pass
// inside the chat?" — Telegram's native message reactions render with a small built-in
// animation and need no hosted asset (GIF/sticker), unlike sendAnimation/sendSticker.
// 2026-07-24 feedback: a real branded success-checkmark video (src/assets/success-check.mp4)
// for the selfie-confirmed and payment-confirmed moments — heavier than a reaction, so
// used only where the user explicitly asked for it.
describe('TelegramAdapter.sendAnimation', () => {
  function mockSendableBot() {
    return { api: { sendAnimation: jest.fn().mockResolvedValue(undefined) } };
  }

  it('sends the animation file at the given path to the given user', async () => {
    const adapter = new TelegramAdapter(makeConfig());
    const bot = mockSendableBot();
    (adapter as any).bot = bot;

    await adapter.sendAnimation('222', 'C:/fake/success-check.mp4');

    expect(bot.api.sendAnimation).toHaveBeenCalledTimes(1);
    expect(bot.api.sendAnimation.mock.calls[0][0]).toBe(222);
  });

  it('never throws if the send fails (non-critical, the real text confirmation still matters most)', async () => {
    const adapter = new TelegramAdapter(makeConfig());
    const bot = { api: { sendAnimation: jest.fn().mockRejectedValue(new Error('network error')) } };
    (adapter as any).bot = bot;

    await expect(adapter.sendAnimation('222', 'C:/fake/success-check.mp4')).resolves.toBeUndefined();
  });

  it('does nothing when the bot is disabled (no token)', async () => {
    const adapter = new TelegramAdapter(makeConfig());
    await expect(adapter.sendAnimation('222', 'C:/fake/success-check.mp4')).resolves.toBeUndefined();
  });
});

describe('TelegramAdapter.reactToMessage', () => {
  function mockSendableBot() {
    return { api: { setMessageReaction: jest.fn().mockResolvedValue(undefined) } };
  }

  it('reacts to the given message id with the given emoji', async () => {
    const adapter = new TelegramAdapter(makeConfig());
    const bot = mockSendableBot();
    (adapter as any).bot = bot;

    await adapter.reactToMessage('222', 4242, '✅');

    expect(bot.api.setMessageReaction).toHaveBeenCalledWith(222, 4242, [{ type: 'emoji', emoji: '✅' }], expect.anything());
  });

  // 2026-07-24 feedback: the phone/contact-share confirmation gets a "big" reaction
  // (Telegram's is_big flag triggers a much larger animated burst) instead of the small
  // one used elsewhere.
  it('passes is_big through as the 4th setMessageReaction argument when requested', async () => {
    const adapter = new TelegramAdapter(makeConfig());
    const bot = mockSendableBot();
    (adapter as any).bot = bot;

    await adapter.reactToMessage('222', 4242, '✅', true);

    expect(bot.api.setMessageReaction).toHaveBeenCalledWith(222, 4242, [{ type: 'emoji', emoji: '✅' }], { is_big: true });
  });

  it('passes is_big: undefined when not requested (Telegram treats this as false)', async () => {
    const adapter = new TelegramAdapter(makeConfig());
    const bot = mockSendableBot();
    (adapter as any).bot = bot;

    await adapter.reactToMessage('222', 4242, '✅');

    expect(bot.api.setMessageReaction).toHaveBeenCalledWith(222, 4242, [{ type: 'emoji', emoji: '✅' }], { is_big: undefined });
  });

  it('never throws if the reaction call fails (cosmetic, non-critical)', async () => {
    const adapter = new TelegramAdapter(makeConfig());
    const bot = { api: { setMessageReaction: jest.fn().mockRejectedValue(new Error('rate limited')) } };
    (adapter as any).bot = bot;

    await expect(adapter.reactToMessage('222', 4242, '✅')).resolves.toBeUndefined();
  });

  // Real live-test report (reported 3 times): the "big" reaction on the contact-share
  // message reportedly never shows in Telegram, despite code review and passing tests
  // finding no bug. Logging the actual failure reason (instead of a silent .catch) turns
  // "still doesn't show, no idea why" into an actual Railway log line to diagnose from.
  it('regression — logs a warning with the real error when the reaction call fails, instead of swallowing it silently', async () => {
    const adapter = new TelegramAdapter(makeConfig());
    const bot = { api: { setMessageReaction: jest.fn().mockRejectedValue(new Error('REACTION_INVALID')) } };
    (adapter as any).bot = bot;
    const warnSpy = jest.spyOn((adapter as any).logger, 'warn').mockImplementation(() => undefined);

    await adapter.reactToMessage('222', 4242, '✅', true);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('REACTION_INVALID'));
  });

  it('does nothing when the bot is disabled (no token)', async () => {
    const adapter = new TelegramAdapter(makeConfig());
    await expect(adapter.reactToMessage('222', 4242, '✅')).resolves.toBeUndefined();
  });
});
