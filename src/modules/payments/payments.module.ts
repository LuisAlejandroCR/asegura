import { Module } from '@nestjs/common';
import { WompiService } from './wompi.service';
import { WompiWebhookController } from './wompi-webhook.controller';

@Module({
  controllers: [WompiWebhookController],
  providers: [WompiService],
  exports: [WompiService],
})
export class PaymentsModule {}