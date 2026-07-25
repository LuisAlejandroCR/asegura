import { useEffect, useRef, useState } from 'react';
import { TangramLogo } from './TangramLogo';

// Descending, tapering spiral: wide at the top (total addressable population)
// narrowing to a point (the moment of conversion), then forking into two real
// outcomes. Geometry is generated once at module load (pure math, cheap);
// only the camera transform and a handful of label opacities change per frame.

const SVG_W = 760;
const CX = 380;
const TOP_MARGIN = 70;
const SPIRAL_H = 1000;
const BIFURCATION_H = 180;
const CONTENT_H = TOP_MARGIN + SPIRAL_H + BIFURCATION_H;
// TURNS/ELLIPSE are coupled, not independent: the wobble term's rate of change
// (radius * ELLIPSE * TURNS * 2π) must stay below the steady per-turn descent rate
// (SPIRAL_H / TURNS), or the path's y literally reverses direction and the coil
// crosses itself (verified with a numeric dy/dt sweep — this exact combination
// keeps a ~30% safety margin at the widest point, t=0, where radius is largest).
const TURNS = 12;
const R_TOP = 140;
const R_BOTTOM = 8;
const ELLIPSE = 0.07;
const LABEL_GAP = 36;
const RIGHT_LABEL_X = CX + R_TOP + LABEL_GAP;
const LEFT_LABEL_X = CX - R_TOP - LABEL_GAP;

const ZOOM_START = 0.84; // eased-progress point where descent stops and the zoom begins
// The frozen camera centers here (fraction of spiral t), not at t=1 exactly — leaves
// headroom so the tip and the two final-outcome labels beside it are comfortably framed
// once the descent freezes and the zoom takes over.
const FINAL_FOCUS_T = 0.97;
const ZOOM_SCALE = 1.8;
// 2026-07-25 feedback: 10s read as "goes fast" — not enough time to actually read each
// step label as the camera passes it. Slowed to 16s, same proportions throughout (every
// phase — counter, descent, zoom — is a fraction of this, so they all scale together).
const DURATION_MS = 14000;
const COUNTER_END = 0.16; // fraction of progress during which "35M colombianos" finishes counting
const TARGET_POPULATION = 35000000;

// Mid-spiral steps only — "Paga fácil" moved to the end (FINAL_OUTCOMES below) as one of
// the two real bifurcated outcomes, not a step along the way.
const STEPS = [
  { icon: '🎙️', label: 'Escribe', sub: 'o habla', t: 0.1, side: 'right' as const },
  { icon: '🔒', label: 'Autoriza datos', sub: 'Ley 1581', t: 0.28, side: 'left' as const },
  { icon: '👤', label: 'El agente', sub: 'te perfila', t: 0.46, side: 'right' as const },
  { icon: '🎯', label: 'Recomienda', sub: 'con razón', t: 0.64, side: 'left' as const },
];

// The two real outcomes at the narrow end of the funnel: convert (pay) or stay a
// qualified lead for follow-up. No connecting fork lines — just the tip, then these two
// labels beside it once the zoom reveals them.
const FINAL_OUTCOMES = {
  left: { icon: '🎯', label: 'Leads calificados', sub: 'seguimiento automático' },
  right: { icon: '💳', label: 'Paga fácil', sub: 'Asegura' },
};

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

const SPIRAL_PATH = buildSpiralPath(480);
const TIP = pointAt(1);
// Leads calificados branches off to the side — a real but separate outcome.
const LEFT_END = { x: TIP.x - 108, y: TIP.y + BIFURCATION_H };
// Paga fácil sits right at the coil's own terminal point (2026-07-25 feedback) — it's
// the main flow continuing, not a side branch, so it gets only a small nudge clear of
// the coil itself rather than the same offset as the branch.
const RIGHT_END = { x: TIP.x + 26, y: TIP.y + 34 };
// CSS scale() amplifies distance FROM the origin point — proportionally, not by a fixed
// amount. With origin=TIP, RIGHT_END (26,34 away) barely moved while LEFT_END (108,180
// away) drifted an extra ~140px at scale 1.8, sliding it out of frame (2026-07-25 bug
// report: "Leads calificados missing", confirmed via a standalone scale-math check).
// Anchoring the zoom on the midpoint between the two outcomes instead keeps both
// drifting symmetrically, regardless of how differently offset they are from the tip.
const ZOOM_ORIGIN = { x: (LEFT_END.x + RIGHT_END.x) / 2, y: (LEFT_END.y + RIGHT_END.y) / 2 };
const DOTS = Array.from({ length: 72 }, (_, i) => pointAt(i / 71));

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
  const focusY = TOP_MARGIN + descentP * FINAL_FOCUS_T * SPIRAL_H;
  const maxTranslate = Math.max(CONTENT_H - viewportH, 0);
  const translateY = -Math.min(Math.max(focusY - viewportH / 2, 0), maxTranslate);

  const zoomP = eased <= ZOOM_START ? 0 : (eased - ZOOM_START) / (1 - ZOOM_START);
  const scale = 1 + (ZOOM_SCALE - 1) * zoomP;
  // transform-origin is specified in the element's own LOCAL (untransformed) coordinate
  // space, not screen space — CSS applies it as translate(origin) · transform-list ·
  // translate(-origin), so adding translateY here (a bug: mixing screen-space and local-
  // space coordinates) shifted the zoom's actual center away from the tip by however much
  // the camera had already scrolled, landing the zoom on the wrong point entirely.
  // Origin is ZOOM_ORIGIN (the outcomes' midpoint), not TIP — see its definition above.
  const originX = ZOOM_ORIGIN.x;
  const originY = ZOOM_ORIGIN.y;

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
            const targetX = s.side === 'right' ? RIGHT_LABEL_X - 8 : LEFT_LABEL_X + 8;
            return (
              <line
                key={s.label}
                x1={p.x}
                y1={p.y}
                x2={targetX}
                y2={p.y}
                stroke="rgba(255,215,0,.35)"
                strokeWidth={1.5}
                opacity={eased >= s.t * ZOOM_START - 0.015 ? 1 : 0}
              />
            );
          })}
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
          const isRight = s.side === 'right';
          return (
            <div
              key={s.label}
              style={{
                position: 'absolute',
                left: isRight ? RIGHT_LABEL_X : LEFT_LABEL_X,
                top: pos.y,
                transform: `translate(${isRight ? '0' : '-100%'}, -50%)`,
                textAlign: isRight ? 'left' : 'right',
                opacity: visible ? 1 : 0,
                transition: 'opacity .6s ease',
                whiteSpace: 'nowrap',
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 700, color: 'white' }}>
                {s.icon} {s.label}
              </div>
              <div style={{ fontSize: 11, color: 'rgba(255,215,0,.65)' }}>{s.sub}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3, justifyContent: isRight ? 'flex-start' : 'flex-end' }}>
                {isRight && <TangramLogo stroke="#001A4D" size={12} />}
                <span style={{ fontSize: 9, color: 'rgba(255,255,255,.4)' }}>Asegura</span>
                {!isRight && <TangramLogo stroke="#001A4D" size={12} />}
              </div>
            </div>
          );
        })}

        <div
          style={{
            position: 'absolute',
            left: LEFT_END.x,
            top: LEFT_END.y,
            transform: 'translate(-100%, -50%)',
            opacity: zoomP,
            transition: 'opacity .6s ease',
            textAlign: 'right',
            whiteSpace: 'nowrap',
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: 'white' }}>
            {FINAL_OUTCOMES.left.icon} {FINAL_OUTCOMES.left.label}
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,215,0,.7)' }}>{FINAL_OUTCOMES.left.sub}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3, justifyContent: 'flex-end' }}>
            <span style={{ fontSize: 9, color: 'rgba(255,255,255,.4)' }}>Asegura</span>
            <TangramLogo stroke="#001A4D" size={12} />
          </div>
        </div>
        <div
          style={{
            position: 'absolute',
            left: RIGHT_END.x,
            top: RIGHT_END.y,
            transform: 'translate(0, -50%)',
            opacity: zoomP,
            transition: 'opacity .6s ease',
            whiteSpace: 'nowrap',
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: 'white' }}>
            {FINAL_OUTCOMES.right.icon} {FINAL_OUTCOMES.right.label}
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,215,0,.7)' }}>{FINAL_OUTCOMES.right.sub}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3 }}>
            <TangramLogo stroke="#001A4D" size={12} />
            <span style={{ fontSize: 9, color: 'rgba(255,255,255,.4)' }}>Asegura</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default FunnelSpiral;
