// api-base.js: resolves the backend base URL for AseguraWeb (texto.html y voz.html).
//
// Por qué existe: VITE_API_URL se escribe a mano en el panel de Vercel, y el error más
// fácil de cometer ahí es pegar el host pelado ("asegura-web-production.up.railway.app")
// sin el esquema. Sin "https://" el navegador NO lo trata como dominio: lo resuelve como
// ruta relativa, así que fetch() termina pegándole a
// https://asegura-app.vercel.app/asegura-web-production.up.railway.app/web-session/… —
// un 404 del sitio estático que en la UI se ve idéntico a "backend caído".
// Normalizar aquí hace que ese typo deje de ser un bug silencioso.
export function resolveApiBase(raw) {
  const valor = (raw ?? '').trim();

  // Vacío = same-origin: lo correcto en local (vite dev + backend en el mismo host),
  // y en producción es la configuración que hay que arreglar, no un valor a inventar.
  if (!valor) return '';

  // "//host" (protocol-relative) y "https://host" ya son absolutos; "host/path" no.
  const conEsquema = /^[a-z][a-z0-9+.-]*:\/\//i.test(valor) || valor.startsWith('//');
  const absoluto = conEsquema ? valor : `https://${valor}`;

  // Trailing slash: los llamados concatenan `${API_URL}/web-session/...`, así que una
  // barra sobrante produce "//web-session" y Nest responde 404.
  return absoluto.replace(/\/+$/, '');
}

// Base ya normalizada — importar esto, no import.meta.env, desde las páginas.
export const API_URL = resolveApiBase(import.meta.env.VITE_API_URL);

// Same-origin en un dominio que no sirve la API (Vercel estático) es el modo de falla
// que produjo "No se pudo conectar" en producción: dejarlo visible en consola para que
// el siguiente que depure no tenga que descompilar el bundle para verlo.
if (!API_URL && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  console.warn(
    '[asegura] VITE_API_URL no está definida: las llamadas al backend irán a este mismo ' +
      'dominio, que solo sirve archivos estáticos. Defínela en Vercel como la URL ' +
      'completa del backend (con https://) y vuelve a desplegar.',
  );
}

// fetch() colapsa tres fallas muy distintas en el mismo TypeError sin cuerpo: DNS/backend
// caído, bloqueo de CORS, y mixed content. En la UI las tres se veían como "No se pudo
// conectar", sin forma de distinguirlas sin descompilar el bundle. apiFetch conserva el
// comportamiento (devuelve la Response tal cual, incluidos los 4xx/5xx) y solo enriquece
// el error de red con la causa probable y la URL real que se intentó.
export async function apiFetch(path, init) {
  const url = `${API_URL}${path}`;
  try {
    return await fetch(url, init);
  } catch (err) {
    const mismoOrigen = !API_URL || url.startsWith(location.origin);
    const causa = mismoOrigen
      ? 'VITE_API_URL apunta a este mismo dominio (estático), o falta por completo'
      : 'backend inalcanzable (caído/DNS) o CORS_ORIGIN del backend no incluye ' +
        location.origin;
    console.error(`[asegura] falló la llamada a ${url} — causa probable: ${causa}`, err);
    throw err;
  }
}
