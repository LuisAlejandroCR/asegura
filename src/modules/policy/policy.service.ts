// policy.service.ts: creates policy records and emits PDF
import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../database/supabase.service';
import { PdfService } from './pdf.service';
import { PRODUCTS } from '../quoting/products.data';
import { ConversationContext } from '../agent/types';

export interface IssuedPolicy {
  policyId: string;
  pdfBuffer: Buffer | null;
}

@Injectable()
export class PolicyService {
  private readonly logger = new Logger(PolicyService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly pdf: PdfService,
  ) {}

  async issue(conversationId: string, context: ConversationContext): Promise<IssuedPolicy> {
    const product = PRODUCTS.find((p) => p.id === context.quoteProductId);

    const { data, error } = await this.supabase.db
      .from('policies')
      .insert({
        conversation_id: conversationId,
        product_id: context.quoteProductId ?? 'unknown',
        cedula: context.cedula!,
        nombre: context.nombre!,
        email: context.email ?? null,
        monthly_premium: product?.basePremium ?? 0,
        status: 'pending_payment',
      })
      .select('id')
      .single();

    if (error) {
      this.logger.error(`Failed to create policy: ${error.message}`);
      return { policyId: 'error', pdfBuffer: null };
    }

    const policyId: string = (data as { id: string }).id;

    let pdfBuffer: Buffer | null = null;
    if (product) {
      try {
        pdfBuffer = await this.pdf.generate({
          policyId,
          productName: product.name,
          insurer: product.insurer,
          coverages: product.coverages,
          nombre: context.nombre!,
          cedula: context.cedula!,
          email: context.email,
          monthlyPremium: product.basePremium,
          issuedAt: new Date(),
        });
      } catch (err) {
        this.logger.error(`PDF generation failed: ${String(err)}`);
      }
    }

    return { policyId, pdfBuffer };
  }

  async updateStatus(policyId: string, status: string, extras?: Record<string, unknown>): Promise<void> {
    const { error } = await this.supabase.db
      .from('policies')
      .update({ status, updated_at: new Date().toISOString(), ...extras })
      .eq('id', policyId);

    if (error) this.logger.error(`updateStatus error: ${error.message}`);
  }
}
