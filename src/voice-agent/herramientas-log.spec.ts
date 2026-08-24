// herramientas-log.spec.ts: el log solo decía "Executing LLM tool call", así que cuando el
// agente escalaba a un humano o emitía una póliza no había forma de saber cuál corrió.
import { describirHerramientasEjecutadas } from './herramientas-log';

const llamada = (name: string, args: string) => ({ name, args, callId: 'c1' });
const salida = (output: string, isError = false) => ({ output, isError, callId: 'c1' });

describe('qué herramienta corrió', () => {
  it('nombra la herramienta y si le fue bien', () => {
    const linea = describirHerramientasEjecutadas(
      [llamada('cotizar', '{"productCategory":"vida"}')],
      [salida('{"encontrado":true,"producto":"Seguro de vida"}')],
    );

    expect(linea).toBe('herramientas: cotizar ok');
  });

  it('dice el motivo cuando la herramienta se niega, que es la parte accionable', () => {
    const linea = describirHerramientasEjecutadas(
      [llamada('emitir_poliza', '{}')],
      [salida('{"ok":false,"motivo":"Falta cédula, nombre antes de emitir."}')],
    );

    expect(linea).toContain('emitir_poliza');
    expect(linea).toContain('Falta cédula, nombre antes de emitir.');
  });

  // Los argumentos llevan cédula, nombre y correo, y el motivo de escalar es texto de la
  // persona: nada de eso puede acabar en un log (Ley 1581).
  it('nunca imprime los argumentos ni el texto de la persona', () => {
    const linea = describirHerramientasEjecutadas(
      [llamada('capturar_datos', '{"cedula":"1020304050","nombre":"Ana Gómez"}')],
      [salida('{"ok":true}')],
    );

    expect(linea).not.toContain('1020304050');
    expect(linea).not.toContain('Ana Gómez');
  });

  it('escalar se nombra pero su motivo no se imprime: lo escribe la persona', () => {
    const linea = describirHerramientasEjecutadas(
      [llamada('escalar_a_humano', '{"motivo":"mi mamá está enferma y quiero reclamar"}')],
      [salida('{"ok":true,"motivo":"mi mamá está enferma y quiero reclamar"}')],
    );

    expect(linea).toContain('escalar_a_humano');
    expect(linea).not.toContain('mamá');
  });

  it('varias en un turno salen en una sola línea', () => {
    const linea = describirHerramientasEjecutadas(
      [llamada('cotizar', '{}'), llamada('registrar_mascotas', '{}')],
      [salida('{"encontrado":true}'), salida('{"ok":true}')],
    );

    expect(linea).toBe('herramientas: cotizar ok, registrar_mascotas ok');
  });

  it('una llamada sin salida se nombra igual: es el par que rompe una interrupción', () => {
    const linea = describirHerramientasEjecutadas([llamada('emitir_poliza', '{}')], []);

    expect(linea).toBe('herramientas: emitir_poliza sin respuesta');
  });
});
