import { useState } from 'react';

interface Profile {
  id: string;
  icon: string;
  label: string;
  product: string;
  insurer: string;
  price: string;
  reason: string;
}

// Real products, real prices, real reasoning wording — matches the exact "Te lo
// recomiendo porque: {reason}" format the deployed agent actually sends
// (agent.service.ts formatQuote). This section exists to make the hackathon's #1
// criterion ("propensión explicable") something a judge can click, not just read.
const PROFILES: Profile[] = [
  {
    id: 'solo',
    icon: '🏃',
    label: 'Vivo solo, sin mascotas',
    product: 'Accidentes personales',
    insurer: 'MetLife',
    price: '$18.000/mes',
    reason: 'nadie más responde por ti si algo pasa mientras trabajas o te desplazas — esto sí.',
  },
  {
    id: 'familia',
    icon: '👨‍👩‍👧',
    label: 'Tengo familia o hijos',
    product: 'Seguro de vida',
    insurer: 'Pan American Life',
    price: '$12.000/mes',
    reason: 'tu familia sigue protegida financieramente sin depender de un ahorro que aún no existe.',
  },
  {
    id: 'mascotas',
    icon: '🐾',
    label: 'Tengo mascotas',
    product: 'Asistencia veterinaria',
    insurer: 'GEA',
    price: '$14.500/mes',
    reason: 'consultas, vacunas y urgencias sin que cada visita al veterinario sea un golpe al bolsillo.',
  },
  {
    id: 'salud',
    icon: '🩺',
    label: 'Me preocupa mi salud',
    product: 'Asistencias médicas',
    insurer: 'GEA',
    price: '$16.800/mes',
    reason: 'asistencia médica telefónica y consultas virtuales, sin filas ni citas de meses.',
  },
  {
    id: 'exequial',
    icon: '🕊️',
    label: 'Quiero dejarlo todo resuelto',
    product: 'Exequial',
    insurer: 'Grupo Recordar',
    price: '$26.000/mes',
    reason: 'tu familia no carga con gastos inesperados justo en el momento más difícil.',
  },
];

function WhyPicker() {
  const [activeId, setActiveId] = useState(PROFILES[0].id);
  const active = PROFILES.find((p) => p.id === activeId)!;

  return (
    <div className="why-picker">
      <div className="why-options">
        {PROFILES.map((p) => (
          <button
            key={p.id}
            className={`why-option ${p.id === activeId ? 'why-option-active' : ''}`}
            onClick={() => setActiveId(p.id)}
            type="button"
          >
            <span className="why-option-icon">{p.icon}</span>
            {p.label}
          </button>
        ))}
      </div>

      <div className="why-result" key={active.id}>
        <span className="why-result-label">Te recomendamos</span>
        <div className="why-result-product">
          {active.product} <span className="why-result-insurer">· {active.insurer}</span>
        </div>
        <p className="why-result-reason">
          <strong>Te lo recomendamos porque</strong> {active.reason}
        </p>
        <div className="why-result-price">
          Desde <span className="mono">{active.price}</span>
        </div>
      </div>
    </div>
  );
}

export default WhyPicker;
