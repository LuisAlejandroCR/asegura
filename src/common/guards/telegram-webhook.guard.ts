// telegram-webhook.guard.ts: validates x-telegram-bot-api-secret-token header
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class TelegramWebhookGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const secret = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET');

    // Dev convenience bypass — opt-in only via the explicit 'development' value, never a
    // fallback like "anything that isn't 'production'". An unset/misconfigured NODE_ENV
    // (e.g. a staging deploy nobody flagged as 'production') must fail closed, not open.
    if (!secret) {
      if (this.config.get('NODE_ENV') === 'development') return true;
      throw new UnauthorizedException('TELEGRAM_WEBHOOK_SECRET not configured');
    }

    const token = request.headers['x-telegram-bot-api-secret-token'];
    if (typeof token !== 'string' || !this.secureCompare(token, secret)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    return true;
  }

  private secureCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
