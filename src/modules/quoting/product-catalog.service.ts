// product-catalog.service.ts: loads, validates and caches the YAML product catalog at boot,
// behind IProductRepository. Only priced, sellable products (company + public_price +
// requires_quote) become an InsuranceProduct; broken YAML crashes the boot on purpose.
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { IProductRepository, InsuranceProduct } from './types';

@Injectable()
export class ProductCatalog implements IProductRepository {
  private readonly logger = new Logger(ProductCatalog.name);
  private readonly products: InsuranceProduct[];

  // Tie-break order: score() sorts stably, so on a tie the id listed earlier here wins the
  // cut into the top 3. Unknown ids sort LAST, so a new product never jumps the queue.
  private static readonly CANONICAL_ORDER: readonly string[] = [
    'accidentes-personales', 'accidentes-premium', 'vida', 'asistencias-multiples',
    'exequial', 'accidentes-exequial', 'vida-ahorro', 'asistencias-medicas',
    'asistencia-veterinaria', 'medicina-prepagada-gatos', 'medicina-prepagada-perros',
  ];

  // Left out of the sellable catalog (no company or price yet). Collected instead of warned
  // per file: 13 WARN lines per boot buried the real signal. The count still surfaces, so a
  // product dropping out by accident stays visible.
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

    // process.cwd()-relative, not __dirname-relative: nest-cli doesn't copy non-.ts assets
    // into dist/, so src/ must exist alongside dist/ at runtime.
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

  // Aggregates every violation into ONE thrown error instead of failing on the first, so an
  // authoring bug isn't a fix-one-rerun loop. Throws rather than warn-and-disable: unlike an
  // optional external file, this catalog can never legitimately be missing.
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
      // A typo'd eligibility.pet would silently never match anything instead of failing here.
      if (typeof p.eligibility !== 'object' || p.eligibility === null) {
        errors.push(`${label}: eligibility must be an object (use {} for "no restrictions")`);
      } else if (p.eligibility.pet !== undefined && !['gato', 'perro', 'any'].includes(p.eligibility.pet)) {
        errors.push(`${label}: eligibility.pet must be gato/perro/any, got "${p.eligibility.pet}"`);
      }
      if (p.businessPriority !== undefined && typeof p.businessPriority !== 'boolean') errors.push(`${label}: businessPriority must be boolean`);
      if (p.requiresUnderwriting !== undefined && typeof p.requiresUnderwriting !== 'boolean') errors.push(`${label}: requiresUnderwriting must be boolean`);
      if (!p.url || typeof p.url !== 'string') errors.push(`${label}: missing url`);
    }

    // The real safety net for "a product silently vanished": the load-time gate only decides
    // what is ATTEMPTED, this confirms every expected product actually made it through.
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
