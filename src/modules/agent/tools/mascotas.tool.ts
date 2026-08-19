// mascotas.tool.ts: the per-pet details a pet policy is issued with. The state machine walks
// them one pet at a time; the model can gather them in any order, so the contract is what
// matters — a policy for N pets needs N of them, or the PDF and the premium are wrong.

import { ConversationContext, PetDetail } from '../types';
import { ToolDeps, ToolOutcome, requireAuthorization } from './types';
import { isValidName } from './validar-datos.tool';

export function esProductoDeMascotas(
  deps: Pick<ToolDeps, 'catalog'>,
  context: ConversationContext,
): boolean {
  const id = context.quoteProductId;
  if (!id || !deps.catalog) return false;
  return id.includes('mascota') || id.includes('gatos') || id.includes('perros') || id.includes('veterinaria');
}

export function registrarMascotasLogic(
  context: ConversationContext,
  args: { mascotas: Array<{ nombre: string; edad: string; raza?: string }> },
): ToolOutcome<{ mascotas: PetDetail[] }> {
  const denied = requireAuthorization(context);
  if (denied) return denied;

  const entradas = args.mascotas ?? [];
  if (!entradas.length) {
    return { ok: false, motivo: 'Necesito al menos el nombre y la edad de una mascota.' };
  }

  const esperadas = context.petCount ?? entradas.length;
  if (entradas.length !== esperadas) {
    return {
      ok: false,
      motivo: `La persona tiene ${esperadas} mascota(s) y me diste ${entradas.length}. Pídele los datos de las que faltan.`,
    };
  }

  const mascotas: PetDetail[] = [];
  for (const [i, p] of entradas.entries()) {
    // A pet name goes through the same rule as a human one, so "gracias" is not a pet either.
    if (!p.nombre || !isValidName(p.nombre)) {
      return { ok: false, motivo: `El nombre de la mascota ${i + 1} no es válido.` };
    }
    if (!p.edad || !String(p.edad).trim()) {
      return { ok: false, motivo: `Falta la edad de ${p.nombre}.` };
    }
    mascotas.push({ name: p.nombre.trim(), age: String(p.edad).trim(), breed: (p.raza ?? '').trim() });
  }

  return { ok: true, mascotas };
}
