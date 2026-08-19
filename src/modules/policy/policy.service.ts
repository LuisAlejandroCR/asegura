// policy.service.ts: creates policy records; the final PDF is only generated after
// payment is confirmed (see generateFinalPdf, called from wompi-webhook.controller.ts)
import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../database/supabase.service';
import { PdfService } from './pdf.service';
import { ProductCatalog } from '../quoting/product-catalog.service';
import { IProductRepository } from '../quoting/types';
import { computeTotalPremium, isPricedPerPet } from '../quoting/pricing';
import { ConversationContext } from '../agent/types';
import { classifyPetsBySpecies } from '../agent/breed-matcher';
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
    // Default keeps the spec's direct `new PolicyService(...)` working; DI injects the singleton.
    @Inject('IProductRepository')
    private readonly catalog: IProductRepository = new ProductCatalog(),
  ) {}

  async issue(conversationId: string, context: ConversationContext): Promise<IssuedPolicy> {
    const product = this.catalog.getProduct(context.quoteProductId ?? '');
    const monthlyPremium = product ? computeTotalPremium(product, context.petCount) : 0;

    // A mixed household issues one policy per species, but the full context.pets array used to
    // be stored on every one, so both PDFs listed all 3 pets. Species-restricted products get
    // only their own pets; a generic product keeps them all.
    let petsForPolicy = context.pets ?? null;
    if (product && (product.eligibility.pet === 'gato' || product.eligibility.pet === 'perro') && context.pets?.length) {
      const species = classifyPetsBySpecies(context.pets, context.petSpeciesCounts);
      petsForPolicy = context.pets.filter((_, i) => species[i] === product.eligibility.pet);
    }

    const { data, error } = await this.supabase.db
      .from('policies')
      .insert({
        conversation_id: conversationId,
        product_id: context.quoteProductId ?? 'unknown',
        cedula: context.cedula!,
        document_type: context.documentType ?? null,
        nombre: context.nombre!,
        email: context.email ?? null,
        monthly_premium: monthlyPremium,
        // petCount can arrive from the affiliate row on someone who owns pets and is buying
        // something else entirely, so it is stored only when the premium was actually per pet.
        pet_count: product && isPricedPerPet(product) ? context.petCount ?? null : null,
        pets: petsForPolicy,
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

  // Matched by payment_link_id, not by reference (Wompi generates its own). Returns an array
  // because a multi-product purchase shares one payment link across several policies.
  async findAllByWompiLinkId(wompiLinkId: string): Promise<Policy[]> {
    const { data, error } = await this.supabase.db
      .from('policies')
      .select('*')
      .eq('wompi_link_id', wompiLinkId);

    if (error) {
      this.logger.error(`findAllByWompiLinkId error: ${error.message}`);
      return [];
    }
    return (data ?? []) as Policy[];
  }

  // Generates the policy PDF after payment is confirmed — the only PDF the user receives.
  async generateFinalPdf(policy: Policy): Promise<Buffer | null> {
    const product = this.catalog.getProduct(policy.product_id);
    if (!product) return null;

    try {
      return await this.pdf.generate({
        policyId: policy.id,
        productName: product.name,
        insurer: product.insurer,
        coverages: product.coverages,
        nombre: policy.nombre,
        cedula: policy.cedula,
        documentType: policy.document_type ?? undefined,
        email: policy.email ?? undefined,
        monthlyPremium: policy.monthly_premium,
        issuedAt: new Date(policy.created_at),
        // Guarded here too, so a policy stored before this rule still prints correctly.
        petCount: isPricedPerPet(product) ? policy.pet_count : null,
        pets: policy.pets ?? undefined,
      });
    } catch (err) {
      this.logger.error(`Final PDF generation failed: ${String(err)}`);
      return null;
    }
  }
}
