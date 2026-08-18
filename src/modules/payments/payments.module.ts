// payments.module.ts: Wompi payment links and the webhook that confirms them, plus the
// policy and conversation modules the confirmation path needs.
import { Module } from '@nestjs/common';
import { WompiService } from './wompi.service';
import { WompiWebhookController } from './wompi-webhook.controller';
import { PolicyModule } from '../policy/policy.module';
import { ConversationModule } from '../agent/conversation.module';
import { ChannelModule } from '../channel/channel.module';

@Module({
  imports: [PolicyModule, ConversationModule, ChannelModule],
  controllers: [WompiWebhookController],
  providers: [WompiService],
  exports: [WompiService],
})
export class PaymentsModule {}
