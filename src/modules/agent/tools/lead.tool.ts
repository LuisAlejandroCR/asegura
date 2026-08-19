// lead.tool.ts: keeping someone's details when the catalog has nothing left for them, so the
// team can call back. Notifying whoever picks it up is transport; validating that the lead is
// actually usable is the rule — a name with no way to reach the person is not a lead.

import { ConversationContext } from '../types';
import { ToolOutcome, requireAuthorization } from './types';
import { isValidEmail, isValidName, normalizeName, normalizeSpokenEmail } from './validar-datos.tool';

export interface Lead {
  nombre: string;
  email?: string;
  telefono?: string;
  interes?: string;
}

export function registrarLeadLogic(
  context: ConversationContext,
  args: { nombre?: string; email?: string; telefono?: string; interes?: string },
): ToolOutcome<{ lead: Lead }> {
  const denied = requireAuthorization(context);
  if (denied) return denied;

  // What the conversation already knows wins over asking again.
  const nombre = normalizeName(args.nombre ?? context.contactName ?? context.nombre ?? '');
  if (!nombre || !isValidName(nombre)) {
    return { ok: false, motivo: 'Necesito el nombre de la persona para dejar el registro.' };
  }

  const emailRaw = args.email ?? context.contactEmail ?? context.email;
  const email = emailRaw ? normalizeSpokenEmail(emailRaw) : undefined;
  if (email && !isValidEmail(email)) {
    return { ok: false, motivo: 'Ese correo no es válido, pídeselo de nuevo.' };
  }

  const telefono = (args.telefono ?? context.contactPhone ?? context.verifiedPhone ?? '').trim() || undefined;

  // A lead nobody can reach is not a lead.
  if (!email && !telefono) {
    return { ok: false, motivo: 'Falta un correo o un teléfono; sin eso no podemos devolverle la llamada.' };
  }

  return {
    ok: true,
    lead: { nombre, ...(email ? { email } : {}), ...(telefono ? { telefono } : {}), ...(args.interes ? { interes: args.interes } : {}) },
  };
}
