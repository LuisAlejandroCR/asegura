import { useEffect, useRef, useState } from 'react';

interface CountUpProps {
  /** The exact string to display at rest, e.g. "3.2%", "$8.9B USD", "2.8M", "0". */
  value: string;
  durationMs?: number;
}

// Parses a leading numeric run out of a display string so it can be animated, while
// keeping every non-numeric character (%, $, B, M, USD, decimals) exactly as authored —
// this must never invent or round a figure differently than the source data.
function parseNumeric(value: string): { prefix: string; number: number; decimals: number; suffix: string } | null {
  const match = value.match(/^([^\d]*)([\d.]+)(.*)$/);
  if (!match) return null;
  const [, prefix, numStr, suffix] = match;
  const decimals = numStr.includes('.') ? numStr.split('.')[1].length : 0;
  const number = parseFloat(numStr);
  if (Number.isNaN(number)) return null;
  return { prefix, number, decimals, suffix };
}

function CountUp({ value, durationMs = 1400 }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(value);
  const parsed = parseNumeric(value);

  useEffect(() => {
    if (!parsed) return;
    const node = ref.current;
    if (!node) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      setDisplay(value);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        const start = performance.now();
        const tick = (now: number) => {
          const progress = Math.min((now - start) / durationMs, 1);
          // easeOutExpo — fast start, gentle settle, reads as "counting up" not "sliding"
          const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
          const current = parsed.number * eased;
          setDisplay(`${parsed.prefix}${current.toFixed(parsed.decimals)}${parsed.suffix}`);
          if (progress < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <span ref={ref} className="count-up">
      {display}
    </span>
  );
}

export default CountUp;
