// policy.service.ts: creates policy records; the final PDF is only generated after
// payment is confirmed (see generateFinalPdf, called from wompi-webhook.controller.ts)
import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../database/supabase.service';
import { PdfService } from './pdf.service';
import { PRODUCTS } from '../quoting/products.data';
import { computeTotalPremium } from '../quoting/pricing';
import { ConversationContext } from '../agent/types';
import { Policy } from './types';

export interface IssuedPolicy {
  policyId: string;
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
    const monthlyPremium = product ? computeTotalPremium(product, context.petCount) : 0;

    const { data, error } = await this.supabase.db
      .from('policies')
      .insert({
        conversation_id: conversationId,
        product_id: context.quoteProductId ?? 'unknown',
        cedula: context.cedula!,
        nombre: context.nombre!,
        email: context.email ?? null,
        monthly_premium: monthlyPremium,
        pet_count: context.petCount ?? null,
        pets: context.pets ?? null,
        status: 'pending_payment',
      })
      .select('id')
      .single();

    if (error) {
      this.logger.error(`Failed to create policy: ${error.message}`);
      return { policyId: 'error' };
    }

    const policyId: string = (data as { id: string }).id;
    return { policyId };
  }

  async updateStatus(policyId: string, status: string, extras?: Record<string, unknown>): Promise<void> {
    const { error } = await this.supabase.db
      .from('policies')
      .update({ status, updated_at: new Date().toISOString(), ...extras })
      .eq('id', policyId);

    if (error) this.logger.error(`updateStatus error: ${error.message}`);
  }

  async findById(policyId: string): Promise<Policy | null> {
    const { data, error } = await this.supabase.db
      .from('policies')
      .select('*')
      .eq('id', policyId)
      .maybeSingle();

    if (error) {
      this.logger.error(`findById error: ${error.message}`);
      return null;
    }
    return data as Policy | null;
  }

  // Wompi's Payment Links API has no "reference" field — the webhook's transaction
  // carries payment_link_id instead, which we match back to the policy here.
  async findByWompiLinkId(wompiLinkId: string): Promise<Policy | null> {
    const { data, error } = await this.supabase.db
      .from('policies')
      .select('*')
      .eq('wompi_link_id', wompiLinkId)
      .maybeSingle();

    if (error) {
      this.logger.error(`findByWompiLinkId error: ${error.message}`);
      return null;
    }
    return data as Policy | null;
  }

  // Regenerates the policy PDF once the real Celoscan tx is known (post-payment),
  // replacing the referenceURI fallback the initial PDF used before payment completed.
  async generateFinalPdf(policy: Policy, celoscanUrl: string): Promise<Buffer | null> {
    const product = PRODUCTS.find((p) => p.id === policy.product_id);
    if (!product) return null;

    try {
      return await this.pdf.generate({
        policyId: policy.id,
        productName: product.name,
        insurer: product.insurer,
        coverages: product.coverages,
        nombre: policy.nombre,
        cedula: policy.cedula,
        email: policy.email ?? undefined,
        monthlyPremium: product.basePremium,
        issuedAt: new Date(policy.created_at),
        celoscanUrl,
        petCount: policy.pet_count,
        pets: policy.pets ?? undefined,
      });
    } catch (err) {
      this.logger.error(`Final PDF generation failed: ${String(err)}`);
      return null;
    }
  }
}
