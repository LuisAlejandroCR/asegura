// latencia.spec.ts: la llamada dejaba 2–3 s de silencio por turno y el log no decía de quién
// era el tiempo. Sin repartirlo, cualquier arreglo es una apuesta.
import { AcumuladorDeTurno } from './latencia';

const eou = (speechId: string, fin: number, transcripcion: number) => ({
  type: 'eou_metrics' as const,
  timestamp: 0,
  endOfUtteranceDelayMs: fin,
  transcriptionDelayMs: transcripcion,
  onUserTurnCompletedDelayMs: 0,
  lastSpeakingTimeMs: 0,
  speechId,
});

const llm = (speechId: string, ttft: number) => ({
  type: 'llm_metrics' as const,
  label: 'openai.LLM', requestId: 'r', timestamp: 0, durationMs: 0, ttftMs: ttft,
  cancelled: false, completionTokens: 0, promptTokens: 0, promptCachedTokens: 0,
  totalTokens: 0, tokensPerSecond: 0, speechId,
});

const tts = (speechId: string, ttfb: number) => ({
  type: 'tts_metrics' as const,
  label: 'elevenlabs.TTS', requestId: 'r', timestamp: 0, ttfbMs: ttfb, durationMs: 0,
  audioDurationMs: 0, cancelled: false, charactersCount: 0, streamed: true, speechId,
});

describe('reparto del silencio de un turno', () => {
  it('no dice nada hasta que el turno está completo', () => {
    const acc = new AcumuladorDeTurno();

    expect(acc.registrar(eou('s1', 600, 400))).toBeUndefined();
    expect(acc.registrar(llm('s1', 700))).toBeUndefined();
  });

  it('no suma la transcripción aparte: viene dentro del fin de turno', () => {
    const acc = new AcumuladorDeTurno();
    acc.registrar(eou('s1', 600, 400));
    acc.registrar(llm('s1', 700));

    const linea = acc.registrar(tts('s1', 500));

    expect(linea).toBe('turno: 1800 ms de silencio = fin de turno 600 (transcripción 400) + modelo 700 + voz 500');
  });

  // Dos turnos seguidos no pueden sumarse entre sí: el reparto sería el doble y la etapa
  // culpable quedaría escondida.
  it('no mezcla dos turnos', () => {
    const acc = new AcumuladorDeTurno();
    acc.registrar(eou('s1', 600, 400));
    acc.registrar(eou('s2', 100, 100));
    acc.registrar(llm('s2', 100));
    acc.registrar(llm('s1', 700));

    expect(acc.registrar(tts('s2', 100))).toContain('300 ms de silencio');
    expect(acc.registrar(tts('s1', 500))).toContain('1800 ms de silencio');
  });

  // El TTS reintenta y vuelve a emitir métrica: el primer byte que la persona oye es el
  // primero, no el del reintento.
  it('se queda con el primer dato de cada etapa', () => {
    const acc = new AcumuladorDeTurno();
    acc.registrar(eou('s1', 600, 400));
    acc.registrar(llm('s1', 700));
    acc.registrar(tts('s1', 500));

    expect(acc.registrar(tts('s1', 9000))).toBeUndefined();
  });

  it('ignora las métricas que no reparten silencio', () => {
    const acc = new AcumuladorDeTurno();
    const vad = { type: 'vad_metrics' as const, label: 'silero', timestamp: 0, idleTimeMs: 0, inferenceDurationTotalMs: 0, inferenceCount: 0 };

    expect(acc.registrar(vad)).toBeUndefined();
  });
});
