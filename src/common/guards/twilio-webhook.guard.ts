// twilio-webhook.guard.ts: validates the X-Twilio-Signature header. Algorithm verified
// against Twilio's webhook-security docs (2026-08-12), hand-rolled (no SDK dependency,
// same lean-fetch convention as the rest of this codebase's external integrations):
// HMAC-SHA1(authToken, url + sorted-and-concatenated "key"+"value" pairs), base64-encoded.
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

@Injectable()
export class TwilioWebhookGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const authToken = this.config.get<string>('TWILIO_AUTH_TOKEN');

    // Same fail-closed philosophy as TelegramWebhookGuard: an unset/misconfigured
    // NODE_ENV must never silently accept unsigned requests.
    if (!authToken) {
      if (this.config.get('NODE_ENV') === 'development') return true;
      throw new UnauthorizedException('TWILIO_AUTH_TOKEN not configured');
    }

    const signature = request.headers['x-twilio-signature'];
    const publicUrl = this.config.get<string>('PUBLIC_URL', '');
    const url = `${publicUrl}/webhook/whatsapp`;

    if (typeof signature !== 'string' || !this.isValidSignature(authToken, url, request.body, signature)) {
      throw new UnauthorizedException('Invalid Twilio webhook signature');
    }
    return true;
  }

  private isValidSignature(authToken: string, url: string, params: Record<string, unknown>, signature: string): boolean {
    // MUST include every received parameter, not a hardcoded subset — Twilio's own docs
    // warn new params can be added without notice, and a partial set here would make
    // every real request fail signature validation the moment Twilio adds one.
    const sorted = Object.keys(params ?? {})
      .sort()
      .reduce((acc, key) => acc + key + String(params[key]), '');
    const expected = createHmac('sha1', authToken).update(url + sorted).digest('base64');

    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(signature);
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  }
}
