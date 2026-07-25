import { useEffect, useState } from 'react';
import { BrandHeader } from './TangramLogo';
import type { SlideProps } from './slides';
import {
  Slide0Hook,
  Slide1Problema,
  Slide2Solucion,
  Slide3Flujo,
  Slide4Categorias,
  Slide5SuperAgente,
  Slide6Explora,
  Slide7Demo,
  Slide8Impacto,
  Slide9Equipo,
  Slide10Cierre,
} from './slides';

interface SlideDef {
  Component: (props: SlideProps) => JSX.Element;
  dark: boolean;
  bg: string;
}

const SLIDES: SlideDef[] = [
  { Component: Slide0Hook, dark: true, bg: '#001A4D' },
  { Component: Slide1Problema, dark: true, bg: '#001A4D' },
  { Component: Slide2Solucion, dark: false, bg: '#FFFFFF' },
  { Component: Slide3Flujo, dark: true, bg: '#001A4D' },
  { Component: Slide4Categorias, dark: false, bg: '#FFFFFF' },
  { Component: Slide5SuperAgente, dark: true, bg: '#001A4D' },
  { Component: Slide6Explora, dark: false, bg: '#FFFFFF' },
  { Component: Slide7Demo, dark: true, bg: '#000D1A' },
  { Component: Slide8Impacto, dark: false, bg: '#FFFFFF' },
  { Component: Slide9Equipo, dark: true, bg: '#001A4D' },
  { Component: Slide10Cierre, dark: true, bg: '#001A4D' },
];

const TOTAL = SLIDES.length;

function PitchDeck() {
  const [cur, setCur] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') setCur((c) => Math.min(c + 1, TOTAL - 1));
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') setCur((c) => Math.max(c - 1, 0));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const dark = SLIDES[cur].dark;
  const navBg = dark ? 'rgba(255,255,255,.25)' : 'rgba(0,48,135,.15)';
  const navColor = dark ? 'white' : '#003087';

  return (
    <>
      <div id="progress-bar" style={{ width: `${((cur + 1) / TOTAL) * 100}%` }} />
      <div id="slide-counter" style={{ color: dark ? 'rgba(255,255,255,.5)' : 'rgba(0,48,135,.5)' }}>
        {cur + 1} / {TOTAL}
      </div>
      <button
        id="btn-prev"
        className="nav-btn"
        style={{ background: navBg, color: navColor }}
        onClick={() => setCur((c) => Math.max(c - 1, 0))}
        aria-label="Diapositiva anterior"
      >
        ‹
      </button>
      <button
        id="btn-next"
        className="nav-btn"
        style={{ background: navBg, color: navColor }}
        onClick={() => setCur((c) => Math.min(c + 1, TOTAL - 1))}
        aria-label="Siguiente diapositiva"
      >
        ›
      </button>

      {SLIDES.map(({ Component, dark: isDark, bg }, i) => (
        <div className={`slide${i === cur ? ' active' : ''}`} style={{ background: bg }} key={i}>
          <BrandHeader dark={isDark} />
          <Component active={i === cur} />
        </div>
      ))}
    </>
  );
}

export default PitchDeck;
