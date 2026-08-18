// product-catalog.service.ts: This script is for loading, validating, and caching the
// insurance product catalog in memory at boot, behind IProductRepository (CLAUDE.md rule
// #6), so QuotingService's scoring engine no longer depends on products.data.ts directly.
//
// 2026-07-26 — reads catalog/products/*.yaml. Only priced, sellable products (company/
// public_price/requires_quote all set) become an InsuranceProduct; that alone excludes the
// unmigrated ones (SOAT, vehicular) without hardcoding ids. Broken YAML or a real product
// missing coverages never gets dropped silently — validate() below crashes the boot, since
// shipping a smaller catalog is worse than not booting.
//
// 2026-08-11 — agent.service.ts, conversation-state.machine.ts, and policy.service.ts all
// migrated off products.data.ts onto this class (DI where they have a constructor,
// module-level `new ProductCatalog()` where they don't). products.data.ts now exists only
// as a fixture for specs that assert against a known fixed list — never a runtime source.
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { IProductRepository, InsuranceProduct } from './types';

@Injectable()
export class ProductCatalog implements IProductRepository {
  private readonly logger = new Logger(ProductCatalog.name);
  private readonly products: InsuranceProduct[];

  // Preserves QuotingService's tie-break behavior across the products.data.ts → YAML
  // swap: score() does a stable sort by matchScore, so when two products tie, whichever
  // comes first in this array wins the cut into the top 3 (see quoting.service.spec.ts's
  // "prioritized asistencia product ... by catalog order" test) — this is the exact
  // original products.data.ts array order. Unknown ids sort LAST (not first), so a future
  // 12th real product that hasn't been added here yet doesn't silently jump the queue.
  private static readonly CANONICAL_ORDER: readonly string[] = [
    'accidentes-personales', 'accidentes-premium', 'vida', 'asistencias-multiples',
    'exequial', 'accidentes-exequial', 'vida-ahorro', 'asistencias-medicas',
    'asistencia-veterinaria', 'medicina-prepagada-gatos', 'medicina-prepagada-perros',
  ];

  // Files deliberately left out of the sellable catalog (no company/price yet). Collected
  // instead of warned per-file: 13 WARN lines per boot buried the real signal, and the
  // voice-agent worker forks several processes so it printed them all over again in each.
  // A product that isn't priced yet is expected state, not something to act on — the
  // count still surfaces, so a product silently dropping out stays visible.
  private readonly skipped: string[] = [];

  constructor() {
    this.products = this.load();
    this.validate(this.products);
    const skippedNote = this.skipped.length
      ? ` (${this.skipped.length} skipped, not yet priced: ${this.skipped.join(', ')})`
      : '';
    this.logger.log(`Product catalog loaded: ${this.products.length} products${skippedNote}`);
  }

  getProducts(): InsuranceProduct[] {
    return [...this.products];
  }

  getProduct(id: string): InsuranceProduct | undefined {
    return this.products.find((p) => p.id === id);
  }

  // catalog/products/*.yaml is process.cwd()-relative, not __dirname-relative — nest-cli
  // doesn't copy non-.ts assets into dist/, so src/ itself must exist alongside dist/ at
  // runtime (same convention as pdf.service.ts's IMAGES_DIR and agent.service.ts's
  // IDENTITY_ANIMATION_PATH).
  private load(): InsuranceProduct[] {
    const dir = path.join(process.cwd(), 'src', 'modules', 'quoting', 'catalog', 'products');
    const products: InsuranceProduct[] = [];

    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
      let raw: any;
      try {
        raw = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'));
      } catch (err) {
        this.logger.warn(`Skipping ${file}: YAML parse error — ${err}`);
        continue;
      }

      if (raw?.company == null || typeof raw?.public_price !== 'number' || raw?.requires_quote !== false) {
        this.skipped.push(file.replace(/\.yaml$/, ''));
        continue;
      }

      products.push({
        id: raw.id,
        name: raw.name,
        category: raw.category,
        insurer: raw.company,
        basePremium: raw.public_price,
        url: raw.url,
        coverages: raw.coverages,
        eligibility: {
          minAge: raw.eligibility?.min_age,
          maxAge: raw.eligibility?.max_age,
          family: raw.eligibility?.family,
          pet: raw.eligibility?.pet,
        },
        businessPriority: raw.business_priority,
        requiresUnderwriting: raw.requires_underwriting,
      });
    }

    const rank = (id: string) => {
      const i = ProductCatalog.CANONICAL_ORDER.indexOf(id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return products.sort((a, b) => rank(a.id) - rank(b.id));
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

    // The actual safety net for "a real product silently vanished" — not the load-time
    // gate above, which only decides what's ATTEMPTED; this confirms every expected real
    // product actually made it through (a YAML syntax error, an id typo, or an incomplete
    // company/public_price/requires_quote triad would otherwise fail this loudly instead
    // of silently shipping a smaller catalog).
    for (const id of ProductCatalog.CANONICAL_ORDER) {
      if (!products.some((p) => p.id === id)) {
        errors.push(
          `expected real product "${id}" did not load from catalog/products/*.yaml ` +
          `(YAML syntax error, id typo, or incomplete company/public_price/requires_quote triad)`,
        );
      }
    }
    return errors;
  }
}
