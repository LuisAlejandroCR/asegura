// policy.module.ts: policy issuance and PDF generation
import { Module } from '@nestjs/common';
import { QuotingModule } from '../quoting/quoting.module';
import { PolicyService } from './policy.service';
import { PdfService } from './pdf.service';

@Module({
  imports: [QuotingModule],
  providers: [PolicyService, PdfService],
  exports: [PolicyService],
})
export class PolicyModule {}
