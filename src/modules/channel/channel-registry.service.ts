// channel-registry.service.ts: resolves a NormalizedMessage['channel'] string to the
// IChannelAdapter that owns it. AgentService and wompi-webhook.controller.ts both need
// this — a message/payment can arrive on either channel, and each conversation's replies
// must go back out the same one it came in on, never hardcoded to Telegram.
import { Injectable } from '@nestjs/common';
import { IChannelAdapter } from './types';
import { TelegramAdapter } from './telegram-adapter.service';
import { TwilioWhatsAppAdapter } from './twilio-whatsapp-adapter.service';

@Injectable()
export class ChannelRegistry {
  constructor(
    private readonly telegram: TelegramAdapter,
    private readonly whatsapp: TwilioWhatsAppAdapter,
  ) {}

  get(channel: 'telegram' | 'whatsapp'): IChannelAdapter {
    return channel === 'whatsapp' ? this.whatsapp : this.telegram;
  }
}
