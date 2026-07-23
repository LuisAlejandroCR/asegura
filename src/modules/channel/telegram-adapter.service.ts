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

  normalize(raw: unknown): NormalizedMessage {
    const ctx = raw as Context;
    const msg = ctx.message ?? ctx.editedMessage;
    return {
      channelId: String(msg?.chat.id ?? ctx.chat?.id),
      channel: 'telegram',
      userId: String(msg?.from?.id ?? ctx.from?.id),
      text: msg?.text ?? '',
      timestamp: msg?.date ? new Date(msg.date * 1000) : new Date(),
      metadata: { updateId: ctx.update.update_id },
    };
  }

  async sendText(userId: string, text: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.api.sendMessage(Number(userId), text);
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