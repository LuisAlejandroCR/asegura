// validar-datos.tool.ts: the cedula/nombre/email rules, extracted so voice validates exactly
// what text validates. Pure — no deps, no I/O.

import { ToolOutcome } from './types';

// Letters only (accents and ñ included), never digits — "2+2" was once accepted as a name.
const NAME_REGEX = /^[a-zA-ZÀ-ÖØ-öø-ÿ]+(?:['’-][a-zA-ZÀ-ÖØ-öø-ÿ]+|\s+[a-zA-ZÀ-ÖØ-öø-ÿ]+)*$/;
// A lead-in restating the question passes NAME_REGEX, so it is stripped before validating.
const NAME_PREAMBLE_REGEX = /^(mi nombre completo es|mi nombre es|me llamo|yo soy|soy)\s*/i;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeName(text: string): string {
  return text.trim().replace(NAME_PREAMBLE_REGEX, '').trim();
}

// An acknowledgement is letters-only, so NAME_REGEX alone accepted "gracias" as a full name
// and stored it. These are the words a person says instead of answering.
const FILLER_WORDS = ['gracias', 'ok', 'okay', 'vale', 'listo', 'dale', 'bueno', 'ya', 'si', 'sí', 'no'];

export function isValidName(text: string): boolean {
  const t = normalizeName(text);
  if (FILLER_WORDS.includes(t.toLowerCase())) return false;
  return t.length >= 2 && t.length <= 80 && NAME_REGEX.test(t);
}

// Mirrors the state machine so both engines file the same document type. Order matters:
// "cédula de extranjería" must win over the bare ce test.
export type TipoDocumento = 'CC' | 'CE' | 'PEP' | 'TI' | 'NIP' | 'NUIP';

// Ordered by how common they are in Colombia, so a prompt or a menu offers CC first.
export const TIPOS_DOCUMENTO: readonly TipoDocumento[] = ['CC', 'CE', 'PEP', 'TI', 'NIP', 'NUIP'];

// Lo que se ofrece al preguntar: los tres que trae la gente en la práctica. Los demás se
// siguen aceptando si la persona los nombra, pero no se leen en voz alta.
export const TIPOS_DOCUMENTO_OFRECIDOS: readonly TipoDocumento[] = ['CC', 'CE', 'PEP'];

export const TIPOS_DOCUMENTO_ETIQUETAS: Record<TipoDocumento, string> = {
  CC: 'cédula de ciudadanía',
  CE: 'cédula de extranjería',
  PEP: 'PEP',
  TI: 'tarjeta de identidad',
  NIP: 'número de identificación personal',
  NUIP: 'número único de identificación personal',
};

// null means the person did not say which one — the caller should ask instead of assuming.
export function tipoDocumentoDeclarado(text: string): TipoDocumento | null {
  const t = text.toLowerCase();
  if (/\bpep\b/.test(t) || t.includes('permiso especial')) return 'PEP';
  if (t.includes('extranjer')) return 'CE';
  if (t.includes('tarjeta de identidad') || /\bti\b/.test(t)) return 'TI';
  if (/\bnuip\b/.test(t)) return 'NUIP';
  if (/\bnip\b/.test(t)) return 'NIP';
  if (/\bce\b/.test(t)) return 'CE';
  if (t.includes('ciudadan') || /\bcc\b/.test(t)) return 'CC';
  return null;
}

export function detectarTipoDocumento(text: string): TipoDocumento {
  const t = text.toLowerCase();
  if (/\bpep\b/.test(t) || t.includes('permiso especial')) return 'PEP';
  if (t.includes('extranjer')) return 'CE';
  if (t.includes('tarjeta de identidad') || /\bti\b/.test(t)) return 'TI';
  if (/\bnuip\b/.test(t)) return 'NUIP';
  if (/\bnip\b/.test(t)) return 'NIP';
  if (/\bce\b/.test(t)) return 'CE';
  return 'CC';
}

// Dictated emails spell the symbols out, and Whisper often adds a comma right after.
export function normalizeSpokenEmail(text: string): string {
  return text
    .replace(/[\s,]*\barroba\b[\s,]*/gi, '@')
    .replace(/[\s,]*\bpunto\b[\s,]*/gi, '.')
    .replace(/\s+/g, '');
}

export function isValidEmail(text: string): boolean {
  return EMAIL_REGEX.test(normalizeSpokenEmail(text));
}

// Thousands separators are rejected on purpose: "12.345.678" read as 12345678 silently
// changes the number the person gave.
export function isValidCedula(text: string): boolean {
  return /^\d{6,10}$/.test(text.trim());
}

// A cedula dictated digit by digit arrives as "1, 2, 3"; joined only when EVERY token is a
// single digit, so a typed "12.345.678" still fails.
export function normalizeSpokenCedula(text: string): string {
  const tokens = text.trim().split(/[\s,]+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((t) => /^\d$/.test(t))) return tokens.join('');
  return text.trim();
}

export interface DatosValidados {
  cedula?: string;
  nombre?: string;
  email?: string;
  documentType?: TipoDocumento;
}

// True when a number was captured but nobody said which document it is, so the agent should
// ask rather than file it as a cedula de ciudadania by default.
export function faltaTipoDocumento(datos: DatosValidados, declarado: TipoDocumento | null): boolean {
  return !!datos.cedula && declarado === null;
}

// `mensaje` carries the raw turn so the document type can be read from it. The cedula itself
// stays strictly digits: loosening it here is how "12.345.678" would silently become 12345678.
export function validarDatosLogic(
  args: DatosValidados & { mensaje?: string },
): ToolOutcome<{ datos: DatosValidados; preguntarTipo?: string }> {
  const datos: DatosValidados = {};
  const invalidos: string[] = [];

  if (args.cedula !== undefined) {
    const c = normalizeSpokenCedula(args.cedula);
    if (isValidCedula(c)) {
      datos.cedula = c;
      // An explicit answer wins; otherwise read it from the turn, and fall back to the most
      // common one. `preguntarTipo` in the result tells the caller it was a fallback.
      // Solo se archiva cuando alguien lo dijo. Antes caía a 'CC' y `preguntarTipo` quedaba
      // como un aviso que nadie leía: el tipo ya estaba escrito, así que no había nada que
      // corregir y la póliza salía a nombre de un documento que la persona podía no tener.
      const declarado = args.documentType ?? tipoDocumentoDeclarado(args.mensaje ?? args.cedula);
      if (declarado) datos.documentType = declarado;
    } else {
      invalidos.push('cédula (deben ser 6 a 10 dígitos, sin puntos)');
    }
  }
  if (args.nombre !== undefined) {
    if (isValidName(args.nombre)) datos.nombre = normalizeName(args.nombre);
    else invalidos.push('nombre (solo letras)');
  }
  if (args.email !== undefined) {
    const e = normalizeSpokenEmail(args.email);
    if (isValidEmail(e)) datos.email = e;
    else invalidos.push('correo');
  }

  if (invalidos.length) return { ok: false, motivo: `No pude validar: ${invalidos.join(', ')}.` };

  const declarado = args.documentType ?? (args.cedula ? tipoDocumentoDeclarado(args.mensaje ?? args.cedula) : null);
  if (faltaTipoDocumento(datos, declarado)) {
    return {
      ok: true,
      datos,
      // El texto decía "quedó como cédula de ciudadanía" y describía lo que ya no pasa: el
      // tipo no se archiva solo. Ahora falta de verdad, y sin él no se puede emitir.
      preguntarTipo: `Falta el tipo de documento y no se asume ninguno. Pregúntale cuál es: ${TIPOS_DOCUMENTO_OFRECIDOS.map((t) => TIPOS_DOCUMENTO_ETIQUETAS[t]).join(', ')}.`,
    };
  }
  return { ok: true, datos };
}
