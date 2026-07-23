// pricing.ts: single source of truth for the actual amount charged/displayed for a
// product. Mascotas products are priced per pet (basePremium is a single-pet price) —
// a household with 3 pets pays 3x, not the flat listed price. This must be the ONLY
// place this multiplication happens: it was previously duplicated ad-hoc in the chat
// quote formatter but forgotten in the actual Wompi charge amount and the policy PDF,
// so the amount shown, the amount charged, and the amount printed all disagreed.
import { InsuranceProduct } from './types';

function computeTotalPremium(product: InsuranceProduct, petCount?: number | null): number {
  const units = product.category === 'mascotas' && petCount && petCount > 1 ? petCount : 1;
  return product.basePremium * units;
}

export { computeTotalPremium };
