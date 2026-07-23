import { Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { TelegramWebhookGuard } from '../../common/guards/telegram-webhook.guard';
import { TelegramAdapter } from './telegram-adapter.service';

@Controller('webhook')
export class TelegramWebhookController {
  constructor(private readonly telegram: TelegramAdapter) {}

  @Post('telegram')
  @UseGuards(TelegramWebhookGuard)
  async handle(@Req() req: Request, @Res() res: Response) {
    const handler = this.telegram.webhookCallback();
    handler(req, res);
  }
}