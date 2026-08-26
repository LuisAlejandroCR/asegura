// url-retorno.ts: the URL Wompi sends the browser back to when checkout ends — approved,
// rejected or out of funds alike. Lives here, and not in the tools, because the tools
// contract is a plain object shared with the state machine and must not learn about
// ConfigService. Undefined when the session or the config cannot produce a usable link:
// a checkout with no way back is bad, one that returns to a 401 is worse.
import { ConfigService } from '@nestjs/config';
import { WebSessionTokenService } from '../modules/agent/web-session-token.service';
import { urlDeRetorno, motivoSinUrlDeRetorno } from '../modules/agent/web-return-url';

// WebSessionTokenService reads exactly one key. A shim over the env we were handed keeps the
// whole function drivable from a test, which `new ConfigService()` — it reads process.env and
// ignores its argument — does not.
function configDe(env: NodeJS.ProcessEnv): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

// A fresh token on purpose: the one that opened the call may be minutes from expiring by the
// time the person finishes typing a card number.
function firmar(conversationId: string | undefined, env: NodeJS.ProcessEnv): string | null | undefined {
  if (!conversationId) return undefined;
  return new WebSessionTokenService(configDe(env)).sign({ conversationId });
}

export function construirUrlDeRetorno(
  conversationId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return urlDeRetorno(env.WEB_APP_URL, firmar(conversationId, env), 'voz');
}

// Lo mismo, pero contando en voz alta por qué no hay URL. El worker corre en un servicio de
// Railway aparte del backend, así que WEB_APP_URL o JWT_SECRET pueden faltar ahí y en ningún
// otro sitio: el link de pago salía sin vuelta y ni un log lo decía. Verificado contra la API
// de Wompi — `redirect_url: null` en un link creado por esta ruta.
export function urlDeRetornoConAviso(
  conversationId?: string,
  env: NodeJS.ProcessEnv = process.env,
  avisar: (mensaje: string) => void = (m) => console.warn('[asegura-voice] ' + m),
): string | undefined {
  const token = firmar(conversationId, env);
  const url = urlDeRetorno(env.WEB_APP_URL, token, 'voz');
  if (!url) {
    const motivo = motivoSinUrlDeRetorno(env.WEB_APP_URL, token, conversationId);
    if (motivo) avisar(motivo);
  }
  return url;
}
