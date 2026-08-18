// progress-bar.js: the shared stage rail for texto.html and voz.html — always visible, so
// it answers "¿cuánto falta?" without a pop-up. Renders from the {step, totalSteps, label}
// the backend returns and never invents its own stage list.

const sinMovimiento = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// Short haptic tick. Shared so both pages feel the same; silently absent on desktop.
export function tick(patron = 12) {
  if (sinMovimiento()) return;
  try { navigator.vibrate?.(patron); } catch { /* unsupported: no-op */ }
}

export function renderProgress(el, { step, totalSteps, label }) {
  const total = Math.max(totalSteps, 1);
  const actual = Math.min(Math.max(step, 1), total);
// Fill runs node-center to node-center, so stage 1 is 0% and the last is 100% — step/total
// would leave the final node visually unfinished at "¡Listo!".
  const pct = total > 1 ? ((actual - 1) / (total - 1)) * 100 : 100;

  const previo = Number(el.dataset.step || 0);
  const avanzo = previo > 0 && actual > previo;

  el.setAttribute('role', 'progressbar');
  el.setAttribute('aria-valuenow', String(actual));
  el.setAttribute('aria-valuemin', '1');
  el.setAttribute('aria-valuemax', String(total));
  el.setAttribute('aria-valuetext', `${label} — etapa ${actual} de ${total}`);

  const nodos = Array.from({ length: total }, (_, i) => {
    const n = i + 1;
    const estado = n < actual ? 'hecho' : n === actual ? 'actual' : 'pendiente';
    const marca = n < actual
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>'
      : String(n);
    return `<li class="ap-nodo ${estado}${avanzo && n === actual ? ' ap-subio' : ''}">${marca}</li>`;
  }).join('');

  el.innerHTML = `
    <div class="ap-rail">
      <div class="ap-track"><div class="ap-fill" style="width:${pct}%"></div></div>
      <ol class="ap-nodos">${nodos}</ol>
    </div>
    <p class="ap-label"><b>Etapa ${actual} de ${total}</b> · ${label}</p>
  `;

  el.dataset.step = String(actual);
  if (avanzo) tick([10, 40, 18]);
  return avanzo;
}

// Injected once per page instead of duplicated in both HTML files' <style> blocks.
export function injectProgressStyles() {
  if (document.getElementById('ap-progress-styles')) return;
  const style = document.createElement('style');
  style.id = 'ap-progress-styles';
  style.textContent = `
    .ap-progress{width:100%;max-width:420px;margin:0 auto;padding:8px 6px 0}
    .ap-rail{position:relative;height:24px}
    .ap-track{position:absolute;left:11px;right:11px;top:50%;height:4px;margin-top:-2px;
      border-radius:2px;background:var(--gris-claro,#f2f2f2);overflow:hidden}
    .ap-fill{height:100%;border-radius:2px;
      background:linear-gradient(90deg,var(--amarillo,#ffd000),var(--azul,#0067b1));
      transition:width .55s cubic-bezier(.32,.72,0,1)}
    .ap-nodos{position:relative;display:flex;justify-content:space-between;
      align-items:center;height:100%;list-style:none;margin:0;padding:0}
    .ap-nodo{display:flex;align-items:center;justify-content:center;
      width:22px;height:22px;border-radius:50%;flex:none;
      font-size:11px;font-weight:800;font-variant-numeric:tabular-nums;
      background:var(--blanco,#fff);border:2px solid var(--gris-claro,#f2f2f2);
      color:var(--gris,#575756);transition:transform .3s cubic-bezier(.2,.9,.3,1.4),
      background .3s ease,border-color .3s ease,color .3s ease}
    .ap-nodo svg{width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:4;
      stroke-linecap:round;stroke-linejoin:round}
    .ap-nodo.hecho{background:var(--amarillo,#ffd000);border-color:var(--amarillo,#ffd000);
      color:var(--negro,#000)}
    .ap-nodo.actual{background:var(--azul,#0067b1);border-color:var(--azul,#0067b1);
      color:var(--blanco,#fff);transform:scale(1.18);
      box-shadow:0 0 0 4px rgba(0,103,177,.16)}
    /* Latido del nodo activo: la única animación que corre siempre. Dice "es tu turno". */
    .ap-nodo.actual::after{content:"";position:absolute;width:22px;height:22px;
      border-radius:50%;border:2px solid var(--azul,#0067b1);
      animation:ap-latido 2.2s ease-out infinite}
    @keyframes ap-latido{0%{opacity:.55;transform:scale(1)}70%,100%{opacity:0;transform:scale(2)}}
    .ap-nodo.ap-subio{animation:ap-pop .5s cubic-bezier(.2,.9,.3,1.5)}
    @keyframes ap-pop{0%{transform:scale(1)}45%{transform:scale(1.75)}100%{transform:scale(1.18)}}
    .ap-label{margin-top:7px;font-size:11.5px;font-weight:600;color:var(--gris,#575756);
      text-align:center;letter-spacing:.01em}
    .ap-label b{color:var(--azul,#0067b1);font-weight:800}
    @media (prefers-reduced-motion:reduce){
      .ap-fill{transition:none}
      .ap-nodo{transition:none}
      .ap-nodo.actual::after{animation:none;opacity:0}
      .ap-nodo.ap-subio{animation:none}
    }
  `;
  document.head.appendChild(style);
}
