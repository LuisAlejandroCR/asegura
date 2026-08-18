// voice.controller.ts: the endpoint AseguraWeb's browser client calls to get a LiveKit room
// + token before connecting. Unauthenticated, matching the product's no-login promise: a
// leaked token grants one throwaway room for TOKEN_TTL_SECONDS.
import { Body, Controller, Post, ServiceUnavailableException } from '@nestjs/common';
import { LiveKitTokenService, VoiceSession } from './livekit-token.service';
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
