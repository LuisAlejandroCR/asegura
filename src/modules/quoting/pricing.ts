// pricing.ts: the single place the charged and displayed amount is computed. Mascotas
// products are priced per pet (basePremium is a one-pet price); this multiplication used
// to be duplicated, so the quote, the Wompi charge and the PDF disagreed.
import { InsuranceProduct } from './types';

function computeTotalPremium(product: InsuranceProduct, petCount?: number | null): number {
  const units = product.category === 'mascotas' && petCount && petCount > 1 ? petCount : 1;
  return product.basePremium * units;
}

export { computeTotalPremium };
