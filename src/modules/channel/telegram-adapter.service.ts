import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context, InputFile, Keyboard, webhookCallback } from 'grammy';
import { createReadStream } from 'fs';
import { IChannelAdapter, NormalizedMessage } from './types';

@Injectable()
export class TelegramAdapter implements IChannelAdapter, OnApplicationBootstrap {
  private readonly logger = new Logger(TelegramAdapter.name);
  private bot: Bot | null = null;
  private enabled = false;

  constructor(private readonly config: ConfigService) {
    const token = config.get<string>('TELEGRAM_BOT_TOKEN');
    if (token) {
      this.bot = new Bot(token);
      this.enabled = true;
    } else {
      this.logger.warn('TELEGRAM_BOT_TOKEN not set — Telegram disabled');
    }
  }

  onApplicationBootstrap() {
    if (this.enabled && this.bot && this.config.get<string>('TELEGRAM_WEBHOOK_SECRET')) {
      const host = this.config.get<string>('PUBLIC_URL', '');
      if (host) {
        const secret = this.config.getOrThrow<string>('TELEGRAM_WEBHOOK_SECRET');
        this.logger.log(`Telegram ready`); // webhook set in main.ts
      }
    }
  }

  get instance(): Bot | null {
    return this.bot;
  }

  // Voice notes longer than this aren't worth transcribing — a quick insurance chat
  // answer is never this long, and it avoids paying for a large Whisper API call just
  // to reject it anyway.
  private static readonly MAX_VOICE_DURATION_SECONDS = 60;

  async normalize(raw: unknown): Promise<NormalizedMessage> {
    const ctx = raw as Context;
    const msg = ctx.message ?? ctx.editedMessage;

    let text = msg?.text ?? '';
    let unsupportedInput: NormalizedMessage['unsupportedInput'];

    // Only self-shared contacts count as identity verification — Telegram guarantees
    // contact.user_id equals the sender's own id for a native request_contact button
    // tap, but a manually forwarded contact card (someone else's, or a non-Telegram
    // number with no user_id at all) must NOT silently pass as "the user proved it's them".
    const senderId = msg?.from?.id ?? ctx.from?.id;
    const contact = (msg?.contact && msg.contact.user_id === senderId)
      ? { phoneNumber: msg.contact.phone_number, firstName: msg.contact.first_name }
      : undefined;

    // Telegram sends the same photo as several resolutions (thumbnail up to full
    // size) — the LARGEST one reflects the actual photo that was sent, needed for a
    // tiny-image sanity check (an icon/sticker-shaped file, not a real camera photo)
    // without doing any real face detection.
    const photo = msg?.photo?.length
      ? msg.photo.reduce((max, p) => (p.width > max.width ? { width: p.width, height: p.height } : max), { width: msg.photo[0].width, height: msg.photo[0].height })
      : undefined;

    if (msg?.document || msg?.sticker || msg?.video || msg?.video_note) {
      unsupportedInput = 'image';
    } else if (msg?.voice) {
      if (msg.voice.duration > TelegramAdapter.MAX_VOICE_DURATION_SECONDS) {
        unsupportedInput = 'audio_too_long';
      } else if (!text) {
        try {
          text = await this.transcribeVoice(msg.voice.file_id);
        } catch (err) {
          this.logger.error(`Voice transcription failed: ${err}`);
        }
      }
    }

    return {
      channelId: String(msg?.chat.id ?? ctx.chat?.id),
      channel: 'telegram',
      userId: String(msg?.from?.id ?? ctx.from?.id),
      text,
      timestamp: msg?.date ? new Date(msg.date * 1000) : new Date(),
      metadata: { updateId: ctx.update.update_id },
      ...(unsupportedInput && { unsupportedInput }),
      ...(contact && { contact }),
      ...(photo && { photo }),
      ...(msg?.message_id !== undefined && { messageId: msg.message_id }),
    };
  }

  private async transcribeVoice(fileId: string): Promise<string> {
    if (!this.bot) return '';
    const llmKey = this.config.get<string>('LLM_API_KEY');
    if (!llmKey) {
      // Regression: this used to return '' with no log at all — indistinguishable in
      // every log line from "the user sent a silent voice note". Voice was completely
      // (and invisibly) disabled by a missing env var — the exact live-test symptom
      // "voice still not identified", with nothing in the logs pointing at the cause.
      this.logger.warn('LLM_API_KEY not set — voice transcription disabled');
      return '';
    }
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? '';

    const fileInfo = await this.bot.api.getFile(fileId);
    if (!fileInfo.file_path) return '';

    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
    const fileRes = await fetch(fileUrl);
    const audioBuffer = Buffer.from(await fileRes.arrayBuffer());

    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'es');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${llmKey}` },
      body: form,
    });

    if (!res.ok) {
      // A non-2xx response with a valid-JSON error body would otherwise fall through to
      // `data.text ?? ''`, indistinguishable from "the user said nothing" — throwing here
      // routes it through normalize()'s existing catch, so the failure is at least logged.
      throw new Error(`Groq transcription failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as { text?: string };
    this.logger.log(`Voice transcribed: "${(data.text ?? '').slice(0, 80)}"`);
    return data.text ?? '';
  }

  // A brief typing indicator (2026-07-24 feedback) — instant text dumps read as an IVR
  // menu, not a conversation. Purely pacing, no buttons/menus (AGENTS.md rule 10 intact).
  private static readonly TYPING_DELAY_MS = 600;

  async sendText(userId: string, text: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.api.sendChatAction(Number(userId), 'typing').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, TelegramAdapter.TYPING_DELAY_MS));
    await this.bot.api.sendMessage(Number(userId), text, { parse_mode: 'Markdown' });
  }

  // Telegram's native request_contact reply keyboard — a single tap shares the tapping
  // user's own verified phone number without leaving the chat. This is an identity
  // capability, not a conversational menu (AGENTS.md rule 10 is about avoiding
  // multiple-choice branching for the conversation itself; this button only ever does
  // one thing, and Telegram — not this app — guarantees whose number it shares).
  async sendContactRequest(userId: string, text: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.api.sendChatAction(Number(userId), 'typing').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, TelegramAdapter.TYPING_DELAY_MS));
    const keyboard = new Keyboard().requestContact('📱 Compartir mi contacto').resized().oneTime();
    await this.bot.api.sendMessage(Number(userId), text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }

  // A lightweight, asset-free "animated success" touch (2026-07-24 feedback) — Telegram
  // message reactions render with a small built-in animation with no hosted GIF/sticker
  // needed, unlike sendAnimation/sendSticker. Purely cosmetic (same as the selfie step
  // it's used with) — never allowed to break the real message flow if it fails.
  async reactToMessage(userId: string, messageId: number, emoji: string, isBig?: boolean): Promise<void> {
    if (!this.bot) return;
    // grammy types `emoji` as a closed union of Telegram's allowed reaction emoji —
    // cast here so IChannelAdapter's interface can stay a plain string (channel-agnostic).
    // isBig maps to Telegram's is_big flag — a much larger animated burst, used for the
    // phone/contact-share confirmation (2026-07-24 feedback).
    //
    // Real live-test report (reported 3 times): the reaction reportedly never shows,
    // despite code review and passing tests finding no bug here. A silent .catch() made
    // this undebuggable — logging the real failure reason turns it into an actual log
    // line to diagnose from next time, instead of a guess.
    await this.bot.api.setMessageReaction(Number(userId), messageId, [{ type: 'emoji', emoji } as any], { is_big: isBig })
      .catch((err) => this.logger.warn(`reactToMessage failed: ${err}`));
  }

  // 2026-07-24 feedback: a real branded success-checkmark video for the
  // selfie-confirmed and payment-confirmed moments — heavier than a reaction, so this
  // is never allowed to break the real flow if it fails (same as reactToMessage above).
  async sendAnimation(userId: string, filePath: string): Promise<void> {
    if (!this.bot) return;
    // A missing/unreadable asset file emits an 'error' event on the stream itself —
    // with no listener attached that crashes the whole Node process (uncaught
    // exception), not just this cosmetic send. Swallowed here for the same reason the
    // .catch() below exists: this must never take down the real message flow.
    const stream = createReadStream(filePath);
    stream.on('error', () => undefined);
    await this.bot.api.sendAnimation(Number(userId), new InputFile(stream)).catch(() => undefined);
  }

  async sendDocument(userId: string, file: Buffer, filename: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.api.sendDocument(Number(userId), new InputFile(file, filename));
  }

  async setWebhook(url: string, secret: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.api.setWebhook(url, { secret_token: secret });
    this.logger.log(`Webhook set to ${url}`);
  }

  webhookCallback(): (req: any, res: any, next?: any) => any {
    return this.bot ? webhookCallback(this.bot, 'express') : (_req: any, _res: any) => {};
  }
}