// payments.module.ts: Wompi payment links and webhook
import { Module } from '@nestjs/common';
import { WompiService } from './wompi.service';
import { WompiWebhookController } from './wompi-webhook.controller';
import { PolicyModule } from '../policy/policy.module';
import { BlockchainModule } from '../blockchain/blockchain.module';

@Module({
  imports: [PolicyModule, BlockchainModule],
  controllers: [WompiWebhookController],
  providers: [WompiService],
  exports: [WompiService],
})
export class PaymentsModule {}
