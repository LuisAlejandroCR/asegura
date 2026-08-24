// cotizar-tool.ts: the LiveKit wrapper around the shared cotizar capability. The logic now
// lives in modules/agent/tools so voice and text score through one implementation; this file
// keeps the voice-shaped result the worker's spec and prompt were written against.
import { tool } from '@livekit/agents';
import { z } from 'zod';
import { QuotingService } from '../modules/quoting/quoting.service';
import { CATEGORIES, CotizacionEncontrada, CotizarArgs, cotizarLogic as sharedCotizar } from '../modules/agent/tools';

export interface CotizarResult {
  encontrado: boolean;
  producto?: string;
  aseguradora?: string;
  precioMensual?: number;
  coberturas?: string[];
  razon?: string;
  motivo?: string;
}

export const cotizarParams = z.object({
  productCategory: z.enum(CATEGORIES).nullable()
    .describe('La categoría de seguro que la persona quiere: vida, hogar, accidentes, asistencia o mascotas.'),
  dependents: z.number().int().min(0).nullable().optional()
    .describe('Cuántas personas dependen económicamente de la persona. 0 si vive sola.'),
  budget: z.number().nullable().optional()
    .describe('Presupuesto mensual en pesos colombianos que la persona mencionó, si lo dijo.'),
  petType: z.enum(['gato', 'perro', 'mixto']).nullable().optional()
    .describe('Solo si productCategory es mascotas: qué tipo de mascota(s) tiene. Pregúntalo, nunca lo supongas.'),
  mensaje: z.string().optional()
    .describe('Lo que dijo la persona, tal cual — sirve para detectar si pide algo que no vendemos.'),
});

export function cotizarLogic(quoting: QuotingService, args: CotizarArgs): CotizarResult {
  const result = sharedCotizar(quoting, args);
  if (!result.ok) return { encontrado: false, motivo: result.motivo };
  const c = result.cotizacion;
  return {
    encontrado: true,
    producto: c.producto,
    aseguradora: c.aseguradora,
    precioMensual: c.precioMensual,
    coberturas: c.coberturas,
    razon: c.razon,
  };
}

export function createCotizarTool(
  quoting: QuotingService,
  onQuoted?: (cotizacion: CotizacionEncontrada) => void,
  // Read at call time, so a purchase made mid-call is already visible to the guard.
  contextOf?: () => import('../modules/agent/types').ConversationContext,
) {
  return tool({
    name: 'cotizar',
    description:
      'Busca la mejor póliza de seguro para el perfil de la persona en el catálogo real de Asegura. ' +
      'SIEMPRE llama esta herramienta antes de decir un precio o nombre de producto — nunca inventes ' +
      'ninguno de los dos. Solo lee en voz alta lo que esta herramienta devuelve.',
    parameters: cotizarParams,
    execute: async (args) => {
      const result = sharedCotizar(quoting, args as CotizarArgs, contextOf?.());
      if (!result.ok) return { encontrado: false, motivo: result.motivo };
      // Remembered so emitirPoliza prices the same product the person just heard, and so
      // AseguraWeb paints the sheet with this number instead of one of its own.
      onQuoted?.(result.cotizacion);
      return cotizarLogic(quoting, args as CotizarArgs);
    },
  });
}
