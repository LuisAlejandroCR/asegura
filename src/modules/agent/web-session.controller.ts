// web-session.controller.ts: the HTTP surface AseguraWeb (texto.html/voz.html) calls. The
// signed token is the only credential — it grants access to the one conversation it was
// minted for, for its TTL. The global per-IP limiter is the only other gate.
import { Body, Controller, Get, Param, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentService, WebReply } from './agent.service';
import { ConversationService } from './conversation.service';
import { WebSessionTokenService } from './web-session-token.service';
import { TelegramAdapter } from '../channel/telegram-adapter.service';
import { progressFor } from './conversation-state.machine';
import { ConversationContext, ConversationState } from './types';

interface WebSessionSnapshot {
  state: string;
  progress: { step: number; totalSteps: number; label: string };
  transcript: Array<{ role: 'user' | 'agent'; text: string }>;
  channel: string;
  // La llamada de voz cierra la venta fuera de esta página: sin estos dos campos, el link que
  // el agente dice haber dejado no existe en ninguna pantalla.
  checkoutUrl?: string;
  cotizacion?: ConversationContext['quoteSnapshot'];
  // WhatsApp only: its in-app browser escalates to the system browser, so after checkout
  // the page needs an explicit way back. Telegram's in-app browser IS the chat.
  returnUrl?: string;
  // Where the chat lives, for the "Terminar" button. Telegram's in-app browser exposes no way
  // to close itself, but it does hand a t.me link back to the app.
  chatUrl?: string;
  // El webhook guarda DISCOVERY tras cobrar para que el chat siga con el cross-sell, así que el
  // estado de la fila no distingue una compra pagada de una que empieza.
  compraConfirmada: boolean;
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
    private readonly telegram: TelegramAdapter,
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
      progress: progressFor(conv.state as any, conv.context),
      transcript: conv.context.lastMessages ?? [],
      channel: conv.channel,
      checkoutUrl: conv.context.checkoutUrl,
      cotizacion: conv.context.quoteSnapshot,
      returnUrl: this.buildReturnUrl(conv.channel),
      chatUrl: this.buildChatUrl(conv.channel),
      // `hasCompletedPurchase` responde "¿compró alguna vez?" y no se borra nunca por diseño
      // —es lo que distingue abandonar de haber comprado—, así que a un cliente que vuelve le
      // pintaba "¡Ya quedaste asegurado!" en cuanto aparecía un link de pago NUEVO, sin haberlo
      // pagado. Un `checkoutUrl` vigente es justamente la prueba de que falta pagar; el webhook
      // lo suelta al confirmar y lo limpia al rechazar. POLICY_ISSUED cubre la ventana entre el
      // pago y el cross-sell, donde el link todavía está puesto.
      compraConfirmada:
        conv.state === ConversationState.POLICY_ISSUED ||
        (conv.context.hasCompletedPurchase === true && !conv.context.checkoutUrl),
    };
  }

  private buildChatUrl(channel: string): string | undefined {
    if (channel === 'whatsapp') return this.buildWhatsAppUrl();
    const username = this.telegram.botUsername;
    return username ? `https://t.me/${username}` : undefined;
  }

  private buildReturnUrl(channel: string): string | undefined {
    if (channel !== 'whatsapp') return undefined;
    return this.buildWhatsAppUrl();
  }

  // The dialable number, not WHATSAPP_PHONE_NUMBER_ID — that one is a Graph API handle and
  // a wa.me link built from it opens a chat with nobody.
  private buildWhatsAppUrl(): string | undefined {
    const waNumber = this.config.get<string>('WHATSAPP_DISPLAY_NUMBER');
    if (!waNumber) return undefined;
    const digitsOnly = waNumber.replace(/\D/g, '');
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
