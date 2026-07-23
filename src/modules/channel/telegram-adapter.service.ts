import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context, InputFile, webhookCallback } from 'grammy';
import { IChannelAdapter, NormalizedMessage } from './types';

@Injectable()
export class TelegramAdapter implements IChannelAdapter {
  private readonly logger = new Logger(TelegramAdapter.name);
  private readonly bot: Bot;

  constructor(private readonly config: ConfigService) {
    const token = config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    this.bot = new Bot(token);
  }

  get instance(): Bot {
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
    await this.bot.api.sendMessage(Number(userId), text);
  }

  async sendDocument(userId: string, file: Buffer, filename: string): Promise<void> {
    await this.bot.api.sendDocument(Number(userId), new InputFile(file, filename));
  }

  async setWebhook(url: string, secret: string): Promise<void> {
    await this.bot.api.setWebhook(url, { secret_token: secret });
    this.logger.log(`Webhook set to ${url}`);
  }

  webhookCallback(): (req: any, res: any, next?: any) => any {
    return webhookCallback(this.bot, 'express');
  }
}