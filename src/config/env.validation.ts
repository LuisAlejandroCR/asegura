// env.validation.ts: strict startup validation — app won't boot if required env vars are missing
import { plainToInstance } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, validateSync } from 'class-validator';
import { Logger } from '@nestjs/common';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

class EnvironmentVariables {
  @IsEnum(Environment)
  @IsNotEmpty()
  NODE_ENV: Environment;

  @IsNumber()
  @IsOptional()
  PORT: number = 3000;

  @IsString()
  @IsNotEmpty()
  CORS_ORIGIN: string;

  @IsString()
  @IsNotEmpty()
  SUPABASE_URL: string;

  @IsString()
  @IsNotEmpty()
  SUPABASE_ANON_KEY: string;

  @IsString()
  @IsNotEmpty()
  SUPABASE_SERVICE_ROLE_KEY: string;

  @IsString()
  @IsOptional()
  LLM_PROVIDER: string;

  @IsString()
  @IsOptional()
  LLM_BASE_URL: string;

  @IsString()
  @IsOptional()
  LLM_API_KEY: string;

  @IsString()
  @IsOptional()
  LLM_MODEL: string;

  @IsString()
  @IsOptional()
  TELEGRAM_BOT_TOKEN: string;

  @IsString()
  @IsOptional()
  TELEGRAM_WEBHOOK_SECRET: string;

  @IsString()
  @IsOptional()
  WOMPI_ENVIRONMENT: string;

  @IsString()
  @IsOptional()
  WOMPI_PUBLIC_KEY: string;

  @IsString()
  @IsOptional()
  WOMPI_PRIVATE_KEY: string;

  @IsString()
  @IsOptional()
  WOMPI_EVENTS_SECRET: string;

  @IsString()
  @IsOptional()
  WOMPI_INTEGRITY_KEY: string;

  @IsString()
  @IsOptional()
  CELO_RPC_URL: string;

  @IsString()
  @IsOptional()
  OPERATOR_PRIVATE_KEY: string;

  @IsString()
  @IsOptional()
  POLICY_LEDGER_ADDRESS: string;

  @IsString()
  @IsOptional()
  JWT_SECRET: string;

  @IsString()
  @IsOptional()
  ADMIN_CHAT_ID: string;
}

// Groups of env vars that must be configured all-or-nothing. Each is independently
// @IsOptional() above so the feature can be entirely disabled, but a PARTIAL group (e.g.
// a typo'd Railway var name) used to boot successfully and only fail at the first real
// request, at runtime, instead of at startup where an operator would actually notice.
const ALL_OR_NOTHING_GROUPS: { label: string; keys: (keyof EnvironmentVariables)[] }[] = [
  { label: 'Wompi', keys: ['WOMPI_ENVIRONMENT', 'WOMPI_PRIVATE_KEY', 'WOMPI_EVENTS_SECRET'] },
  { label: 'Celo', keys: ['CELO_RPC_URL', 'OPERATOR_PRIVATE_KEY', 'POLICY_LEDGER_ADDRESS'] },
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
  return errors;
}

export function validate(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  const groupErrors = crossFieldErrors(validated);

  if (errors.length > 0 || groupErrors.length > 0) {
    Logger.error(`Config validation failed:\n${[...errors.map(String), ...groupErrors].join('\n')}`);
    process.exit(1);
  }
  return validated;
}

export type { EnvironmentVariables };