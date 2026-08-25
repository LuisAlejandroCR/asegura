// env.validation.ts: startup validation of every env var. A missing required var, or a
// half-configured group, exits the process here instead of failing at the first request.
import { plainToInstance } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, validateSync } from 'class-validator';
import { Logger } from '@nestjs/common';
import * as fs from 'fs';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

class EnvironmentVariables {
  @IsEnum(Environment)
  @IsNotEmpty()
  NODE_ENV!: Environment;

  @IsNumber()
  @IsOptional()
  PORT: number = 3000;

  @IsString()
  @IsNotEmpty()
  CORS_ORIGIN!: string;

  @IsString()
  @IsNotEmpty()
  SUPABASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  SUPABASE_SERVICE_ROLE_KEY!: string;

  @IsString()
  @IsOptional()
  LLM_BASE_URL!: string;

  @IsString()
  @IsOptional()
  LLM_API_KEY!: string;

  @IsString()
  @IsOptional()
  LLM_MODEL!: string;

  @IsString()
  @IsOptional()
  PUBLIC_URL!: string;

  @IsString()
  @IsOptional()
  TELEGRAM_BOT_TOKEN!: string;

  @IsString()
  @IsOptional()
  TELEGRAM_WEBHOOK_SECRET!: string;

  @IsString()
  @IsOptional()
  WHATSAPP_PHONE_NUMBER_ID!: string;

  @IsString()
  @IsOptional()
  WHATSAPP_ACCESS_TOKEN!: string;

  // Signs every inbound webhook. Separate from the access token: it is the Meta *app*
  // secret, not the phone number's token.
  @IsString()
  @IsOptional()
  WHATSAPP_APP_SECRET!: string;

  // Echoed back to Meta on the one-time subscription handshake. Any string, chosen by us.
  @IsString()
  @IsOptional()
  WHATSAPP_VERIFY_TOKEN!: string;

  // Graph API version. Unset falls back to the one the adapter's contract was read against.
  @IsString()
  @IsOptional()
  WHATSAPP_GRAPH_VERSION!: string;

  // The dialable number behind WHATSAPP_PHONE_NUMBER_ID, used only to build the wa.me link
  // that returns someone from AseguraWeb to the chat. Unset: the link is simply not offered.
  @IsString()
  @IsOptional()
  WHATSAPP_DISPLAY_NUMBER!: string;

  @IsString()
  @IsOptional()
  LIVEKIT_URL!: string;

  @IsString()
  @IsOptional()
  LIVEKIT_API_KEY!: string;

  @IsString()
  @IsOptional()
  LIVEKIT_API_SECRET!: string;

  @IsString()
  @IsOptional()
  ELEVENLABS_API_KEY!: string;

  @IsString()
  @IsOptional()
  ELEVENLABS_VOICE_ID!: string;

  @IsString()
  @IsOptional()
  WOMPI_ENVIRONMENT!: string;

  @IsString()
  @IsOptional()
  WOMPI_PRIVATE_KEY!: string;

  @IsString()
  @IsOptional()
  WOMPI_EVENTS_SECRET!: string;

  @IsString()
  @IsOptional()
  JWT_SECRET!: string;

  // AseguraWeb's own base URL (apps/web). Unset: the chat never offers the web link.
  @IsString()
  @IsOptional()
  WEB_APP_URL!: string;

  // 'llm' routes the text channel through ToolRouterService instead of the state machine.
  // Anything else, including unset, keeps the deterministic path.
  @IsString()
  @IsOptional()
  AGENT_ROUTER!: string;

  @IsString()
  @IsOptional()
  ADMIN_CHAT_ID!: string;

  // Path to the synthetic affiliate CSV. Missing file: the lookup disables itself at boot.
  @IsString()
  @IsOptional()
  AFFILIATE_CSV_PATH!: string;
}

// Groups that must be configured all-or-nothing. Each key is @IsOptional() on its own, so a
// partial group (a typo'd name in Railway) used to boot fine and fail at the first request.
const ALL_OR_NOTHING_GROUPS: { label: string; keys: (keyof EnvironmentVariables)[] }[] = [
  // WHATSAPP_GRAPH_VERSION is deliberately out of the group: it has a working default, so
  // setting it alone is not a half-configured integration.
  {
    label: 'Meta WhatsApp',
    keys: ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'],
  },
  { label: 'LiveKit', keys: ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] },
  { label: 'ElevenLabs', keys: ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'] },
  { label: 'Wompi', keys: ['WOMPI_ENVIRONMENT', 'WOMPI_PRIVATE_KEY', 'WOMPI_EVENTS_SECRET'] },
];

function crossFieldErrors(validated: EnvironmentVariables): string[] {
  const errors: string[] = [];
  for (const group of ALL_OR_NOTHING_GROUPS) {
    const set = group.keys.filter((key) => !!validated[key]);
    if (set.length > 0 && set.length < group.keys.length) {
      const missing = group.keys.filter((key) => !validated[key]);
      errors.push(`${group.label} config is partial — set all of [${group.keys.join(', ')}] or none. Missing: ${missing.join(', ')}`);
    }
  }

  // main.ts calls getOrThrow('TELEGRAM_WEBHOOK_SECRET') as soon as PUBLIC_URL is set, deep
  // inside bootstrap() — that throw killed the process before it ever bound to a port.
  if (validated.PUBLIC_URL && !validated.TELEGRAM_WEBHOOK_SECRET) {
    errors.push('PUBLIC_URL is set (webhook mode) but TELEGRAM_WEBHOOK_SECRET is missing — required to verify incoming Telegram requests.');
  }

  return errors;
}

export function validate(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  const groupErrors = crossFieldErrors(validated);

  if (errors.length > 0 || groupErrors.length > 0) {
    const detail = [...errors.map(String), ...groupErrors].join('\n');
    Logger.error(`Config validation failed:\n${detail}`);

    // Logger.error writes to stdout — a pipe in a container, so async — and the exit drops it.
    try {
      fs.writeSync(2, `Config validation failed:\n${detail}\n`);
    } catch {
      // fd 2 closed or redirected: nothing better to do, the exit stands.
    }
    process.exit(1);
  }
  return validated;
}

export type { EnvironmentVariables };
