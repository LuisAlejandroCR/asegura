// voice.module.ts: AseguraWeb's LiveKit token endpoint. Ties a session's LiveKit identity
// to a real conversationId when a valid webToken is presented (plan-17 §11/§12
// groundwork) — WebSessionTokenService is provided directly here rather than imported
// from AgentModule (no shared state to it, just ConfigService — avoids a cross-module
// dependency for a single stateless HMAC utility). Full conversation state over voice
// (DISCOVERY/QUOTING/etc.) is still NOT wired — see livekit-token.service.ts's header.
import { Module } from '@nestjs/common';
import { LiveKitTokenService } from './livekit-token.service';
import { VoiceController } from './voice.controller';
import { WebSessionTokenService } from '../agent/web-session-token.service';

@Module({
  controllers: [VoiceController],
  providers: [LiveKitTokenService, WebSessionTokenService],
  exports: [LiveKitTokenService],
})
export class VoiceModule {}
