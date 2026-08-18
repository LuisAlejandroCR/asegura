// web-session-token.service.ts: mints and verifies short-lived HMAC tokens that let a
// browser act on an EXISTING Telegram/WhatsApp conversation without a new login step.
// Disabled, not fatal, when JWT_SECRET is unset.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

interface WebSessionPayload {
  conversationId: string;
}

interface SignedPayload extends WebSessionPayload {
  exp: number;
}

// Long enough for a full discovery→checkout session, short enough that a leaked token
// (browser history, referrer) stops being useful quickly.
const TOKEN_TTL_MS = 90 * 60 * 1000;

@Injectable()
export class WebSessionTokenService {
  private readonly logger = new Logger(WebSessionTokenService.name);
  private readonly secret: string;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.secret = config.get<string>('JWT_SECRET') ?? '';
    this.enabled = !!this.secret;
    if (!this.enabled) {
      this.logger.warn('JWT_SECRET not set — AseguraWeb session links disabled');
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private signature(payloadB64: string): string {
    return createHmac('sha256', this.secret).update(payloadB64).digest('hex');
  }

  sign(payload: WebSessionPayload): string | null {
    if (!this.enabled) return null;

    const signed: SignedPayload = { ...payload, exp: Date.now() + TOKEN_TTL_MS };
    const payloadB64 = Buffer.from(JSON.stringify(signed)).toString('base64url');
    return `${payloadB64}.${this.signature(payloadB64)}`;
  }

  verify(token: string): WebSessionPayload | null {
    if (!this.enabled || !token) return null;

    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payloadB64, sig] = parts;

    const expected = this.signature(payloadB64);
    const bufA = Buffer.from(expected);
    const bufB = Buffer.from(sig);
    if (bufA.length !== bufB.length || !timingSafeEqual(bufA, bufB)) return null;

    let decoded: SignedPayload;
    try {
      decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      return null;
    }

    if (typeof decoded.exp !== 'number' || Date.now() > decoded.exp) return null;
    if (typeof decoded.conversationId !== 'string' || !decoded.conversationId) return null;

    return { conversationId: decoded.conversationId };
  }
}
