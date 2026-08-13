// voice.controller.ts: the endpoint AseguraWeb's browser client calls to get a LiveKit
// room + token before connecting. No auth beyond rate limiting (ThrottlerModule, global)
// — matches the "no login" promise of the product; a leaked token only grants access to
// one throwaway room for 30 minutes (see TOKEN_TTL_SECONDS).
import { Body, Controller, Post, ServiceUnavailableException } from '@nestjs/common';
import { LiveKitTokenService, VoiceSession } from './livekit-token.service';
import { WebSessionTokenService } from '../agent/web-session-token.service';

interface CreateSessionBody {
  // Plan-17 §11 — the link the chat sends after "hablar" carries this same signed token
  // texto.html uses. Optional and best-effort: an invalid/expired/missing token falls back
  // to today's random-identity session (voz.html still works standalone), it just isn't
  // tied to a real conversation. Full state (DISCOVERY/QUOTING/etc. over voice) is NOT
  // wired yet — the voice-agent worker is a separate Node process with no NestJS DI (see
  // plan-17 §10) — this only gives the LiveKit room a meaningful identity to grow into.
  webToken?: string;
}

@Controller('voice')
export class VoiceController {
  constructor(
    private readonly liveKit: LiveKitTokenService,
    private readonly webSessionTokens: WebSessionTokenService,
  ) {}

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
}
