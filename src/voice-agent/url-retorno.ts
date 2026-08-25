// url-retorno.ts: the URL Wompi sends the browser back to when checkout ends — approved,
// rejected or out of funds alike. Lives here, and not in the tools, because the tools
// contract is a plain object shared with the state machine and must not learn about
// ConfigService. Undefined when the session or the config cannot produce a usable link:
// a checkout with no way back is bad, one that returns to a 401 is worse.
import { ConfigService } from '@nestjs/config';
import { WebSessionTokenService } from '../modules/agent/web-session-token.service';

// WebSessionTokenService reads exactly one key. A shim over the env we were handed keeps the
// whole function drivable from a test, which `new ConfigService()` — it reads process.env and
// ignores its argument — does not.
function configDe(env: NodeJS.ProcessEnv): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

export function construirUrlDeRetorno(
  conversationId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const base = env.WEB_APP_URL;
  if (!base || !conversationId) return undefined;

  // A fresh token on purpose: the one that opened the call may be minutes from expiring by
  // the time the person finishes typing a card number.
  const token = new WebSessionTokenService(configDe(env)).sign({ conversationId });
  if (!token) return undefined;

  return `${base.replace(/\/$/, '')}/voz.html?token=${token}`;
}
