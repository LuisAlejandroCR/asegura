// voice.module.ts: AseguraWeb's LiveKit token endpoint. WebSessionTokenService is provided
// here rather than imported from AgentModule — it is a stateless HMAC utility, so there is
// no shared state to justify the cross-module dependency.
import { Module } from '@nestjs/common';
import { LiveKitTokenService } from './livekit-token.service';
import { VoiceController } from './voice.controller';
import { WebSessionTokenService } from '../agent/web-session-token.service';
import { ChannelModule } from '../channel/channel.module';

@Module({
  imports: [ChannelModule],
  controllers: [VoiceController],
  providers: [LiveKitTokenService, WebSessionTokenService],
  exports: [LiveKitTokenService, WebSessionTokenService],
})
export class VoiceModule {}
