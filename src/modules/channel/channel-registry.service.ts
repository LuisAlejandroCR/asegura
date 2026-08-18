// channel-registry.service.ts: resolves a channel name to the adapter that owns it, so
// replies always go back out the channel the message came in on.
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
