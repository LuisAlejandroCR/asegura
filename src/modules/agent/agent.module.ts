import { Module } from '@nestjs/common';
import { ChannelModule } from '../channel/channel.module';
import { NlpModule } from '../nlp/nlp.module';
import { DatabaseModule } from '../../database/database.module';
import { QuotingModule } from '../quoting/quoting.module';
import { PolicyModule } from '../policy/policy.module';
import { AgentService } from './agent.service';
import { ConversationService } from './conversation.service';

@Module({
  imports: [ChannelModule, NlpModule, DatabaseModule, QuotingModule, PolicyModule],
  providers: [AgentService, ConversationService],
  exports: [AgentService],
})
export class AgentModule {}