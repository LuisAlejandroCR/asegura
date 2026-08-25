// meta-webhook.guard.ts: validates the X-Hub-Signature-256 header Meta puts on every
// WhatsApp Cloud API webhook — HMAC-SHA256(appSecret, rawBody), hex, prefixed "sha256=".
// Source: developers.facebook.com, Cloud API webhooks reference, read 2026-08-25.
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

// Nest populates rawBody only when the app is created with `rawBody: true` (see main.ts).
type RawBodyRequest = Request & { rawBody?: Buffer };

@Injectable()
export class MetaWebhookGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RawBodyRequest>();
    const appSecret = this.config.get<string>('WHATSAPP_APP_SECRET');

    // Fail closed: an unset NODE_ENV must never silently accept unsigned requests.
    if (!appSecret) {
      if (this.config.get('NODE_ENV') === 'development') return true;
      throw new UnauthorizedException('WHATSAPP_APP_SECRET not configured');
    }

    // Meta escapes non-ASCII as \uXXXX before signing, so re-serializing the parsed body
    // produces a different digest for any message with a tilde. Without the raw bytes the
    // signature cannot be checked at all, and guessing is worse than refusing.
    const rawBody = request.rawBody;
    if (!rawBody || rawBody.length === 0) {
      throw new UnauthorizedException('Raw body unavailable — cannot verify Meta signature');
    }

    const header = request.headers['x-hub-signature-256'];
    if (typeof header !== 'string' || !header.startsWith('sha256=')) {
      throw new UnauthorizedException('Missing or malformed X-Hub-Signature-256 header');
    }

    const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const actual = header.slice('sha256='.length);

    const expectedBuf = Buffer.from(expected, 'utf8');
    const actualBuf = Buffer.from(actual, 'utf8');
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      throw new UnauthorizedException('Invalid Meta webhook signature');
    }
    return true;
  }
}
