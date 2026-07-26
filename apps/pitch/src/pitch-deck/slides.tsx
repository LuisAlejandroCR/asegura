import { useEffect, useRef, useState } from 'react';
import { TangramLogo, ColsubK } from './TangramLogo';
import HookIntro from './HookIntro';
import AfiliadosCounter from './AfiliadosCounter';
import FunnelSpiral from './FunnelSpiral';
import VideoShowcase, { VideoStepPicker } from './VideoShowcase';
import WhyPicker from '../components/WhyPicker';

export interface SlideProps {
  active: boolean;
}

/* ── Slide 0 — Hook ────────────────────────────────────────────────────── */
export function Slide0Hook({ active }: SlideProps) {
  return (
    <>
      <HookIntro active={active} />
      <div
        style={{
          position: 'absolute',
          bottom: 52,
          left: '50%',
          transform: 'translateX(-50%)',
          fontSize: 11,
          color: 'rgba(255,255,255,.38)',
          whiteSpace: 'nowrap',
        }}
      >
        El modelo de ventas de seguros en Colombia no escala.
      </div>
    </>
  );
}

/* ── Slide 1 — Problema ───────────────────────────────────────────────── */
const PAIN_POINTS: [string, string, string][] = [
  ['🕐', 'Sin horario', 'Solo en jornada laboral'],
  ['📈', 'Sin escala', 'Un asesor = un cliente a la vez'],
  ['🎲', 'Sin consistencia', 'Cada asesor vende diferente'],
];

export function Slide1Problema({ active }: SlideProps) {
  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%,-50%)',
        width: 'calc(100% - 96px)',
        maxWidth: 1100,
        display: 'flex',
        alignItems: 'center',
        gap: 60,
      }}
    >
      <div style={{ flex: '0 0 55%' }}>
        <AfiliadosCounter active={active} />
        <div style={{ fontSize: 16, color: 'white', marginTop: 8, fontWeight: 600 }}>afiliados Colsubsidio</div>
        <div style={{ fontSize: 14, color: 'rgba(255,255,255,.55)', marginTop: 16, lineHeight: 1.65, maxWidth: 440 }}>
          Más todos los colombianos mayores de edad en todo el territorio nacional.
        </div>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {PAIN_POINTS.map(([icon, title, sub]) => (
          <div
            key={title}
            style={{
              background: 'rgba(255,255,255,.06)',
              borderLeft: '3px solid #FFD700',
              borderRadius: 8,
              padding: 16,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
            }}
          >
            <span style={{ fontSize: 20, flexShrink: 0 }}>{icon}</span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'white' }}>{title}</div>
              <div style={{ fontSize: 12, color: 'rgba(255,215,0,.55)', marginTop: 3 }}>{sub}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Slide 2 — Solución ───────────────────────────────────────────────── */
export function Slide2Solucion(_: SlideProps) {
  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%,-50%)',
        textAlign: 'center',
        width: '100%',
        maxWidth: 820,
        padding: '0 40px',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 28 }}>
        <img src="/logo.jpeg" alt="Asegura — Seguros automatizados · Colsubsidio" style={{ height: 96, width: 'auto', display: 'block' }} />
      </div>
      <div
        style={{
          background: '#FFF8E1',
          borderLeft: '4px solid #FFD700',
          borderRadius: '0 8px 8px 0',
          padding: '14px 20px',
          marginBottom: 22,
          textAlign: 'left',
        }}
      >
        <div style={{ fontSize: 11, color: 'rgba(0,48,135,.5)', marginBottom: 4, fontWeight: 600, letterSpacing: 0.5 }}>
          EN PALABRAS SIMPLES
        </div>
        <div style={{ fontSize: 16, color: '#003087', fontWeight: 600, lineHeight: 1.5 }}>
          "Te preguntamos quién eres, te decimos qué seguro necesitas,
          <br />
          y quedas asegurado — sin hablar con nadie."
        </div>
      </div>
      <div style={{ fontSize: 16, color: 'rgba(0,48,135,.55)', marginBottom: 24 }}>
        Desde 3 minutos · Sin asesores · 24/7
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ background: '#003087', color: 'white', borderRadius: 20, padding: '8px 20px', fontSize: 13, fontWeight: 600 }}>
          ✓ Agente conversacional activo
        </span>
        <span style={{ background: '#FFD700', color: '#003087', borderRadius: 20, padding: '8px 20px', fontSize: 13, fontWeight: 600 }}>
          🇨🇴 Para cualquier colombiano mayor de edad
        </span>
      </div>
    </div>
  );
}

/* ── Slide 3 — Cómo funciona (embudo espiral animado) ─────────────────── */
export function Slide3Flujo({ active }: SlideProps) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 36 }}>
      <div style={{ textAlign: 'center', marginBottom: 4, flexShrink: 0 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: 'white' }}>El flujo completo</div>
        <div style={{ fontSize: 12, color: 'rgba(255,215,0,.55)' }}>
          Del mercado total a la póliza — o al lead calificado.
        </div>
      </div>
      <div style={{ flex: 1, width: '100%', minHeight: 0 }}>
        <FunnelSpiral active={active} />
      </div>
    </div>
  );
}

/* ── Slide 4 — Categorías (tangram) ───────────────────────────────────── */
const CATEGORIES: [string, string, string][] = [
  ['#FFD700', 'Vida', 'Seguro de vida, Vida+Ahorro, Oncológico'],
  ['#FFB300', 'Accidentes', 'MetLife, Chubb, Pan American Life'],
  ['#FF8F00', 'Salud', 'Asistencias médicas, Asistencias múltiples'],
  ['#FF6F00', 'Familiar', 'Mascotas, Exequial, Acc+Exequial'],
  ['#FFA000', 'Hogar', 'Contenido+Estructura, Arrendamiento'],
  ['#FFD700', 'Vehículos', 'Carro, Moto, Bicicleta/Patineta'],
  ['#FFCA28', 'Empresas', 'Vida colectivo empresas, Deudores'],
];

export function Slide4Categorias(_: SlideProps) {
  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%,-50%)',
        width: 'calc(100% - 96px)',
        maxWidth: 1100,
        display: 'flex',
        alignItems: 'center',
        gap: 64,
      }}
    >
      <div style={{ flex: '0 0 38%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <TangramLogo stroke="#FFFFFF" size={200} colorful />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 24, fontWeight: 700, color: '#003087', marginBottom: 4 }}>19 productos. 7 categorías.</div>
        <div style={{ fontSize: 13, color: 'rgba(0,48,135,.55)', marginBottom: 20, lineHeight: 1.5 }}>
          El agente cotiza, personaliza y emite en la misma conversación.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {CATEGORIES.map(([color, name, desc], i) => (
            <div
              key={name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '7px 0',
                borderBottom: i < CATEGORIES.length - 1 ? '1px solid rgba(0,48,135,.07)' : 'none',
              }}
            >
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
              <div style={{ fontSize: 13, color: '#003087' }}>
                <strong>{name}</strong> — {desc}
              </div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 10, color: 'rgba(0,48,135,.4)', marginTop: 14, fontStyle: 'italic', lineHeight: 1.5 }}>
          Precios reales · MetLife · Chubb · Pan American Life · GEA · BMI · VetPlus · Grupo Recordar
        </div>
      </div>
    </div>
  );
}

/* ── Slide 5 — Super-agente ────────────────────────────────────────────── */
const FEATURES: [string, string, string][] = [
  [
    '🧠',
    'Propensión explicable',
    'Sabe a quién mostrarle qué seguro, cuándo y por qué. Cada recomendación tiene una razón basada en el perfil real.',
  ],
  [
    '🎯',
    'Oferta única por perfil',
    'Un soltero de 25 años y una familia con 3 hijos ven productos, coberturas y precios completamente distintos.',
  ],
  ['🎙️', 'Conversación natural', 'Groq LLM (llama-3.1) + Whisper. El usuario habla como habla. En español colombiano.'],
];
const TECH_CHIPS = ['NestJS', 'Supabase', 'Groq', 'Whisper', 'Wompi', 'Telegram', 'Railway'];

export function Slide5SuperAgente(_: SlideProps) {
  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%,-50%)',
        textAlign: 'center',
        width: '100%',
        maxWidth: 1100,
        padding: '0 40px',
      }}
    >
      <div style={{ fontSize: 26, fontWeight: 700, color: 'white', marginBottom: 6 }}>No es un chatbot.</div>
      <div style={{ fontSize: 16, color: '#FFD700', marginBottom: 36 }}>Es un super-agente con hiperpersonalización.</div>
      <div style={{ display: 'flex', gap: 20 }}>
        {FEATURES.map(([icon, title, desc]) => (
          <div
            key={title}
            style={{
              flex: 1,
              background: 'rgba(255,255,255,.05)',
              borderTop: '3px solid #FFD700',
              borderRadius: 12,
              padding: '28px 24px',
              textAlign: 'left',
            }}
          >
            <div style={{ fontSize: 26, marginBottom: 14 }}>{icon}</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'white', marginBottom: 8 }}>{title}</div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,.5)', lineHeight: 1.65 }}>{desc}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 28, flexWrap: 'wrap' }}>
        {TECH_CHIPS.map((t) => (
          <span key={t} style={{ background: 'rgba(255,255,255,.1)', color: 'white', fontSize: 10, borderRadius: 4, padding: '3px 8px' }}>
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Slide 6 — Explóralo (propensión explicable, interactivo) ─────────── */
export function Slide6Explora(_: SlideProps) {
  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%,-50%)',
        width: 'calc(100% - 96px)',
        maxWidth: 900,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: '.14em', textTransform: 'uppercase', color: '#0067B1', marginBottom: 10 }}>
        Propensión explicable
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: '#003087', marginBottom: 8, letterSpacing: '-.02em' }}>
        Cada recomendación tiene una razón.
      </div>
      <div style={{ fontSize: 14, color: 'rgba(0,48,135,.55)', maxWidth: 560, margin: '0 auto', lineHeight: 1.6 }}>
        Elige tu situación — esta es exactamente la lógica que corre en producción, no una simulación aparte.
      </div>
      <WhyPicker />
    </div>
  );
}

/* ── Slide 7 — Demo real (videos) ─────────────────────────────────────── */
export function Slide7Demo({ active }: SlideProps) {
  const [step, setStep] = useState(0);

  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%,-50%)',
        width: 'calc(100% - 96px)',
        maxWidth: 1200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 60,
      }}
    >
      <div style={{ flex: '0 0 38%', maxWidth: 420 }}>
        <div style={{ fontSize: 30, fontWeight: 700, color: 'white', lineHeight: 1.2, marginBottom: 8 }}>Pruébalo ahora.</div>
        <div style={{ fontSize: 15, color: '#FFD700', marginBottom: 32 }}>Flujo real. Sin guión. Sin trampa.</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 24 }}>
          {['Conversación real con IA', 'Pago real con Wompi (sandbox)', 'PDF de póliza con QR de auditoría'].map((t) => (
            <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  background: '#FFD700',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  fontSize: 11,
                  fontWeight: 700,
                  color: '#003087',
                }}
              >
                ✓
              </div>
              <div style={{ fontSize: 14, color: 'white' }}>{t}</div>
            </div>
          ))}
        </div>
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 10, color: 'rgba(255,215,0,.6)', marginBottom: 8, letterSpacing: 0.5, textTransform: 'uppercase' }}>
            Salta a cualquier paso
          </div>
          <VideoStepPicker step={step} onSelect={setStep} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ background: 'white', padding: 16, borderRadius: 14, display: 'inline-block' }}>
            <img src="/qr-bot.svg" width={220} height={220} style={{ display: 'block' }} alt="QR Asegura Bot" />
          </div>
          <div style={{ fontSize: 13, color: '#FFD700', fontWeight: 600 }}>t.me/asegura_bot</div>
          <div style={{ fontSize: 10, color: 'rgba(255,215,0,.45)' }}>Telegram · Disponible ahora</div>
        </div>
      </div>
      <VideoShowcase step={step} active={active} />
    </div>
  );
}

/* ── Slide 8 — Impacto ─────────────────────────────────────────────────── */
const METRICS: [string, string][] = [
  ['24/7', 'Disponible siempre'],
  ['<3 min', 'De cero a póliza activa'],
  ['$0', 'Costo de asesor por conversión'],
];

export function Slide8Impacto({ active }: SlideProps) {
  const startedRef = useRef(false);
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    if (active && !startedRef.current) {
      startedRef.current = true;
      setAnimate(true);
    }
  }, [active]);

  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%,-50%)',
        textAlign: 'center',
        width: '100%',
        maxWidth: 1000,
        padding: '0 40px',
      }}
    >
      <div style={{ fontSize: 26, fontWeight: 700, color: '#003087', marginBottom: 36 }}>Lo que esto cambia.</div>
      <div style={{ display: 'flex', gap: 24 }}>
        {METRICS.map(([num, label], i) => (
          <div key={num} style={{ flex: 1, border: '1.5px solid #003087', borderRadius: 12, padding: '32px 24px', textAlign: 'center' }}>
            <div
              style={{
                fontSize: 54,
                fontWeight: 800,
                color: '#003087',
                lineHeight: 1,
                letterSpacing: '-1px',
                opacity: animate ? undefined : 0,
                animation: animate ? `fadeUp .55s ease ${i * 160}ms both` : undefined,
              }}
            >
              {num}
            </div>
            <div style={{ fontSize: 13, color: 'rgba(0,48,135,.55)', marginTop: 10 }}>{label}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 32 }}>
        <div style={{ background: '#003087', color: 'white', borderRadius: 8, padding: '18px 36px', maxWidth: 560, fontSize: 14, lineHeight: 1.7, textAlign: 'center' }}>
          Mercado objetivo: todos los colombianos mayores de edad.
          <br />
          No solo afiliados. <strong>Todo el territorio nacional.</strong>
          <br />
          <span style={{ fontSize: 12, opacity: 0.75 }}>
            Solo 1% del TAM de afiliados (2.8M) equivale a $504M COP/mes en primas.
          </span>
        </div>
      </div>
    </div>
  );
}

/* ── Slide 9 — Equipo ──────────────────────────────────────────────────── */
const TEAM: [string, string, string, string][] = [
  ['JO', 'Juan Ospina', 'Administrador de Empresas', 'Estrategia & Pitch'],
  ['AL', 'Alejo', 'Ingeniero de Software', 'Tech Lead & Arquitecto'],
  ['MG', 'Maite Gómez', 'Especialista en Analítica', 'Datos & Propensión'],
  ['CG', 'Cristian Gómez', 'Ingeniero de Software', 'Desarrollo & Integraciones'],
  ['MP', 'María del Pilar', 'Economista', 'Mercado & Viabilidad'],
];

export function Slide9Equipo(_: SlideProps) {
  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%,-50%)',
        textAlign: 'center',
        width: '100%',
        maxWidth: 1100,
        padding: '0 32px',
      }}
    >
      <div style={{ fontSize: 20, fontWeight: 700, color: 'white', marginBottom: 32 }}>
        Equipo Asegura · Hackathon Colsubsidio × 30X · Julio 2026
      </div>
      <div style={{ display: 'flex', gap: 14, justifyContent: 'center' }}>
        {TEAM.map(([initials, name, role, tag]) => (
          <div key={name} style={{ flex: 1, maxWidth: 195, background: 'rgba(255,255,255,.05)', borderRadius: 12, padding: '22px 16px', textAlign: 'center' }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: '#FFD700',
                color: '#003087',
                fontSize: 15,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto',
              }}
            >
              {initials}
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'white', marginTop: 12 }}>{name}</div>
            <div style={{ fontSize: 11, color: 'rgba(255,215,0,.6)', marginTop: 4, lineHeight: 1.3 }}>{role}</div>
            <div
              style={{
                fontSize: 10,
                background: 'rgba(255,255,255,.08)',
                color: 'rgba(255,255,255,.7)',
                borderRadius: 4,
                padding: '3px 8px',
                marginTop: 10,
                display: 'inline-block',
              }}
            >
              {tag}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Slide 10 — Cierre ─────────────────────────────────────────────────── */
export function Slide10Cierre(_: SlideProps) {
  return (
    <>
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-52%)', textAlign: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 36 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 14 }}>
            <TangramLogo stroke="#001A4D" size={88} />
            <div style={{ fontSize: 72, fontWeight: 800, color: 'white', lineHeight: 1, letterSpacing: '-2.5px' }}>segura</div>
          </div>
          <div style={{ width: 520, maxWidth: '80vw', height: 1, background: 'rgba(255,255,255,.15)', marginBottom: 12 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'rgba(255,255,255,.45)' }}>
            <span>Seguros automatizados</span>
            <ColsubK size={12} />
            <span>Colsubsidio</span>
          </div>
        </div>
        <div style={{ fontSize: 28, fontWeight: 300, color: 'white', letterSpacing: '.3px', marginBottom: 48 }}>
          El seguro que nunca duerme.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <div style={{ background: 'white', padding: 16, borderRadius: 14, display: 'inline-block' }}>
            <img src="/qr-bot.svg" width={220} height={220} style={{ display: 'block' }} alt="QR Asegura Bot" />
          </div>
          <div style={{ fontSize: 13, color: '#FFD700' }}>t.me/asegura_bot</div>
        </div>
      </div>
      <div style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', fontSize: 10, color: 'rgba(255,255,255,.25)', whiteSpace: 'nowrap' }}>
        Hackathon Colsubsidio × 30X · Julio 2026
      </div>
    </>
  );
}
