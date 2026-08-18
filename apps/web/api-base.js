// api-base.js: resolves the backend base URL for texto.html and voz.html.
// VITE_API_URL is hand-typed in Vercel, and a bare host with no scheme is not absolute —
// fetch resolved it as a relative path and hit the static site instead.
export function resolveApiBase(raw) {
  const valor = (raw ?? '').trim();
  if (!valor) return ''; // same-origin: correct locally, the thing to fix in production
  const conEsquema = /^[a-z][a-z0-9+.-]*:\/\//i.test(valor) || valor.startsWith('//');
  // Trailing slash would produce "//web-session" — a 404 from Nest.
  return (conEsquema ? valor : `https://${valor}`).replace(/\/+$/, '');
}

export const API_URL = resolveApiBase(import.meta.env.VITE_API_URL);

if (!API_URL && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  console.warn(
    '[asegura] VITE_API_URL is unset: backend calls will hit this static domain. Set it in ' +
      'Vercel to the full backend URL (with https://) and redeploy.',
  );
}

// fetch collapses backend-down, CORS-blocked and same-origin-404 into one bodyless
// TypeError, so only the network error gains a likely cause here; 4xx/5xx still return.
export async function apiFetch(path, init) {
  const url = `${API_URL}${path}`;
  try {
    return await fetch(url, init);
  } catch (err) {
    const mismoOrigen = !API_URL || url.startsWith(location.origin);
    const causa = mismoOrigen
      ? 'VITE_API_URL points at this static domain, or is missing entirely'
      : `backend unreachable (down/DNS) or its CORS_ORIGIN excludes ${location.origin}`;
    console.error(`[asegura] request to ${url} failed — likely cause: ${causa}`, err);
    throw err;
  }
}
