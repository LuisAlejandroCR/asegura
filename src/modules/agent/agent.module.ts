// agent.module.ts: wires AgentService to the channel, NLP, quoting, policy and
// payments modules it orchestrates.

import { Module } from '@nestjs/common';
import { ChannelModule } from '../channel/channel.module';
import { TwilioWebhookController } from '../channel/twilio-webhook.controller';
import { NlpModule } from '../nlp/nlp.module';
import { DatabaseModule } from '../../database/database.module';
import { QuotingModule } from '../quoting/quoting.module';
import { PolicyModule } from '../policy/policy.module';
import { PaymentsModule } from '../payments/payments.module';
import { ConversationModule } from './conversation.module';
import { AgentService } from './agent.service';
import { WebSessionController } from './web-session.controller';
import { WebSessionTokenService } from './web-session-token.service';
import { WebLinkController } from './web-link.controller';
import { WebLinkCodeService } from './web-link-code.service';

@Module({
  imports: [ChannelModule, NlpModule, DatabaseModule, QuotingModule, PolicyModule, PaymentsModule, ConversationModule],
  // TwilioWebhookController registered here, not in ChannelModule — see the comment on
  // ChannelModule for why (it needs AgentService directly; ChannelModule can't import
  // AgentModule back without a cycle). WebSessionController lives here for the same
  // reason (it needs AgentService.handleWebMessage directly).
  controllers: [TwilioWebhookController, WebSessionController, WebLinkController],
  providers: [AgentService, WebSessionTokenService, WebLinkCodeService],
  exports: [AgentService],
})
export class AgentModule {}
