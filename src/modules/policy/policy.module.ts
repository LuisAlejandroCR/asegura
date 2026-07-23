// policy.module.ts: policy issuance and PDF generation
import { Module } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { PdfService } from './pdf.service';

@Module({
  providers: [PolicyService, PdfService],
  exports: [PolicyService],
})
export class PolicyModule {}
