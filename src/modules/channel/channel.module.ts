// channel.module.ts: wires the Telegram adapter, its webhook controller and the
// inactivity ReminderService.

import { Module } from '@nestjs/common';
import { TelegramAdapter } from './telegram-adapter.service';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { ReminderService } from './reminder.service';
import { ConversationModule } from '../agent/conversation.module';

@Module({
  // ConversationModule: ReminderService's auto-close (2026-07-25) needs to read/save
  // conversation state directly from its own timer, not just send a text. Same
  // ChannelModule+ConversationModule combination PaymentsModule already uses — no cycle,
  // ConversationModule only imports DatabaseModule.
  imports: [ConversationModule],
  controllers: [TelegramWebhookController],
  providers: [TelegramAdapter, ReminderService],
  exports: [TelegramAdapter, ReminderService],
})
export class ChannelModule {}
