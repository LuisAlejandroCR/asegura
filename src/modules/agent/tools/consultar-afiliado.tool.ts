// consultar-afiliado.tool.ts: SERIE lookup against the synthetic affiliate CSV, so the agent
// never asks for something Colsubsidio already has on file. Reads PII, so it is gated.

import { ConversationContext } from '../types';
import { ToolDeps, ToolOutcome, requireAuthorization } from './types';

// SERIE is a plain row number in this dataset, not a real Colsubsidio id.
const MAX_SERIE = 500_000;

export interface AfiliadoEncontrado {
  encontrado: boolean;
  rangoSalarial?: string;
  dependientes?: number;
  mascotas?: number;
}

export function consultarAfiliadoLogic(
  deps: Pick<ToolDeps, 'affiliates'>,
  context: ConversationContext,
  args: { serie: string },
): ToolOutcome<AfiliadoEncontrado> {
  const denied = requireAuthorization(context);
  if (denied) return denied;

  const serie = args.serie.replace(/\D/g, '');
  const n = Number(serie);
  if (!serie || !Number.isInteger(n) || n < 1 || n > MAX_SERIE) {
    return { ok: false, motivo: 'Ese ID no tiene el formato de un afiliado de Colsubsidio.' };
  }
  if (!deps.affiliates?.isEnabled()) {
    // A disabled lookup is not an error: the flow continues without the enrichment.
    return { ok: true, encontrado: false };
  }

  const record = deps.affiliates.findBySerie(serie) as
    | { rangoSalarial?: string; dependents?: number; petCount?: number }
    | null;
  if (!record) return { ok: true, encontrado: false };

  return {
    ok: true,
    encontrado: true,
    rangoSalarial: record.rangoSalarial,
    dependientes: record.dependents,
    mascotas: record.petCount,
  };
}
