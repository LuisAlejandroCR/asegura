import { Module } from '@nestjs/common';
import { ChannelModule } from '../channel/channel.module';
import { NlpModule } from '../nlp/nlp.module';
import { AgentService } from './agent.service';

@Module({
  imports: [ChannelModule, NlpModule],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}