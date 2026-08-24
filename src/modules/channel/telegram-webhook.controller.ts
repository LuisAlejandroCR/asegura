// telegram-webhook.controller.ts: the POST /webhook/telegram endpoint, guarded by the
// shared-secret header and handed straight to grammy's own webhook callback.
import { Controller, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { TelegramWebhookGuard } from '../../common/guards/telegram-webhook.guard';
import { TelegramAdapter } from './telegram-adapter.service';

// The shared secret is the gate; a throttled update is a message nobody ever answers.
@SkipThrottle()
@Controller('webhook')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);

  constructor(private readonly telegram: TelegramAdapter) {}

  @Post('telegram')
  @UseGuards(TelegramWebhookGuard)
  async handle(@Req() req: Request, @Res() res: Response) {
    const handler = this.telegram.webhookCallback();
    try {
      await handler(req, res);
    } catch (error) {
      // Nadie esperaba esta promesa, así que su rechazo era una unhandled rejection y Node se
      // llevaba la API entera por delante — un mensaje lento tumbaba el proceso.
      this.logger.error(`webhook de Telegram: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.sendStatus(200);
    }
  }
}
