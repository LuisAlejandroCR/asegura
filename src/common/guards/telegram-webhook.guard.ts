// telegram-webhook.guard.ts: validates x-telegram-bot-api-secret-token header
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class TelegramWebhookGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const secret = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET');

    // Allow without secret in development (log warning)
    if (!secret) {
      if (this.config.get('NODE_ENV') !== 'production') return true;
      throw new UnauthorizedException('TELEGRAM_WEBHOOK_SECRET not configured');
    }

    const token = request.headers['x-telegram-bot-api-secret-token'];
    if (token !== secret) throw new UnauthorizedException('Invalid webhook signature');
    return true;
  }
}
