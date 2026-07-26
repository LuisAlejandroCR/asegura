// product-catalog.service.ts: This script is for loading, validating, and caching the
// insurance product catalog in memory at boot, behind IProductRepository (CLAUDE.md rule
// #6), so QuotingService's scoring engine no longer depends on products.data.ts directly.
//
// 2026-07-26 — sources from products.data.ts, NOT catalog/products/*.yaml: that YAML
// schema (id/name/company/public_price/requires_quote/category/ideal_for/customer_needs/
// questions_to_ask/why_recommend/not_recommended_when/url) has no eligibility/coverages/
// businessPriority/requiresUnderwriting — the exact fields evaluateProduct() scores on.
// Returning YAML-shaped products today would silently zero out the hard pet/category
// filters and the hyper-personalization tiers. Swap load() alone once the YAML schema
// gains those fields — no consumer of getProducts()/getProduct() needs to change.
import { Injectable, Logger } from '@nestjs/common';
import { PRODUCTS } from './products.data';
import { IProductRepository, InsuranceProduct } from './types';

@Injectable()
export class ProductCatalog implements IProductRepository {
  private readonly logger = new Logger(ProductCatalog.name);
  private readonly products: InsuranceProduct[];

  constructor() {
    this.products = this.load();
    this.validate(this.products);
    this.logger.log(`Product catalog loaded: ${this.products.length} products`);
  }

  getProducts(): InsuranceProduct[] {
    return [...this.products];
  }

  getProduct(id: string): InsuranceProduct | undefined {
    return this.products.find((p) => p.id === id);
  }

  private load(): InsuranceProduct[] {
    return [...PRODUCTS];
  }

  // Public, not part of IProductRepository (same precedent as AffiliateLookupService's
  // isEnabled() — a capability of the concrete class, not something QuotingService, the
  // only real consumer, ever needs to call). Aggregates every violation into ONE thrown
  // error (mirrors env.validation.ts's crossFieldErrors) instead of failing on the first
  // problem, so a genuine authoring bug doesn't turn into a slow fix-one-rerun loop. This
  // throws rather than warn-and-disable (AffiliateLookupService's pattern): that pattern
  // exists for an OPTIONAL external file that can legitimately be absent — this catalog
  // is compiled-in TypeScript that can never be "missing", so a validation failure means
  // a genuine authoring bug, and there's no meaningful "0 products" mode for a quoting
  // engine. main.ts's bootstrap().catch() converts this throw into a clean boot exit.
  validate(products: InsuranceProduct[] = this.products): void {
    const errors = this.collectErrors(products);
    if (errors.length > 0) {
      throw new Error(`ProductCatalog validation failed (${errors.length} issue(s)):\n- ${errors.join('\n- ')}`);
    }
  }

  private collectErrors(products: InsuranceProduct[]): string[] {
    const errors: string[] = [];
    if (products.length === 0) errors.push('catalog is empty — no products loaded');

    const seenIds = new Set<string>();
    for (const [index, p] of products.entries()) {
      const label = `product[${index}]${p?.id ? ` (${p.id})` : ''}`;
      if (!p?.id || typeof p.id !== 'string' || !p.id.trim()) {
        errors.push(`${label}: missing/empty id`);
        continue;
      }
      if (seenIds.has(p.id)) errors.push(`duplicate product id: "${p.id}"`);
      seenIds.add(p.id);

      if (!p.name || typeof p.name !== 'string') errors.push(`${label}: missing name`);
      if (!p.category || typeof p.category !== 'string' || !p.category.trim()) errors.push(`${label}: missing category`);
      if (typeof p.basePremium !== 'number' || !Number.isFinite(p.basePremium) || p.basePremium <= 0) {
        errors.push(`${label}: basePremium must be a positive finite number, got ${p.basePremium}`);
      }
      if (!Array.isArray(p.coverages)) errors.push(`${label}: coverages must be an array`);
      // evaluateProduct()'s pet hard-filter does exact string comparison against
      // signals.petType — a typo'd eligibility.pet value would silently never match
      // anything (wrong scoring, no crash) rather than fail loudly at boot.
      if (typeof p.eligibility !== 'object' || p.eligibility === null) {
        errors.push(`${label}: eligibility must be an object (use {} for "no restrictions")`);
      } else if (p.eligibility.pet !== undefined && !['gato', 'perro', 'any'].includes(p.eligibility.pet)) {
        errors.push(`${label}: eligibility.pet must be gato/perro/any, got "${p.eligibility.pet}"`);
      }
      if (p.businessPriority !== undefined && typeof p.businessPriority !== 'boolean') errors.push(`${label}: businessPriority must be boolean`);
      if (p.requiresUnderwriting !== undefined && typeof p.requiresUnderwriting !== 'boolean') errors.push(`${label}: requiresUnderwriting must be boolean`);
      if (!p.url || typeof p.url !== 'string') errors.push(`${label}: missing url`);
    }
    return errors;
  }
}
