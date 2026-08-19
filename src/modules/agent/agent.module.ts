// agent.module.ts: wires AgentService to the channel, NLP, quoting, policy and payments
// modules it orchestrates.

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
import { ToolRouterService } from './tool-router.service';
import { QuotingService } from '../quoting/quoting.service';
import { ProductCatalog } from '../quoting/product-catalog.service';
import { AffiliateLookupService } from '../quoting/affiliate-lookup.service';
import { PolicyService } from '../policy/policy.service';
import { WompiService } from '../payments/wompi.service';

@Module({
  imports: [ChannelModule, NlpModule, DatabaseModule, QuotingModule, PolicyModule, PaymentsModule, ConversationModule],
  // TwilioWebhookController and WebSessionController live here, not in ChannelModule: both
  // need AgentService directly, and ChannelModule can't import AgentModule back (cycle).
  controllers: [TwilioWebhookController, WebSessionController, WebLinkController],
  providers: [
    AgentService,
    WebSessionTokenService,
    WebLinkCodeService,
    // Deps are assembled here rather than injected wholesale: the router's contract is a
    // plain object so the voice worker, which has no DI, can build the same one.
    {
      provide: ToolRouterService,
      inject: [QuotingService, AffiliateLookupService, PolicyService, WompiService, 'IProductRepository'],
      useFactory: (
        quoting: QuotingService,
        affiliates: AffiliateLookupService,
        policies: PolicyService,
        payments: WompiService,
        catalog: ProductCatalog,
      ) => new ToolRouterService({ quoting, affiliates, policies, payments, catalog }),
    },
  ],
  exports: [AgentService],
})
export class AgentModule {}
