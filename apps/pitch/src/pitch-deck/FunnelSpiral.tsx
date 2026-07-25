import { useEffect, useRef, useState } from 'react';
import { TangramLogo } from './TangramLogo';

// Descending, tapering spiral: wide at the top (total addressable population)
// narrowing to a point (the moment of conversion), then forking into two real
// outcomes. Geometry is generated once at module load (pure math, cheap);
// only the camera transform and a handful of label opacities change per frame.

const SVG_W = 760;
const CX = 260;
const TOP_MARGIN = 70;
const SPIRAL_H = 1900;
const BIFURCATION_H = 230;
const CONTENT_H = TOP_MARGIN + SPIRAL_H + BIFURCATION_H;
const TURNS = 5.2;
const R_TOP = 190;
const R_BOTTOM = 12;
const ELLIPSE = 0.38;
const LABEL_X = CX + R_TOP + 50;

const ZOOM_START = 0.84; // eased-progress point where descent stops and the zoom begins
const ZOOM_SCALE = 1.8;
const DURATION_MS = 10000;
const COUNTER_END = 0.16; // fraction of progress during which "35M colombianos" finishes counting
const TARGET_POPULATION = 35000000;

const STEPS = [
  { icon: '🎙️', label: 'Escribe', sub: 'o habla', t: 0.1 },
  { icon: '🔒', label: 'Autoriza datos', sub: 'Ley 1581', t: 0.28 },
  { icon: '👤', label: 'El agente', sub: 'te perfila', t: 0.46 },
  { icon: '🎯', label: 'Recomienda', sub: 'con razón', t: 0.64 },
  { icon: '💳', label: 'Paga fácil', sub: 'Asegura', t: 0.82 },
];

function pointAt(t: number) {
  const angle = t * TURNS * Math.PI * 2;
  const easedT = Math.pow(t, 0.85);
  const radius = R_TOP + (R_BOTTOM - R_TOP) * easedT;
  const x = CX + radius * Math.cos(angle);
  const y = TOP_MARGIN + t * SPIRAL_H + radius * Math.sin(angle) * ELLIPSE;
  return { x, y, radius };
}

function buildSpiralPath(samples: number): string {
  const pts: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const { x, y } = pointAt(t);
    pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(' ');
}

function formatThousands(v: number): string {
  return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function smoothstep(p: number): number {
  return p * p * (3 - 2 * p);
}

const SPIRAL_PATH = buildSpiralPath(420);
const TIP = pointAt(1);
const LEFT_END = { x: TIP.x - 108, y: TIP.y + BIFURCATION_H };
const RIGHT_END = { x: TIP.x + 108, y: TIP.y + BIFURCATION_H };
const DOTS = Array.from({ length: 58 }, (_, i) => pointAt(i / 57));

interface FunnelSpiralProps {
  active: boolean;
}

function FunnelSpiral({ active }: FunnelSpiralProps) {
  const startedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const [viewportH, setViewportH] = useState(560);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const measure = () => setViewportH(node.clientHeight || 560);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  useEffect(() => {
    if (!active || startedRef.current) return;
    startedRef.current = true;
    const t0 = performance.now();
    let raf: number;
    const tick = (now: number) => {
      const p = Math.min((now - t0) / DURATION_MS, 1);
      setProgress(p);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  const eased = smoothstep(progress);
  const descentP = Math.min(eased, ZOOM_START) / ZOOM_START;
  const focusY = TOP_MARGIN + descentP * SPIRAL_H;
  const maxTranslate = Math.max(CONTENT_H - viewportH, 0);
  const translateY = -Math.min(Math.max(focusY - viewportH / 2, 0), maxTranslate);

  const zoomP = eased <= ZOOM_START ? 0 : (eased - ZOOM_START) / (1 - ZOOM_START);
  const scale = 1 + (ZOOM_SCALE - 1) * zoomP;
  const originX = TIP.x;
  const originY = TIP.y + translateY;

  const counterP = Math.min(progress / COUNTER_END, 1);
  const counterEase = 1 - Math.pow(1 - counterP, 3);
  const counterValue = TARGET_POPULATION * counterEase;

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: 0,
          width: SVG_W,
          height: CONTENT_H,
          marginLeft: -SVG_W / 2,
          transform: `translateY(${translateY}px) scale(${scale})`,
          transformOrigin: `${originX}px ${originY}px`,
        }}
      >
        <svg width={SVG_W} height={CONTENT_H} style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible' }}>
          <defs>
            <filter id="spiralShadow" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="2" stdDeviation="4" floodColor="#000" floodOpacity="0.35" />
            </filter>
          </defs>
          <path d={SPIRAL_PATH} fill="none" stroke="#F3EEE3" strokeWidth={16} strokeLinecap="round" filter="url(#spiralShadow)" />
          <path d={SPIRAL_PATH} fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth={5} strokeLinecap="round" />
          {DOTS.map((d, i) => (
            <circle key={i} cx={d.x} cy={d.y} r={4.2} fill="#FF7A1A" />
          ))}
          {STEPS.map((s) => {
            const p = pointAt(s.t);
            return <line key={s.label} x1={p.x} y1={p.y} x2={LABEL_X - 8} y2={p.y} stroke="rgba(255,215,0,.35)" strokeWidth={1.5} opacity={eased >= s.t * ZOOM_START - 0.015 ? 1 : 0} />;
          })}
          <path d={`M${TIP.x},${TIP.y} L${LEFT_END.x},${LEFT_END.y}`} fill="none" stroke="#F3EEE3" strokeWidth={10} strokeLinecap="round" opacity={zoomP} />
          <path d={`M${TIP.x},${TIP.y} L${RIGHT_END.x},${RIGHT_END.y}`} fill="none" stroke="#F3EEE3" strokeWidth={10} strokeLinecap="round" opacity={zoomP} />
          <circle cx={LEFT_END.x} cy={LEFT_END.y} r={7} fill="#FFD700" opacity={zoomP} />
          <circle cx={RIGHT_END.x} cy={RIGHT_END.y} r={7} fill="#FFD700" opacity={zoomP} />
        </svg>

        <div
          style={{
            position: 'absolute',
            left: CX,
            top: TOP_MARGIN - 54,
            transform: 'translateX(-50%)',
            textAlign: 'center',
            width: 280,
            background: 'rgba(0,26,77,.55)',
            borderRadius: 12,
            padding: '6px 14px',
          }}
        >
          <div style={{ fontSize: 32, fontWeight: 800, color: '#FFD700', fontVariantNumeric: 'tabular-nums', letterSpacing: '-1px' }}>
            {formatThousands(counterValue)}
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,.6)', marginTop: 2 }}>colombianos, mercado total</div>
        </div>

        {STEPS.map((s) => {
          const pos = pointAt(s.t);
          const visible = eased >= s.t * ZOOM_START - 0.015;
          return (
            <div
              key={s.label}
              style={{
                position: 'absolute',
                left: LABEL_X,
                top: pos.y,
                transform: 'translateY(-50%)',
                opacity: visible ? 1 : 0,
                transition: 'opacity .6s ease',
                whiteSpace: 'nowrap',
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 700, color: 'white' }}>
                {s.icon} {s.label}
              </div>
              <div style={{ fontSize: 11, color: 'rgba(255,215,0,.65)' }}>{s.sub}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3 }}>
                <TangramLogo stroke="#001A4D" size={12} />
                <span style={{ fontSize: 9, color: 'rgba(255,255,255,.4)' }}>Asegura</span>
              </div>
            </div>
          );
        })}

        <div
          style={{
            position: 'absolute',
            left: LEFT_END.x,
            top: LEFT_END.y,
            transform: 'translate(-100%, 0)',
            opacity: zoomP,
            transition: 'opacity .6s ease',
            textAlign: 'right',
            width: 190,
            paddingRight: 10,
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: 'white' }}>📄 PDF + QR</div>
          <div style={{ fontSize: 11, color: 'rgba(255,215,0,.7)' }}>al instante</div>
        </div>
        <div
          style={{
            position: 'absolute',
            left: RIGHT_END.x,
            top: RIGHT_END.y,
            opacity: zoomP,
            transition: 'opacity .6s ease',
            width: 190,
            paddingLeft: 10,
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: 'white' }}>🎯 Leads calificados</div>
          <div style={{ fontSize: 11, color: 'rgba(255,215,0,.7)' }}>seguimiento automático</div>
        </div>
      </div>
    </div>
  );
}

export default FunnelSpiral;
