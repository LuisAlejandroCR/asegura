// docs-format.spec.ts: AGENTS.md limits a session entry to one paragraph of 3–4 lines, and the
// rule kept losing to the file's own older entries, which are longer. A rule nobody can check is
// a rule that drifts, so this checks it.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const MEMORIA = join(__dirname, '..', '..', 'docs', 'memoria.md');
const MAX_LINEAS = 4;

// Las entradas anteriores a la 98 se escribieron antes de que la regla fuera verificable; se
// dejan como están en vez de reescribir el historial ajeno.
const PRIMERA_VERIFICADA = 98;

interface Entrada {
  sesion: number;
  lineas: number;
}

function entradas(): Entrada[] {
  const texto = readFileSync(MEMORIA, 'utf8');
  return texto
    .split(/^### /m)
    .slice(1)
    .map((bloque) => {
      const [encabezado, ...resto] = bloque.split('\n');
      const sesion = /^Sesi[óo]n (\d+)/.exec(encabezado);
      if (!sesion) return null;
      const cuerpo = resto.join('\n').split(/^## /m)[0];
      return { sesion: Number(sesion[1]), lineas: cuerpo.split('\n').filter((l) => l.trim()).length };
    })
    .filter((entrada): entrada is Entrada => entrada !== null);
}

// docs/ vive solo en el repo privado, así que en CI el archivo no existe y no hay nada que medir.
const describeSiHayDocs = existsSync(MEMORIA) ? describe : describe.skip;

describeSiHayDocs('docs/memoria.md — una sesión, un párrafo', () => {
  it(`ninguna entrada desde la ${PRIMERA_VERIFICADA} pasa de ${MAX_LINEAS} líneas`, () => {
    const largas = entradas()
      .filter((entrada) => entrada.sesion >= PRIMERA_VERIFICADA && entrada.lineas > MAX_LINEAS)
      .map((entrada) => `Sesión ${entrada.sesion}: ${entrada.lineas} líneas`);

    expect(largas).toEqual([]);
  });

  // Un parseo que devuelve una línea por entrada pasaría el test de arriba sin medir nada: las
  // entradas viejas son largas a propósito y sirven de testigo de que el conteo es real.
  it('cuenta líneas de verdad, no una por entrada', () => {
    const medidas = entradas();

    expect(medidas.length).toBeGreaterThan(10);
    expect(medidas.some((entrada) => entrada.sesion < PRIMERA_VERIFICADA && entrada.lineas >= 5)).toBe(true);
    expect(medidas.filter((e) => e.sesion >= PRIMERA_VERIFICADA).every((e) => e.lineas >= 3)).toBe(true);
  });
});
