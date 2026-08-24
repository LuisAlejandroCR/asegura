// herramientas-log.ts: names the tools a turn ran. The worker only logged "Executing LLM tool
// call", so an escalation to a human or a policy issued left no trace of which one it was.
interface LlamadaRegistrable {
  name: string;
  callId: string;
}

interface SalidaRegistrable {
  callId: string;
  output: string;
  isError: boolean;
}

// Los argumentos llevan cédula, nombre y correo, y el motivo de escalar es texto de la persona:
// solo salen el nombre de la herramienta y, cuando se niega, su razón — que la escribe el código.
const SIN_MOTIVO_EN_LOG = ['escalar_a_humano', 'registrar_lead'];

export function describirHerramientasEjecutadas(
  llamadas: readonly LlamadaRegistrable[],
  salidas: readonly SalidaRegistrable[],
): string {
  if (!llamadas.length) return '';

  const partes = llamadas.map((llamada) => {
    const salida = salidas.find((s) => s.callId === llamada.callId);
    if (!salida) return `${llamada.name} sin respuesta`;

    const motivo = SIN_MOTIVO_EN_LOG.includes(llamada.name) ? undefined : motivoDe(salida.output);
    if (motivo) return `${llamada.name} rechazó: ${motivo}`;
    return `${llamada.name} ${salida.isError ? 'error' : 'ok'}`;
  });

  return `herramientas: ${partes.join(', ')}`;
}

function motivoDe(output: string): string | undefined {
  try {
    const cuerpo = JSON.parse(output) as { ok?: boolean; encontrado?: boolean; motivo?: string };
    if (cuerpo.ok === false || cuerpo.encontrado === false) return cuerpo.motivo;
    return undefined;
  } catch {
    return undefined;
  }
}
