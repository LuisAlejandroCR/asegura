// voice.controller.ts: the endpoint AseguraWeb's browser client calls to get a LiveKit
// room + token before connecting. No auth beyond rate limiting (ThrottlerModule, global)
// — matches the "no login" promise of the product; a leaked token only grants access to
// one throwaway room for 30 minutes (see TOKEN_TTL_SECONDS).
import { Controller, Post, ServiceUnavailableException } from '@nestjs/common';
import { LiveKitTokenService, VoiceSession } from './livekit-token.service';

@Controller('voice')
export class VoiceController {
  constructor(private readonly liveKit: LiveKitTokenService) {}

  @Post('session')
  async createSession(): Promise<VoiceSession> {
    const session = await this.liveKit.createSession();
    if (!session) {
      throw new ServiceUnavailableException('Voice is not configured (LIVEKIT_* missing)');
    }
    return session;
  }
}
