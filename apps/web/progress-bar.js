// progress-bar.js: the shared stage rail for texto.html and voz.html — always visible, so
// it answers "¿cuánto falta?" without a pop-up. Renders from the {step, totalSteps, label}
// the backend returns and never invents its own stage list.

const sinMovimiento = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// Short haptic tick. Shared so both pages feel the same; silently absent on desktop.
// Inside a Telegram Mini App the client's own engine is the one that feels native — and on
// iOS navigator.vibrate does nothing at all, so it is the only haptic that lands there.
export function tick(patron = 12) {
  const tg = window.Telegram?.WebApp;
  if (tg?.platform && tg.platform !== 'unknown' && tg.isVersionAtLeast?.('6.1')) {
    tg.HapticFeedback.impactOccurred(Array.isArray(patron) ? 'medium' : 'light');
    return;
  }
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

  // Sin números. Un "2 de 6" en pantalla es el idioma de un formulario por pasos, y la barra
  // ya contesta "¿cuánto falta?" sin pedirle a nadie que cuente. La cifra exacta sigue estando
  // donde de verdad hace falta: en el aria-valuetext de arriba, para quien lee con voz.
  const nodos = Array.from({ length: total }, (_, i) => {
    const n = i + 1;
    const estado = n < actual ? 'hecho' : n === actual ? 'actual' : 'pendiente';
    const marca = n < actual
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>'
      : '';
    return `<li class="ap-nodo ${estado}${avanzo && n === actual ? ' ap-subio' : ''}">${marca}</li>`;
  }).join('');

  el.innerHTML = `
    <div class="ap-rail">
      <div class="ap-track"><div class="ap-fill" style="width:${pct}%"></div></div>
      <ol class="ap-nodos">${nodos}</ol>
    </div>
    <p class="ap-label">${label}</p>
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
    /* La caja mide 22px en los tres estados —el track se alinea a su centro— y lo que cambia
       es la escala. Un punto pendiente de 12px reales descuadraría los extremos del riel. */
    .ap-nodo{display:flex;align-items:center;justify-content:center;
      width:22px;height:22px;border-radius:50%;flex:none;
      background:var(--carta,#fffcf7);border:2px solid var(--gris-claro,#ece2d6);
      color:var(--gris,#6f6259);transform:scale(.58);
      transition:transform .34s cubic-bezier(.2,.9,.3,1.4),
      background .3s ease,border-color .3s ease,color .3s ease}
    .ap-nodo svg{width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:4;
      stroke-linecap:round;stroke-linejoin:round}
    .ap-nodo.hecho{background:var(--amarillo,#ffd000);border-color:var(--amarillo,#ffd000);
      color:var(--negro,#000);transform:scale(1)}
    .ap-nodo.actual{background:var(--azul,#0067b1);border-color:var(--azul,#0067b1);
      color:var(--blanco,#fff);transform:scale(1.18);
      box-shadow:0 0 0 4px rgba(0,103,177,.16)}
    /* Latido del nodo activo: la única animación que corre siempre. Dice "es tu turno". */
    .ap-nodo.actual::after{content:"";position:absolute;width:22px;height:22px;
      border-radius:50%;border:2px solid var(--azul,#0067b1);
      animation:ap-latido 2.2s ease-out infinite}
    @keyframes ap-latido{0%{opacity:.55;transform:scale(1)}70%,100%{opacity:0;transform:scale(2)}}
    .ap-nodo.ap-subio{animation:ap-pop .5s cubic-bezier(.2,.9,.3,1.5)}
    @keyframes ap-pop{0%{transform:scale(.58)}45%{transform:scale(1.75)}100%{transform:scale(1.18)}}
    /* El nombre de la etapa, no su número: "Cotización", no "Etapa 3 de 6". */
    .ap-label{margin-top:8px;font-size:11px;font-weight:800;color:var(--azul-tinta,#0067b1);
      text-align:center;letter-spacing:.1em;text-transform:uppercase}
    @media (prefers-reduced-motion:reduce){
      .ap-fill{transition:none}
      .ap-nodo{transition:none}
      .ap-nodo.actual::after{animation:none;opacity:0}
      .ap-nodo.ap-subio{animation:none}
    }
  `;
  document.head.appendChild(style);
}
