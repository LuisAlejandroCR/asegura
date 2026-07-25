import { useEffect, useRef, useState } from 'react';

// Word-by-word reveal timing mirrors the original deck exactly: each line starts
// at a fixed offset, words within a line stagger 80ms apart, and the payoff line
// ("Y el seguro... nunca se vende") fades in once all three lines have landed.
const LINES = [
  { text: '"Son las 10 de la noche."', start: 300 },
  { text: '"Juan quiere proteger a su familia."', start: 1200 },
  { text: '"El asesor no contesta."', start: 2500 },
];
const HOOK_DELAY = 4200;

function HookIntro({ active }: { active: boolean }) {
  const startedRef = useRef(false);
  const [revealed, setRevealed] = useState<number[]>(() => LINES.map(() => 0));
  const [hookVisible, setHookVisible] = useState(false);

  useEffect(() => {
    if (!active || startedRef.current) return;
    startedRef.current = true;

    const timers: ReturnType<typeof setTimeout>[] = [];
    LINES.forEach((line, li) => {
      const words = line.text.split(' ');
      words.forEach((_, wi) => {
        timers.push(
          setTimeout(() => {
            setRevealed((prev) => {
              const next = [...prev];
              next[li] = wi + 1;
              return next;
            });
          }, line.start + wi * 80),
        );
      });
    });
    timers.push(setTimeout(() => setHookVisible(true), HOOK_DELAY));

    return () => timers.forEach(clearTimeout);
  }, [active]);

  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%,-52%)',
        textAlign: 'center',
        width: '100%',
        maxWidth: 800,
        padding: '0 48px',
      }}
    >
      <div style={{ fontSize: 33, fontStyle: 'italic', color: 'white', lineHeight: 1.65, minHeight: 140 }}>
        {LINES.map((line, li) => {
          const words = line.text.split(' ');
          return (
            <p key={li} style={{ marginBottom: 4 }}>
              {words.map((w, wi) => (
                <span
                  key={wi}
                  style={{ opacity: wi < revealed[li] ? 1 : 0, display: 'inline', transition: 'opacity .35s ease' }}
                >
                  {w}
                  {wi < words.length - 1 ? ' ' : ''}
                </span>
              ))}
            </p>
          );
        })}
      </div>
      <div style={{ fontSize: 19, color: '#FFD700', marginTop: 28, opacity: hookVisible ? 1 : 0, transition: 'opacity .9s ease' }}>
        "Y el seguro... nunca se vende."
      </div>
    </div>
  );
}

export default HookIntro;
