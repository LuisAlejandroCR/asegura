// deps.ts: builds the capability deps for the worker process, which has no NestJS DI. Each
// integration is optional: without its env vars the matching tool refuses with a reason the
// model can say out loud, instead of the worker failing to start.
import { ConfigService } from '@nestjs/config';
import { QuotingService } from '../modules/quoting/quoting.service';
import { ProductCatalog } from '../modules/quoting/product-catalog.service';
import { AffiliateLookupService } from '../modules/quoting/affiliate-lookup.service';
import { SupabaseService } from '../database/supabase.service';
import { PolicyService } from '../modules/policy/policy.service';
import { PdfService } from '../modules/policy/pdf.service';
import { WompiService } from '../modules/payments/wompi.service';
import { ToolDeps } from '../modules/agent/tools';

// ConfigService reads process.env when no module is attached, which is all this needs.
const config = new ConfigService();

export function buildVoiceDeps(): ToolDeps {
  const catalog = new ProductCatalog();
  const deps: ToolDeps = { quoting: new QuotingService(catalog), catalog };

  const affiliates = new AffiliateLookupService(config);
  affiliates.onApplicationBootstrap();
  deps.affiliates = affiliates;

  // Issuing a policy writes to Supabase; without those keys the tool says so rather than
  // pretending the sale closed.
  if (config.get<string>('SUPABASE_URL') && config.get<string>('SUPABASE_SERVICE_ROLE_KEY')) {
    const supabase = new SupabaseService(config);
    deps.policies = new PolicyService(supabase, new PdfService(), catalog);
  }

  const wompi = new WompiService(config);
  if (wompi.isEnabled) deps.payments = wompi;

  return deps;
}
