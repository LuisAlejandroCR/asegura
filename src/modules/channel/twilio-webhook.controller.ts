// twilio-webhook.controller.ts: receives inbound WhatsApp messages. Twilio needs no
// SDK-specific handler — the parsed form body goes straight to AgentService and the reply
// is sent asynchronously over REST, so an empty 200 here is correct.
import { Controller, Post, Body, HttpCode, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { TwilioWebhookGuard } from '../../common/guards/twilio-webhook.guard';
import { AgentService } from '../agent/agent.service';

// The signature is the gate, and every inbound message shares Twilio's own IPs.
@SkipThrottle()
@Controller('webhook')
export class TwilioWebhookController {
  constructor(private readonly agent: AgentService) {}

  @Post('whatsapp')
  @UseGuards(TwilioWebhookGuard)
  @HttpCode(200)
  async handle(@Body() body: unknown): Promise<void> {
    await this.agent.handleMessage(body, 'whatsapp');
  }
}
