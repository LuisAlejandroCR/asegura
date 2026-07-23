// health.controller.ts: GET /health — verifies DB connectivity and service configuration
import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../database/supabase.service';

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
      llm: this.config.get('LLM_BASE_URL') ? 'configured' : 'pending',
      telegram: this.config.get('TELEGRAM_BOT_TOKEN') ? 'configured' : 'pending',
      wompi: this.config.get('WOMPI_PUBLIC_KEY') ? 'configured' : 'pending',
      celo: this.config.get('CELO_RPC_URL') ? 'configured' : 'pending',
      timestamp: new Date().toISOString(),
    };
  }

  private async pingDb(): Promise<boolean> {
    try {
      // Supabase SDK returns error object (no throw) for table-not-found;
      // network errors throw — so any response means the API is reachable.
      await this.supabase.db.from('conversations').select('id').limit(1);
      return true;
    } catch {
      return false;
    }
  }
}
