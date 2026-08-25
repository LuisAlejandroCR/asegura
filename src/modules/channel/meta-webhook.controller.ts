// meta-webhook.controller.ts: the two halves of a Meta WhatsApp Cloud API webhook. GET is
// the one-time subscription handshake (echo hub.challenge when hub.verify_token matches);
// POST carries every inbound message. Contract read 2026-08-25 from developers.facebook.com.
import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  HttpCode,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { Logger } from '@nestjs/common';
import { MetaWebhookGuard } from '../../common/guards/meta-webhook.guard';
import { AgentService } from '../agent/agent.service';

// Meta retries a delivery it did not see acknowledged, so the same wamid can arrive more
// than once. Bounded so a long-running instance cannot grow this without limit; ids are
// only ever needed for the minutes a retry window lasts.
const SEEN_MAX = 2000;

@SkipThrottle()
@Controller('webhook')
export class MetaWebhookController {
  private readonly logger = new Logger(MetaWebhookController.name);
  private readonly seen = new Set<string>();

  constructor(
    private readonly agent: AgentService,
    private readonly config: ConfigService,
  ) {}

  // Meta calls this once when the callback URL is saved in the App Dashboard, and again on
  // every URL change. It carries no signature, so the shared verify token is the check.
  @Get('whatsapp')
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    const expected = this.config.get<string>('WHATSAPP_VERIFY_TOKEN');
    if (!expected || mode !== 'subscribe' || token !== expected) {
      throw new ForbiddenException('Invalid webhook verification request');
    }
    this.logger.log('Meta webhook verification handshake accepted');
    return challenge ?? '';
  }

  @Post('whatsapp')
  @UseGuards(MetaWebhookGuard)
  @HttpCode(200)
  handle(@Body() body: unknown): void {
    const messageId = extractMessageId(body);

    if (messageId) {
      if (this.seen.has(messageId)) {
        this.logger.log(`Duplicate delivery ${messageId} ignored`);
        return;
      }
      if (this.seen.size >= SEEN_MAX) {
        this.seen.clear();
      }
      this.seen.add(messageId);
    }

    // Answered before the work starts, on purpose: a turn costs an LLM call plus Wompi, and
    // Meta retries anything it has not seen acknowledged — which is how one message becomes
    // two payment links. The catch is not optional: an unhandled rejection here took the
    // whole process down once already on the Telegram side.
    void this.agent
      .handleMessage(body, 'whatsapp')
      .catch((err) => this.logger.error(`WhatsApp turn failed: ${err}`));
  }
}

// Reaches for the message id only; a status/delivery payload has none and is left to
// normalize(), which returns an empty message the agent drops.
function extractMessageId(body: unknown): string | undefined {
  const value = (body as { entry?: { changes?: { value?: { messages?: { id?: string }[] } }[] }[] })
    ?.entry?.[0]?.changes?.[0]?.value;
  return value?.messages?.[0]?.id;
}
