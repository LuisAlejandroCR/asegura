// health.controller.ts: GET /health — pings the database and reports which optional
// integrations are configured.
import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../database/supabase.service';

// Railway polls this and kills the deploy on failure: a 429 here reads as a dead app.
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async check() {
    const dbOk = await this.pingDb();
    return {
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'error',
      llm: (this.config.get('LLM_API_KEY') || this.config.get('LLM_BASE_URL')) ? 'configured' : 'pending',
      telegram: this.config.get('TELEGRAM_BOT_TOKEN') ? 'configured' : 'pending',
      wompi: this.config.get('WOMPI_PUBLIC_KEY') ? 'configured' : 'pending',
      timestamp: new Date().toISOString(),
    };
  }

  private async pingDb(): Promise<boolean> {
    try {
      // The SDK returns an error object (no throw) for table-not-found; only network errors throw.
      await this.supabase.db.from('conversations').select('id').limit(1);
      return true;
    } catch {
      return false;
    }
  }
}
