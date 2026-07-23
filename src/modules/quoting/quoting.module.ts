import { Module } from '@nestjs/common';
import { QuotingService } from './quoting.service';

@Module({
  providers: [QuotingService],
  exports: [QuotingService],
})
export class QuotingModule {}