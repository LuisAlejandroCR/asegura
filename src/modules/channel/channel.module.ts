// channel.module.ts: wires the Telegram and WhatsApp (Twilio) adapters, Telegram's webhook
// controller, the download endpoint Twilio's media API needs, the registry that resolves a
// conversation to its adapter, and the inactivity ReminderService.

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
  // ConversationModule: ReminderService's auto-close reads and saves conversation state
  // from its own timer, not just sends a text.
  imports: [ConversationModule],
  controllers: [TelegramWebhookController, DownloadsController],
  providers: [TelegramAdapter, TwilioWhatsAppAdapter, DocumentCacheService, ChannelRegistry, ReminderService],
  exports: [TelegramAdapter, TwilioWhatsAppAdapter, ChannelRegistry, ReminderService, DocumentCacheService],
})
export class ChannelModule {}
