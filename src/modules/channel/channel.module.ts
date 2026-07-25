import { Module } from '@nestjs/common';
import { TelegramAdapter } from './telegram-adapter.service';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { ReminderService } from './reminder.service';

@Module({
  controllers: [TelegramWebhookController],
  providers: [TelegramAdapter, ReminderService],
  exports: [TelegramAdapter, ReminderService],
})
export class ChannelModule {}