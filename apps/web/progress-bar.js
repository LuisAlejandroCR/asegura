// progress-bar.js: shared persistent progress indicator for AseguraWeb (texto.html and
// voz.html) — plan-17 §15 picked this over pop-ups as the highest-value "not just text"
// element to build first: it's ALWAYS visible (not a one-off moment) and directly attacks
// abandono by answering "¿cuánto falta?", the single biggest source of drop-off in long
// forms. Renders from the SAME {step, totalSteps, label} shape progressFor() (backend,
// conversation-state.machine.ts) returns — never invents its own stage list.
export function renderProgress(el, { step, totalSteps, label }) {
  const pct = totalSteps > 0 ? Math.round((step / totalSteps) * 100) : 0;

  el.setAttribute('role', 'progressbar');
  el.setAttribute('aria-valuenow', String(step));
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', String(totalSteps));
  el.setAttribute('aria-valuetext', `${label} — paso ${step} de ${totalSteps}`);

  el.innerHTML = `
    <div class="ap-track">
      <div class="ap-fill" style="width:${pct}%"></div>
    </div>
    <div class="ap-label">${label} · ${step}/${totalSteps}</div>
  `;
}

// Injected once per page — kept here instead of duplicated in both HTML files' <style>
// blocks. Uses the same --amarillo/--azul tokens voz.html's :root already defines.
export function injectProgressStyles() {
  if (document.getElementById('ap-progress-styles')) return;
  const style = document.createElement('style');
  style.id = 'ap-progress-styles';
  style.textContent = `
    .ap-progress{width:100%;max-width:460px;margin:0 auto;padding:4px 4px 0}
    .ap-track{height:6px;border-radius:3px;background:var(--gris-claro,#f2f2f2);overflow:hidden}
    .ap-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,var(--amarillo,#ffd000),var(--azul,#0067b1));transition:width .45s cubic-bezier(.32,.72,0,1)}
    .ap-label{margin-top:5px;font-size:11.5px;font-weight:600;color:var(--gris,#575756);text-align:center;letter-spacing:.01em;font-variant-numeric:tabular-nums}
    @media (prefers-reduced-motion:reduce){.ap-fill{transition:none}}
  `;
  document.head.appendChild(style);
}
