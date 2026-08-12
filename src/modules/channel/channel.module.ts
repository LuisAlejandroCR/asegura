// channel.module.ts: wires the Telegram and WhatsApp (Twilio) adapters, Telegram's own
// webhook controller, the download endpoint Twilio's media API needs, the registry that
// resolves a conversation's channel to the right adapter, and the inactivity
// ReminderService.
//
// TwilioWebhookController deliberately lives in AgentModule instead of here, even though
// its code is in this same directory — it needs AgentService directly (Twilio has no
// SDK-level event bus like grammy's Bot, which is how TelegramWebhookController avoids
// the same problem), and AgentModule already imports ChannelModule. Registering it here
// too would make ChannelModule depend back on AgentModule — circular.

import { Module } from '@nestjs/common';
import { TelegramAdapter } from './telegram-adapter.service';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { TwilioWhatsAppAdapter } from './twilio-whatsapp-adapter.service';
import { DownloadsController } from './downloads.controller';
import { DocumentCacheService } from './document-cache.service';
import { ChannelRegistry } from './channel-registry.service';
import { ReminderService } from './reminder.service';
import { ConversationModule } from '../agent/conversation.module';

@Module({
  // ConversationModule: ReminderService's auto-close (2026-07-25) needs to read/save
  // conversation state directly from its own timer, not just send a text. Same
  // ChannelModule+ConversationModule combination PaymentsModule already uses — no cycle,
  // ConversationModule only imports DatabaseModule.
  imports: [ConversationModule],
  controllers: [TelegramWebhookController, DownloadsController],
  providers: [TelegramAdapter, TwilioWhatsAppAdapter, DocumentCacheService, ChannelRegistry, ReminderService],
  exports: [TelegramAdapter, TwilioWhatsAppAdapter, ChannelRegistry, ReminderService, DocumentCacheService],
})
export class ChannelModule {}
