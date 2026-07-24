import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context, InputFile, webhookCallback } from 'grammy';
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

    if (msg?.photo || msg?.document || msg?.sticker || msg?.video || msg?.video_note) {
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

  async sendText(userId: string, text: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.api.sendMessage(Number(userId), text, { parse_mode: 'Markdown' });
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