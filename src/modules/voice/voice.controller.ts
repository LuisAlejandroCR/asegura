// voice.controller.ts: the endpoint AseguraWeb's browser client calls to get a LiveKit room
// + token before connecting. Unauthenticated, matching the product's no-login promise: a
// leaked token grants one throwaway room for TOKEN_TTL_SECONDS.
import { Body, Controller, Post, ServiceUnavailableException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { LiveKitTokenService, VoiceSession } from './livekit-token.service';
import { ReminderService } from '../channel/reminder.service';
import { WebSessionTokenService } from '../agent/web-session-token.service';

interface CreateSessionBody {
  // Optional signed token from the chat link. Invalid or absent falls back to a random
  // identity, so voz.html still works standalone — it just isn't tied to a conversation.
  webToken?: string;
}

@Controller('voice')
export class VoiceController {
  constructor(
    private readonly liveKit: LiveKitTokenService,
    private readonly webSessionTokens: WebSessionTokenService,
    private readonly reminders: ReminderService,
  ) {}

  // Each call opens a LiveKit room and bills ElevenLabs and Groq; a real user needs one
  // per page load.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('session')
  async createSession(@Body() body: CreateSessionBody): Promise<VoiceSession> {
    const payload = body.webToken ? this.webSessionTokens.verify(body.webToken) : null;
    const session = payload
      ? await this.liveKit.createSession(payload.conversationId)
      : await this.liveKit.createSession();
    if (!session) {
      throw new ServiceUnavailableException('Voice is not configured (LIVEKIT_* missing)');
    }
    return session;
  }

  // "Terminar" en AseguraWeb solo colgaba la llamada: el chat seguía creyendo que la persona
  // estaba allá y solo se enteraba cuando vencía un temporizador. Sin token válido no hay
  // conversación que cerrar, y responder 200 igual evita que el navegador muestre un error
  // por algo que ya terminó.
  @Post('end')
  async endSession(@Body() body: CreateSessionBody): Promise<{ closed: boolean }> {
    const payload = body.webToken ? this.webSessionTokens.verify(body.webToken) : null;
    if (!payload) return { closed: false };

    await this.reminders.closeNow(
      payload.conversationId,
      'Cerramos la sesión de AseguraWeb. Si quieres seguir, escríbeme aquí y retomamos donde íbamos 😊',
    );
    return { closed: true };
  }
}
