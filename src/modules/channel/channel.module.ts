// channel.module.ts: wires the Telegram and WhatsApp (Meta Cloud API) adapters, Telegram's
// webhook controller, the download endpoint AgentService's web links need, the registry that
// resolves a conversation to its adapter, and the inactivity ReminderService.

import { Module } from '@nestjs/common';
import { TelegramAdapter } from './telegram-adapter.service';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { MetaWhatsAppAdapter } from './meta-whatsapp-adapter.service';
import { DownloadsController } from './downloads.controller';
import { DocumentCacheService } from './document-cache.service';
import { ChannelRegistry } from './channel-registry.service';
import { ReminderService } from './reminder.service';
import { ConversationModule } from '../agent/conversation.module';
import { LeadsModule } from '../leads/leads.module';

@Module({
  // ConversationModule: ReminderService's auto-close reads and saves conversation state
  // from its own timer, not just sends a text.
  // LeadsModule: al cerrar una conversación sin venta, ReminderService deja la fila que
  // convierte un abandono en una llamada de vuelta.
  imports: [ConversationModule, LeadsModule],
  controllers: [TelegramWebhookController, DownloadsController],
  providers: [TelegramAdapter, MetaWhatsAppAdapter, DocumentCacheService, ChannelRegistry, ReminderService],
  exports: [TelegramAdapter, MetaWhatsAppAdapter, ChannelRegistry, ReminderService, DocumentCacheService],
})
export class ChannelModule {}
