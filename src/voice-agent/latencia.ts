// latencia.ts: splits the pause between the person finishing a sentence and hearing the agent
// into its four stages. LiveKit reports each one separately and the worker printed none of
// them, so "2 to 3 seconds of silence" had no owner to blame.
import type { metrics } from '@livekit/agents';

interface Turno {
  finDeHabla?: number;
  transcripcion?: number;
  modelo?: number;
  voz?: number;
}

const SIN_ID = 'turno-sin-id';

export class AcumuladorDeTurno {
  private readonly turnos = new Map<string, Turno>();

  registrar(metric: metrics.AgentMetrics): string | undefined {
    if (metric.type === 'eou_metrics') {
      return this.anotar(metric.speechId, (t) => {
        t.finDeHabla ??= metric.endOfUtteranceDelayMs;
        t.transcripcion ??= metric.transcriptionDelayMs;
      });
    }
    if (metric.type === 'llm_metrics') {
      return this.anotar(metric.speechId, (t) => { t.modelo ??= metric.ttftMs; });
    }
    if (metric.type === 'tts_metrics') {
      return this.anotar(metric.speechId, (t) => { t.voz ??= metric.ttfbMs; });
    }
    return undefined;
  }

  private anotar(speechId: string | undefined, anotacion: (t: Turno) => void): string | undefined {
    const clave = speechId ?? SIN_ID;
    const turno = this.turnos.get(clave) ?? {};
    const completoAntes = estaCompleto(turno);
    anotacion(turno);
    this.turnos.set(clave, turno);

    if (completoAntes || !estaCompleto(turno)) return undefined;
    this.turnos.delete(clave);
    return describir(turno);
  }
}

function estaCompleto(turno: Turno): boolean {
  return turno.finDeHabla !== undefined && turno.transcripcion !== undefined
    && turno.modelo !== undefined && turno.voz !== undefined;
}

function describir(turno: Turno): string {
  const total = Math.round(turno.finDeHabla! + turno.transcripcion! + turno.modelo! + turno.voz!);
  return `turno: ${total} ms de silencio = fin de habla ${Math.round(turno.finDeHabla!)}` +
    ` + transcripción ${Math.round(turno.transcripcion!)}` +
    ` + modelo ${Math.round(turno.modelo!)} + voz ${Math.round(turno.voz!)}`;
}
