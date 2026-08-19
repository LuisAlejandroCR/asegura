// cotizar.tool.ts: the only place a price or product name may come from (rules #5 and #12).
// Moved out of src/voice-agent so the text channel scores through the same call.

import { AffiliateSignals } from '../../quoting/types';
import { QuotingService } from '../../quoting/quoting.service';
import { ConversationContext } from '../types';
import { ToolOutcome } from './types';

export const CATEGORIES = ['vida', 'hogar', 'accidentes', 'asistencia', 'mascotas'] as const;

export interface CotizarArgs {
  productCategory: (typeof CATEGORIES)[number] | null;
  dependents?: number | null;
  budget?: number | null;
  petType?: 'gato' | 'perro' | 'mixto' | null;
}

export interface CotizacionEncontrada {
  productId: string;
  producto: string;
  aseguradora: string;
  precioMensual: number;
  coberturas: string[];
  razon?: string;
}

export function cotizarLogic(
  quoting: QuotingService,
  args: CotizarArgs,
  // Optional so the voice worker and the existing callers keep working; when present it stops
  // a cross-sell from re-quoting something the person already owns.
  context?: ConversationContext,
): ToolOutcome<{ cotizacion: CotizacionEncontrada }> {
  const signals: AffiliateSignals = {
    productCategory: args.productCategory,
    dependents: args.dependents ?? undefined,
    budget: args.budget ?? undefined,
    petType: args.petType ?? undefined,
  };

  const best = quoting.bestQuote(signals);
  if (!best) {
    // A species-specific plan is unquotable without a species, so say what is missing rather
    // than letting the model guess one.
    const motivo = args.productCategory === 'mascotas' && !args.petType
      ? 'No hay una opción para mascotas sin saber si es gato o perro. Pregúntalo.'
      : 'No encontré un producto para ese perfil en el catálogo.';
    return { ok: false, motivo };
  }

  // A decline in the cross-sell used to be read as a category by the model, which re-quoted
  // the product just bought and issued a second payment link for it. Owning it is the guard.
  const owned = context?.purchasedProductIds ?? [];
  if (owned.includes(best.product.id)) {
    return {
      ok: false,
      motivo: `La persona ya compró ${best.product.name}. No se lo vuelvas a ofrecer; pregúntale qué otra cosa quiere proteger.`,
    };
  }

  return {
    ok: true,
    cotizacion: {
      productId: best.product.id,
      producto: best.product.name,
      aseguradora: best.product.insurer,
      precioMensual: best.score.monthlyPremium,
      coberturas: best.product.coverages.slice(0, 3),
      razon: best.score.reasons[0],
    },
  };
}
