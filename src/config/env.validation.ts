// env.validation.ts: strict startup validation — app won't start if required vars are missing
import { plainToInstance } from 'class-transformer';
import { IsEnum, IsNumber, IsOptional, IsString, validateSync } from 'class-validator';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

class EnvironmentVariables {
  // Sprint 0: core
  @IsEnum(Environment)
  NODE_ENV: Environment;

  @IsNumber()
  @IsOptional()
  PORT: number = 3000;

  @IsString()
  CORS_ORIGIN: string;

  @IsString()
  SUPABASE_URL: string;

  @IsString()
  SUPABASE_ANON_KEY: string;

  @IsString()
  SUPABASE_SERVICE_ROLE_KEY: string;

  // Sprint 1: LLM + Telegram
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

  // Sprint 5: Wompi
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

  // Sprint 6: Celo
  @IsString()
  @IsOptional()
  CELO_RPC_URL: string;

  @IsString()
  @IsOptional()
  OPERATOR_PRIVATE_KEY: string;

  @IsString()
  @IsOptional()
  POLICY_LEDGER_ADDRESS: string;

  // Sprint 2+
  @IsString()
  @IsOptional()
  JWT_SECRET: string;

  @IsString()
  @IsOptional()
  ADMIN_CHAT_ID: string;
}

export function validate(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    throw new Error(`Config validation failed:\n${errors.toString()}`);
  }
  return validated;
}

export type { EnvironmentVariables };
