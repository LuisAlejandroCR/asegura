// web-session-token.service.ts: mints and verifies short-lived tokens that let a browser
// (AseguraWeb — texto.html/voz.html) act on an EXISTING Telegram/WhatsApp conversation
// without a new login step. HMAC-signed, same pattern as wompi.service.ts's webhook
// signature check (createHmac + timingSafeEqual) — no new dependency (no JWT library).
// Same optional-integration contract as LiveKitTokenService: disabled without a crash
// when JWT_SECRET is unset.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

interface WebSessionPayload {
  conversationId: string;
}

interface SignedPayload extends WebSessionPayload {
  exp: number;
}

// Long enough for a full discovery→quote→data-capture→Wompi-checkout session (checkout
// alone can take several minutes on a slow connection), short enough that a token leaked
// via browser history/referrer isn't useful for long — same reasoning as
// LiveKitTokenService.TOKEN_TTL_SECONDS and Wompi's PAYMENT_LINK_EXPIRY_MINUTES.
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
