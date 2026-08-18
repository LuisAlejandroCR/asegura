// web-session.controller.ts: the HTTP surface AseguraWeb (texto.html/voz.html) calls. The
// signed token is the only credential — it grants access to the one conversation it was
// minted for, for its TTL. Nothing rate-limits this endpoint yet.
import { Body, Controller, Get, Param, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentService, WebReply } from './agent.service';
import { ConversationService } from './conversation.service';
import { WebSessionTokenService } from './web-session-token.service';
import { progressFor } from './conversation-state.machine';

interface WebSessionSnapshot {
  state: string;
  progress: { step: number; totalSteps: number; label: string };
  transcript: Array<{ role: 'user' | 'agent'; text: string }>;
  channel: string;
  // WhatsApp only: its in-app browser escalates to the system browser, so after checkout
  // the page needs an explicit way back. Telegram's in-app browser IS the chat.
  returnUrl?: string;
}

interface PostMessageBody {
  text?: string;
  photo?: { width: number; height: number };
}

@Controller('web-session')
export class WebSessionController {
  constructor(
    private readonly tokens: WebSessionTokenService,
    private readonly conversations: ConversationService,
    private readonly agent: AgentService,
    private readonly config: ConfigService,
  ) {}

  // Read-only: restores a refreshed page without advancing the conversation.
  @Get(':token')
  async getSession(@Param('token') token: string): Promise<WebSessionSnapshot> {
    const payload = this.tokens.verify(token);
    if (!payload) {
      throw new UnauthorizedException('Tu sesión expiró, vuelve al chat.');
    }

    const conv = await this.conversations.findById(payload.conversationId);
    if (!conv) {
      throw new UnauthorizedException('Tu sesión expiró, vuelve al chat.');
    }

    return {
      state: conv.state,
      progress: progressFor(conv.state as any),
      transcript: conv.context.lastMessages ?? [],
      channel: conv.channel,
      returnUrl: this.buildReturnUrl(conv.channel),
    };
  }

  private buildReturnUrl(channel: string): string | undefined {
    if (channel !== 'whatsapp') return undefined;
    const waNumber = this.config.get<string>('TWILIO_WHATSAPP_NUMBER');
    if (!waNumber) return undefined;
    const digitsOnly = waNumber.replace(/^whatsapp:/, '').replace(/\D/g, '');
    if (!digitsOnly) return undefined;
    return `https://wa.me/${digitsOnly}`;
  }

  @Post(':token/message')
  async postMessage(@Param('token') token: string, @Body() body: PostMessageBody): Promise<WebReply> {
    const payload = this.tokens.verify(token);
    if (!payload) {
      throw new UnauthorizedException('Tu sesión expiró, vuelve al chat.');
    }

    return this.agent.handleWebMessage(payload.conversationId, body);
  }
}
