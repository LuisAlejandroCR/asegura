// telegram.js: one guarded surface over window.Telegram.WebApp for texto.html and voz.html.
// Every call here is version-gated and degrades to a no-op, because the same page is opened
// from a Telegram Mini App, from WhatsApp's in-app browser and from a plain desktop browser,
// and only the first of those renders any of the client chrome.

const tg = window.Telegram?.WebApp;

// A plain https link tapped inside Telegram lands in the in-app browser, which also defines
// window.Telegram but draws no MainButton and reports platform "unknown". Trusting it would
// hide our own pay bar in favour of a button nobody can see — no way left to pay.
export const enMiniApp = Boolean(tg && tg.platform && tg.platform !== 'unknown');

const desde = (version) => enMiniApp && tg.isVersionAtLeast?.(version) === true;

// Colsubsidio yellow, not themeParams.button_color: the pay button is the same object as the
// fixed bar outside Telegram and as the seal on the PDF. Black on yellow reads in both schemes.
const AMARILLO = '#ffd000';
const NEGRO = '#000000';

const sinMovimiento = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export function esquema() {
  return tg?.colorScheme === 'dark' ? 'dark' : 'light';
}

// Decoration only. initDataUnsafe is whatever the client chose to send; what the person may
// see is decided by the session token in the URL, validated server-side. Painting a first
// name from here is safe, gating anything on it is having no auth while believing you do.
export function usuario() {
  return enMiniApp ? (tg.initDataUnsafe?.user ?? null) : null;
}

// Returns true when the page really is running as a Mini App, so the caller can switch
// layout to the client's stable viewport. Safe to call when the SDK never loaded.
export function arrancar({ alCambiarTema, alEstabilizar } = {}) {
  if (!tg) return false;
  tg.ready();  // hides Telegram's placeholder at the first painted screen, not at last asset
  tg.expand(); // full available height instead of a half sheet the person has to drag open
  if (!enMiniApp) return false;

  document.documentElement.dataset.esquema = esquema();
  if (desde('6.1')) {
    tg.setHeaderColor('secondary_bg_color');
    tg.setBackgroundColor('secondary_bg_color');
  }
  if (desde('7.10')) tg.setBottomBarColor('bottom_bar_bg_color');
  // The transcript scrolls. Without this, dragging it down closes the app mid-conversation.
  if (desde('7.7')) tg.disableVerticalSwipes();

  tg.onEvent('themeChanged', () => {
    document.documentElement.dataset.esquema = esquema();
    alCambiarTema?.();
  });
  // viewportHeight updates continuously while the sheet is dragged and cannot keep up with a
  // finger; only the stable one is worth relaying out for.
  tg.onEvent('viewportChanged', (e) => { if (e?.isStateStable) alEstabilizar?.(); });
  if (desde('8.0')) {
    tg.onEvent('safeAreaChanged', () => alEstabilizar?.());
    tg.onEvent('contentSafeAreaChanged', () => alEstabilizar?.());
  }
  return true;
}

let alTocarPrincipal = null;

export const botonPrincipal = {
  // A Mini App opened from the attachment menu keeps this hidden until the first
  // interaction. By the time a checkout link exists the person has already talked to the
  // agent, so that case cannot leave them without a button.
  mostrar(texto, alTocar) {
    if (!enMiniApp) return false;
    const b = tg.MainButton;
    if (alTocarPrincipal) b.offClick(alTocarPrincipal);
    alTocarPrincipal = alTocar;
    b.setParams({ text: texto.slice(0, 64), color: AMARILLO, text_color: NEGRO });
    b.onClick(alTocar);
    b.hideProgress();
    b.show();
    return true;
  },
  // Any action that hits the network shows progress, or the person taps twice and the second
  // tap is a second charge. showProgress() without an argument also disables the button.
  progreso() { if (enMiniApp) tg.MainButton.showProgress(); },
  sinProgreso() { if (enMiniApp) tg.MainButton.hideProgress(); },
  ocultar() {
    if (!enMiniApp) return;
    if (alTocarPrincipal) { tg.MainButton.offClick(alTocarPrincipal); alTocarPrincipal = null; }
    tg.MainButton.hideProgress();
    tg.MainButton.hide();
  },
};

let alTocarAtras = null;

export const botonAtras = {
  mostrar(alTocar) {
    if (!desde('6.1')) return false;
    if (alTocarAtras) tg.BackButton.offClick(alTocarAtras);
    alTocarAtras = alTocar;
    tg.BackButton.onClick(alTocar);
    tg.BackButton.show();
    return true;
  },
  ocultar() {
    if (!desde('6.1')) return;
    if (alTocarAtras) { tg.BackButton.offClick(alTocarAtras); alTocarAtras = null; }
    tg.BackButton.hide();
  },
};

// Impact for physical-feeling events, notification for the outcome of a task. selectionChanged
// is deliberately not exposed: it belongs to a selection that MOVES, and every use it would
// get here would be on a plain tap, which is exactly the buzz that reads as noise.
const VIBRACION = { light: 10, medium: 18, heavy: 30, rigid: 14, soft: 8 };
const VIBRACION_AVISO = { success: [18, 50, 18, 50, 30], warning: [20, 60, 20], error: [40, 70, 40] };

// Outside a Mini App this falls back to navigator.vibrate, which is what the page did before
// and does nothing on iOS. Reduced motion silences only that path: the client's own haptics
// are not motion, and they are the whole accessibility win for someone who dimmed animation.
function vibrar(patron) {
  if (sinMovimiento()) return;
  try { navigator.vibrate?.(patron); } catch { /* unsupported: no-op */ }
}

export const haptico = {
  impacto(estilo = 'light') {
    if (desde('6.1')) tg.HapticFeedback.impactOccurred(estilo);
    else vibrar(VIBRACION[estilo] ?? 12);
  },
  aviso(tipo) {
    if (desde('6.1')) tg.HapticFeedback.notificationOccurred(tipo);
    else vibrar(VIBRACION_AVISO[tipo] ?? 20);
  },
};

// Resolves false when the client cannot draw its own dialog, so the caller shows an in-page
// notice instead of falling back to window.alert — which blocks the JS thread and looks like
// a website in a frame.
export function alerta(mensaje) {
  return new Promise((resolve) => {
    if (!desde('6.2')) { resolve(false); return; }
    try { tg.showAlert(mensaje, () => resolve(true)); } catch { resolve(false); }
  });
}

export function cerrarTeclado() { if (desde('9.1')) tg.hideKeyboard(); }

// On while a payment is pending: a swipe-down mid-purchase asks first instead of dropping it.
export function confirmarCierre(activo) {
  if (!desde('6.2')) return;
  if (activo) tg.enableClosingConfirmation();
  else tg.disableClosingConfirmation();
}

export function cerrar() { if (enMiniApp) tg.close(); }
