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
      const host = this.config.get<string>('HOST', '');
      if (host) {
        const secret = this.config.getOrThrow<string>('TELEGRAM_WEBHOOK_SECRET');
        this.logger.log(`Telegram ready`); // webhook set in main.ts
      }
    }
  }

  get instance(): Bot | null {
    return this.bot;
  }

  async normalize(raw: unknown): Promise<NormalizedMessage> {
    const ctx = raw as Context;
    const msg = ctx.message ?? ctx.editedMessage;

    let text = msg?.text ?? '';

    if (!text && msg?.voice) {
      try {
        text = await this.transcribeVoice(msg.voice.file_id);
      } catch (err) {
        this.logger.error(`Voice transcription failed: ${err}`);
      }
    }

    return {
      channelId: String(msg?.chat.id ?? ctx.chat?.id),
      channel: 'telegram',
      userId: String(msg?.from?.id ?? ctx.from?.id),
      text,
      timestamp: msg?.date ? new Date(msg.date * 1000) : new Date(),
      metadata: { updateId: ctx.update.update_id },
    };
  }

  private async transcribeVoice(fileId: string): Promise<string> {
    if (!this.bot) return '';
    const llmKey = this.config.get<string>('LLM_API_KEY');
    if (!llmKey) return '';
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