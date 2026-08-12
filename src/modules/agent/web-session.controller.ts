// web-session.controller.ts: the HTTP surface AseguraWeb (texto.html/voz.html) calls.
// No auth beyond the signed token itself + the global ThrottlerModule (same trust model
// as voice.controller.ts) — a leaked token only grants access to the one conversation it
// was minted for, for its TTL window (web-session-token.service.ts).
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
  // Plan-17 §12 — only set for WhatsApp (with TWILIO_WHATSAPP_NUMBER configured): the mic
  // test (plan 17 §2) confirmed WhatsApp's in-app browser always escalates to the external
  // system browser, so once checkout completes, the browser is stranded outside the chat
  // and needs an explicit way back. Telegram's in-app browser IS the chat — no equivalent
  // needed, so this stays undefined there; texto.html/voz.html just show "close this tab".
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

  // Read-only — lets texto.html/voz.html restore a refreshed page without advancing the
  // conversation (never calls AgentService.handleWebMessage, which DOES advance it).
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
