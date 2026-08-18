// cotizar-tool.ts: the tool that makes rule #5 ("NLP como asesor, reglas como decisor")
// enforceable in a live voice session — the model never states a price it didn't get from
// here. cotizarLogic is exported separately so it is testable without the LiveKit runtime.
import { tool } from '@livekit/agents';
import { z } from 'zod';
import { QuotingService } from '../modules/quoting/quoting.service';
import { AffiliateSignals } from '../modules/quoting/types';

export interface CotizarResult {
  encontrado: boolean;
  producto?: string;
  aseguradora?: string;
  precioMensual?: number;
  coberturas?: string[];
  razon?: string;
}

// Kept identical to InsuranceIntent's union so a voice-gathered profile scores through the
// exact same engine as a text-gathered one.
const CATEGORIES = ['vida', 'hogar', 'accidentes', 'asistencia', 'mascotas'] as const;

export const cotizarParams = z.object({
  productCategory: z.enum(CATEGORIES).nullable()
    .describe('La categoría de seguro que la persona quiere: vida, hogar, accidentes, asistencia o mascotas.'),
  dependents: z.number().int().min(0).nullable().optional()
    .describe('Cuántas personas dependen económicamente de la persona. 0 si vive sola.'),
  budget: z.number().nullable().optional()
    .describe('Presupuesto mensual en pesos colombianos que la persona mencionó, si lo dijo.'),
  petType: z.enum(['gato', 'perro', 'mixto']).nullable().optional()
    .describe('Solo si productCategory es mascotas: qué tipo de mascota(s) tiene.'),
});

export type CotizarArgs = z.infer<typeof cotizarParams>;

// Pure function — no LiveKit types in the signature, so it's directly unit-testable.
export function cotizarLogic(quoting: QuotingService, args: CotizarArgs): CotizarResult {
  const signals: AffiliateSignals = {
    productCategory: args.productCategory,
    dependents: args.dependents ?? undefined,
    budget: args.budget ?? undefined,
    petType: args.petType ?? undefined,
  };

  const best = quoting.bestQuote(signals);
  if (!best) {
    return { encontrado: false };
  }

  return {
    encontrado: true,
    producto: best.product.name,
    aseguradora: best.product.insurer,
    precioMensual: best.score.monthlyPremium,
    coberturas: best.product.coverages.slice(0, 3),
    razon: best.score.reasons[0],
  };
}

export function createCotizarTool(quoting: QuotingService) {
  return tool({
    name: 'cotizar',
    description:
      'Busca la mejor póliza de seguro para el perfil de la persona en el catálogo real de Asegura. ' +
      'SIEMPRE llama esta herramienta antes de decir un precio o nombre de producto — nunca inventes ' +
      'ninguno de los dos. Solo lee en voz alta lo que esta herramienta devuelve.',
    parameters: cotizarParams,
    execute: async (args) => cotizarLogic(quoting, args),
  });
}
