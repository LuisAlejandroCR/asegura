// health.module.ts: the GET /health endpoint used by Railway's deploy healthcheck. It imports
// the optional integrations so it can report their real state rather than guess from env.
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { NlpModule } from '../modules/nlp/nlp.module';
import { ChannelModule } from '../modules/channel/channel.module';
import { PaymentsModule } from '../modules/payments/payments.module';
import { VoiceModule } from '../modules/voice/voice.module';

@Module({
  imports: [NlpModule, ChannelModule, PaymentsModule, VoiceModule],
  controllers: [HealthController],
})
export class HealthModule {}
