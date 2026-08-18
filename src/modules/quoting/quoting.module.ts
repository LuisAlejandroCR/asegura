// quoting.module.ts: the scoring engine, the YAML product catalog and the affiliate
// lookup that feeds them.
import { Module } from '@nestjs/common';
import { QuotingService } from './quoting.service';
import { AffiliateLookupService } from './affiliate-lookup.service';
import { ProductCatalog } from './product-catalog.service';

@Module({
  providers: [
    QuotingService,
    AffiliateLookupService,
    { provide: 'IProductRepository', useClass: ProductCatalog },
  ],
  exports: [QuotingService, AffiliateLookupService, 'IProductRepository'],
})
export class QuotingModule {}
