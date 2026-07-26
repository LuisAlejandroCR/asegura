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
  exports: [QuotingService, AffiliateLookupService],
})
export class QuotingModule {}
