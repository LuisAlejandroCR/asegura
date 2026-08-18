// health.controller.ts: GET /health — pings the database and reports which optional
// integrations are live, by asking each service instead of re-reading its env vars.
import { Controller, Get, Inject } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { SupabaseService } from '../database/supabase.service';
import { INlpProvider } from '../modules/nlp/types';
import { TelegramAdapter } from '../modules/channel/telegram-adapter.service';
import { WompiService } from '../modules/payments/wompi.service';
import { LiveKitTokenService } from '../modules/voice/livekit-token.service';
import { WebSessionTokenService } from '../modules/agent/web-session-token.service';

const state = (live: boolean) => (live ? 'configured' : 'pending');

// Railway polls this and kills the deploy on failure: a 429 here reads as a dead app.
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly supabase: SupabaseService,
    @Inject('INlpProvider') private readonly nlp: INlpProvider,
    private readonly telegram: TelegramAdapter,
    private readonly wompi: WompiService,
    private readonly liveKit: LiveKitTokenService,
    private readonly webSessionTokens: WebSessionTokenService,
  ) {}

  @Get()
  async check() {
    const dbOk = await this.pingDb();
    return {
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'error',
      llm: state(this.nlp.isEnabled),
      telegram: state(this.telegram.instance !== null),
      wompi: state(this.wompi.isEnabled),
      jwt: state(this.webSessionTokens.isEnabled),
      // LiveKit credentials only. Whether the voice worker is registered and answering is
      // not observable from this process — it is a separate Railway service.
      livekit: state(this.liveKit.isEnabled),
      timestamp: new Date().toISOString(),
    };
  }

  private async pingDb(): Promise<boolean> {
    try {
      // The SDK returns an error object instead of throwing for anything the server answered
      // (missing table, rejected key); only transport failures reach the catch.
      const { error } = await this.supabase.db.from('conversations').select('id').limit(1);
      return !error;
    } catch {
      return false;
    }
  }
}
