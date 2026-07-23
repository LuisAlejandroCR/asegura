import { Module } from '@nestjs/common';
import { TelegramAdapter } from './telegram-adapter.service';
import { TelegramWebhookController } from './telegram-webhook.controller';

@Module({
  controllers: [TelegramWebhookController],
  providers: [TelegramAdapter],
  exports: [TelegramAdapter],
})
export class ChannelModule {}