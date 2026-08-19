// pricing.ts: the single place the charged and displayed amount is computed. Mascotas
// products are priced per pet (basePremium is a one-pet price); this multiplication used
// to be duplicated, so the quote, the Wompi charge and the PDF disagreed.
import { InsuranceProduct } from './types';

// The one place that decides whether a premium is per pet. The PDF divides the stored total
// back down by pet_count, so if the multiplication and the display ever disagreed, a family
// product would print "$X por mascota" — which is exactly what happened once.
function isPricedPerPet(product: InsuranceProduct): boolean {
  return product.category === 'mascotas';
}

function computeTotalPremium(product: InsuranceProduct, petCount?: number | null): number {
  const units = isPricedPerPet(product) && petCount && petCount > 1 ? petCount : 1;
  return product.basePremium * units;
}

export { computeTotalPremium, isPricedPerPet };
