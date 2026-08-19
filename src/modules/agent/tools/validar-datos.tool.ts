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

export function isValidName(text: string): boolean {
  const t = normalizeName(text);
  return t.length >= 2 && t.length <= 80 && NAME_REGEX.test(t);
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
}

export function validarDatosLogic(args: DatosValidados): ToolOutcome<{ datos: DatosValidados }> {
  const datos: DatosValidados = {};
  const invalidos: string[] = [];

  if (args.cedula !== undefined) {
    const c = normalizeSpokenCedula(args.cedula);
    if (isValidCedula(c)) datos.cedula = c;
    else invalidos.push('cédula (deben ser 6 a 10 dígitos, sin puntos)');
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
  return { ok: true, datos };
}
