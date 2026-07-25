import { useEffect, useRef, useState } from 'react';

const TARGET = 1621106;
const DURATION_MS = 1800;

function formatThousands(v: number): string {
  return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function AfiliadosCounter({ active }: { active: boolean }) {
  const startedRef = useRef(false);
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!active || startedRef.current) return;
    startedRef.current = true;

    const t0 = performance.now();
    let raf: number;
    const tick = (now: number) => {
      const p = Math.min((now - t0) / DURATION_MS, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(eased * TARGET));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <div
      style={{
        fontSize: 72,
        fontWeight: 800,
        color: '#FFD700',
        lineHeight: 1,
        letterSpacing: '-2px',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {formatThousands(value)}
    </div>
  );
}

export default AfiliadosCounter;
