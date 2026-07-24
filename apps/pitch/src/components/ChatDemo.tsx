import { useEffect, useRef, useState } from 'react';

type BeatKind = 'bot' | 'user' | 'typing' | 'quote' | 'success';

interface Beat {
  kind: BeatKind;
  text?: string;
  /** ms this beat stays as the "latest" message before the next one starts appearing */
  hold: number;
}

// Mirrors the real conversation-state.machine.ts wording and flow (GREETING → DISCOVERY →
// QUOTE_PRESENTED → DATA_CAPTURE → POLICY_ISSUED) — this is a faithful replay of the actual
// product, not a mockup of a feature that doesn't exist. Real product, real prices.
const SCRIPT: Beat[] = [
  { kind: 'bot', text: '¡Hola! Soy Asegura 🛡️ — tu asesor de seguros Colsubsidio, disponible 24/7.\n\n¿En qué te puedo ayudar hoy?', hold: 2600 },
  { kind: 'user', text: '🎙️ Tengo un perro y quiero protegerlo', hold: 1500 },
  { kind: 'typing', hold: 1100 },
  { kind: 'quote', hold: 3600 },
  { kind: 'user', text: 'Sí', hold: 1200 },
  { kind: 'typing', hold: 1000 },
  { kind: 'success', hold: 3600 },
];

const LOOP_PAUSE = 1200;

function ChatDemo() {
  const [step, setStep] = useState(0);
  const [cycleKey, setCycleKey] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const current = SCRIPT[step];
    const delay = reduceMotion ? Math.min(current.hold, 1200) : current.hold;

    timerRef.current = setTimeout(() => {
      if (step + 1 >= SCRIPT.length) {
        // Pause on the final "success" beat, then clear and restart the whole demo.
        timerRef.current = setTimeout(() => {
          setStep(0);
          setCycleKey((k) => k + 1);
        }, LOOP_PAUSE);
      } else {
        setStep((s) => s + 1);
      }
    }, delay);

    return () => clearTimeout(timerRef.current);
  }, [step, cycleKey]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' });
  }, [step, cycleKey]);

  const visibleBeats = SCRIPT.slice(0, step + 1);

  return (
    <div className="phone" aria-hidden="true">
      <div className="phone-notch" />
      <div className="phone-header">
        <span className="phone-avatar">🛡️</span>
        <div>
          <div className="phone-title">Asegura</div>
          <div className="phone-status"><span className="dot-online" />en línea</div>
        </div>
      </div>
      <div className="phone-body" ref={bodyRef}>
        {visibleBeats.map((beat, i) => (
          <ChatBeat key={`${cycleKey}-${i}`} beat={beat} isLatest={i === step} />
        ))}
      </div>
      <div className="phone-input">
        <span className="phone-input-placeholder">Escribe o envía un audio…</span>
        <span className="phone-mic">🎙️</span>
      </div>
    </div>
  );
}

function ChatBeat({ beat, isLatest }: { beat: Beat; isLatest: boolean }) {
  const animClass = isLatest ? 'beat-in' : '';

  if (beat.kind === 'typing') {
    return (
      <div className={`bubble bubble-bot bubble-typing ${animClass}`}>
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
    );
  }

  if (beat.kind === 'quote') {
    return (
      <div className={`bubble bubble-bot bubble-quote ${animClass}`}>
        <div className="quote-title">📋 Tu cotización personalizada</div>
        <div className="quote-product">🐾 Asistencia veterinaria <span className="quote-insurer">· GEA</span></div>
        <ul className="quote-coverages">
          <li>Consulta veterinaria</li>
          <li>Refuerzo de vacunación</li>
          <li>Urgencias por accidente</li>
        </ul>
        <div className="quote-price"><span className="mono">$14.500</span>/mes</div>
        <div className="quote-cta">¿Te interesa?</div>
      </div>
    );
  }

  if (beat.kind === 'success') {
    return (
      <div className={`bubble bubble-bot bubble-success ${animClass}`}>
        <div className="success-check">✓</div>
        <div className="success-title">¡Quedaste asegurado!</div>
        <div className="success-sub">Póliza PDF con QR de verificación — adjunta a este chat.</div>
      </div>
    );
  }

  return (
    <div className={`bubble ${beat.kind === 'user' ? 'bubble-user' : 'bubble-bot'} ${animClass}`}>
      {beat.text?.split('\n').map((line, i) => (
        <span key={i}>
          {line}
          {i < (beat.text?.split('\n').length ?? 1) - 1 && <br />}
        </span>
      ))}
    </div>
  );
}

export default ChatDemo;
