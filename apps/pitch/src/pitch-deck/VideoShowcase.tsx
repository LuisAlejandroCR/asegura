// Real screen recordings of the deployed agent (not stock/placeholder footage) —
// same 8 clips used in the old scrolling pitch page's "Cómo funciona" grid.
export const DEMO_STEPS = [
  { file: 'paso-0-necesito', label: '"No sé qué necesito"' },
  { file: 'paso-1-saludo', label: 'Saludo' },
  { file: 'paso-2-cuentanos', label: 'Cuéntanos' },
  { file: 'paso-3-cotizacion', label: 'Cotización' },
  { file: 'paso-4-identidad', label: 'Identidad' },
  { file: 'paso-5-mascotas', label: 'Tus mascotas' },
  { file: 'paso-6-pago', label: 'Pago (sandbox)' },
  { file: 'paso-7-poliza', label: 'Póliza lista' },
];

interface VideoShowcaseProps {
  step: number;
  /** Only mount (and autoplay) the real <video> once this slide has actually been shown —
   * otherwise all 8 clips would start decoding/looping in the background from page load. */
  active: boolean;
}

function VideoShowcase({ step, active }: VideoShowcaseProps) {
  const current = DEMO_STEPS[step];

  return (
    <div
      style={{
        flex: 1,
        aspectRatio: '9/16',
        maxHeight: '72vh',
        background: '#0A1A2E',
        borderRadius: 16,
        border: '1.5px solid rgba(255,215,0,.2)',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {active ? (
        <video
          key={current.file}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          src={`/${current.file}.mp4`}
          autoPlay
          loop
          muted
          playsInline
        />
      ) : (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: 'rgba(255,215,0,.15)',
              border: '2px solid #FFD700',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div
              style={{
                width: 0,
                height: 0,
                borderStyle: 'solid',
                borderWidth: '12px 0 12px 22px',
                borderColor: 'transparent transparent transparent #FFD700',
                marginLeft: 4,
              }}
            />
          </div>
        </div>
      )}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          background: 'linear-gradient(transparent, rgba(0,0,0,.75))',
          padding: '24px 14px 12px',
          color: '#FFD700',
          fontSize: 12,
          fontWeight: 700,
          textAlign: 'center',
        }}
      >
        {step + 1}. {current.label}
      </div>
    </div>
  );
}

export function VideoStepPicker({ step, onSelect }: { step: number; onSelect: (n: number) => void }) {
  return (
    <div className="video-steps">
      {DEMO_STEPS.map((s, i) => (
        <button
          key={s.file}
          type="button"
          className={`video-step-btn${i === step ? ' active' : ''}`}
          onClick={() => onSelect(i)}
          aria-label={s.label}
        >
          {i}
        </button>
      ))}
    </div>
  );
}

export default VideoShowcase;
