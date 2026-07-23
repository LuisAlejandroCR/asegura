// conversation.module.ts: separated from AgentModule so PaymentsModule (imported by
// AgentModule) can also use ConversationService without a circular module dependency.
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { ConversationService } from './conversation.service';

@Module({
  imports: [DatabaseModule],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
