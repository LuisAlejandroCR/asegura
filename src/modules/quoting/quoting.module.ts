import { Module } from '@nestjs/common';
import { QuotingService } from './quoting.service';
import { AffiliateLookupService } from './affiliate-lookup.service';

@Module({
  providers: [QuotingService, AffiliateLookupService],
  exports: [QuotingService, AffiliateLookupService],
})
export class QuotingModule {}