// voice.module.ts: AseguraWeb's LiveKit token endpoint. Standalone — no dependency on
// AgentModule/ChannelModule, since it doesn't (yet) link a session to an existing
// conversation. See livekit-token.service.ts's header for what's deliberately not built.
import { Module } from '@nestjs/common';
import { LiveKitTokenService } from './livekit-token.service';
import { VoiceController } from './voice.controller';

@Module({
  controllers: [VoiceController],
  providers: [LiveKitTokenService],
  exports: [LiveKitTokenService],
})
export class VoiceModule {}
