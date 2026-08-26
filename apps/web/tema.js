// tema.js: the theme switch shared by texto.html and voz.html. The colours themselves live in
// each page's stylesheet; this only decides WHICH set applies, remembers the choice, and draws
// the button.
//
// Precedence, highest first: what the person picked here → Telegram's themeParams → the
// system scheme. An explicit choice has to beat both, which is why the [data-tema] blocks are
// the last ones in the stylesheet and their values never reference --tg-theme-*.

const CLAVE = 'asegura-tema';

// localStorage throws outright in iOS private mode — reading the preference must never be the
// thing that stops the page from loading.
export function temaGuardado() {
  try {
    const v = localStorage.getItem(CLAVE);
    return v === 'dark' || v === 'light' ? v : null;
  } catch { return null; }
}

function guardar(tema) {
  try { localStorage.setItem(CLAVE, tema); } catch { /* sin persistencia: dura la sesión */ }
}

// What the person is actually looking at right now, whoever decided it.
export function temaEfectivo() {
  const raiz = document.documentElement;
  if (raiz.dataset.tema) return raiz.dataset.tema;          // elección explícita
  if (raiz.dataset.esquema) return raiz.dataset.esquema;    // themeParams de Telegram
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// The browser chrome colour is read from a single tag with no media query, so one value is
// always correct — two media-scoped tags would keep answering the system, not the choice.
function pintarBarraDelNavegador() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const fondo = getComputedStyle(document.body).backgroundColor;
  if (fondo && fondo !== 'rgba(0, 0, 0, 0)') meta.setAttribute('content', fondo);
}

const SOL =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/>' +
  '<line x1="12" y1="1.6" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22.4"/>' +
  '<line x1="4.2" y1="4.2" x2="5.9" y2="5.9"/><line x1="18.1" y1="18.1" x2="19.8" y2="19.8"/>' +
  '<line x1="1.6" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22.4" y2="12"/>' +
  '<line x1="4.2" y1="19.8" x2="5.9" y2="18.1"/><line x1="18.1" y1="5.9" x2="19.8" y2="4.2"/></svg>';

const LUNA =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

let boton = null;

export function refrescarBotonTema() {
  if (!boton) return;
  const oscuro = temaEfectivo() === 'dark';
  // El icono muestra el destino, no el estado: se toca para IR a lo que dibuja.
  boton.innerHTML = oscuro ? SOL : LUNA;
  boton.setAttribute('aria-label', oscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
  boton.setAttribute('title', boton.getAttribute('aria-label'));
  boton.setAttribute('aria-pressed', String(oscuro));
  pintarBarraDelNavegador();
}

// `alTocar` lets the page add its own haptic without this module importing telegram.js.
export function montarBotonTema({ alCambiar, alTocar } = {}) {
  inyectarEstilosTema();
  boton = document.createElement('button');
  boton.className = 'tema-boton';
  boton.type = 'button';
  boton.addEventListener('click', () => {
    const siguiente = temaEfectivo() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.tema = siguiente;
    guardar(siguiente);
    // Sin esto el cambio es un corte seco de pantalla completa. Solo durante el cruce: dejar
    // la transición puesta arrastraría cada burbuja y cada ficha que entra después.
    document.body.classList.add('cambiando-tema');
    setTimeout(() => document.body.classList.remove('cambiando-tema'), 260);
    refrescarBotonTema();
    alTocar?.();
    alCambiar?.(siguiente);
  });
  document.body.appendChild(boton);
  refrescarBotonTema();

  // El sistema puede cambiar de tema con la página abierta; mientras no haya elección
  // explícita, el icono tiene que seguirlo.
  window.matchMedia?.('(prefers-color-scheme: dark)')
    ?.addEventListener?.('change', () => { if (!temaGuardado()) refrescarBotonTema(); });

  return boton;
}

export function inyectarEstilosTema() {
  if (document.getElementById('tema-estilos')) return;
  const style = document.createElement('style');
  style.id = 'tema-estilos';
  style.textContent = `
    .tema-boton{
      position:fixed;
      top:calc(max(10px,env(safe-area-inset-top,0px)) + var(--seguro-arriba,0px));
      right:calc(12px + env(safe-area-inset-right,0px) + var(--seguro-der,0px));
      z-index:30;
      width:36px;height:36px;
      display:flex;align-items:center;justify-content:center;
      border:1px solid var(--gris-claro,#ece2d6);
      border-radius:50%;
      background:var(--carta,#fffcf7);
      color:var(--gris,#6f6259);
      cursor:pointer;
      box-shadow:var(--sombra-suave,0 2px 10px rgba(90,60,25,.07));
      transition:transform .14s cubic-bezier(.2,.9,.3,1.4),color .18s ease,border-color .18s ease;
    }
    .tema-boton:hover,.tema-boton:focus-visible{
      color:var(--azul-tinta,#0067b1);
      border-color:var(--azul-borde,rgba(0,103,177,.35));
    }
    .tema-boton:active{transform:scale(.88)}
    .tema-boton svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;
      stroke-linecap:round;stroke-linejoin:round}
    .cambiando-tema *{
      transition:background-color .22s ease,color .22s ease,border-color .22s ease!important;
    }
    @media (prefers-reduced-motion:reduce){
      .tema-boton{transition:none}
      .cambiando-tema *{transition:none!important}
    }
  `;
  document.head.appendChild(style);
}
