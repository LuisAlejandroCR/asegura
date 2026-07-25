// Tangram A: 7 pieces, matches the official Asegura logo (logo.jpeg) exactly.
// stroke = the slide's background color, so pieces read as separated tiles
// via a background-colored grout line rather than a contrasting outline.
const PIECE_POINTS = [
  '110,4 58,56 162,56',
  '4,60 110,60 4,140',
  '110,60 168,60 110,116 52,116',
  '168,60 216,60 216,116 168,116',
  '216,60 216,140 110,60',
  '4,144 110,144 4,236',
  '216,144 216,236 110,144',
];

const CATEGORY_COLORS = ['#FFD700', '#FFB300', '#FF8F00', '#FF6F00', '#FFA000', '#FFD700', '#FFCA28'];
const CATEGORY_TITLES = ['Vida', 'Accidentes', 'Salud', 'Familiar', 'Hogar', 'Vehículos', 'Empresas'];

interface TangramLogoProps {
  stroke: string;
  size?: number;
  colorful?: boolean;
}

export function TangramLogo({ stroke, size = 28, colorful = false }: TangramLogoProps) {
  const width = size;
  const height = Math.round((size * 240) / 220);
  const strokeWidth = colorful ? 4 : 3;

  return (
    <svg viewBox="0 0 220 240" width={width} height={height} style={{ display: 'block', flexShrink: 0 }}>
      {PIECE_POINTS.map((points, i) => (
        <polygon
          key={i}
          className="piece"
          points={points}
          fill={colorful ? CATEGORY_COLORS[i] : '#FFD700'}
          stroke={stroke}
          strokeWidth={strokeWidth}
        >
          {colorful && <title>{CATEGORY_TITLES[i]}</title>}
        </polygon>
      ))}
    </svg>
  );
}

export function ColsubK({ size = 8 }: { size?: number }) {
  const width = size;
  const height = Math.round((size * 28) / 20);
  return (
    <svg viewBox="0 0 20 28" width={width} height={height} style={{ display: 'block', flexShrink: 0 }}>
      <polygon points="0,0 12,8 12,20 0,28 0,18 6,14 0,10" fill="#FFD700" />
      <rect x="12" y="6" width="8" height="7" fill="#FFD700" />
      <rect x="12" y="15" width="8" height="7" fill="#FFD700" />
    </svg>
  );
}

export function BrandHeader({ dark }: { dark: boolean }) {
  const stroke = dark ? '#001A4D' : '#FFFFFF';
  const textColor = dark ? 'white' : '#003087';
  const subColor = dark ? 'rgba(255,255,255,.55)' : 'rgba(0,48,135,.55)';

  return (
    <div style={{ position: 'absolute', top: 24, left: 24, zIndex: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <TangramLogo stroke={stroke} size={26} />
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: textColor, lineHeight: 1, letterSpacing: '-.3px' }}>
            segura
          </div>
          <div
            style={{
              fontSize: 8,
              color: subColor,
              marginTop: 2,
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              whiteSpace: 'nowrap',
            }}
          >
            <span>Seguros automatizados</span>
            <ColsubK size={8} />
            <span>Colsubsidio</span>
          </div>
        </div>
      </div>
    </div>
  );
}
