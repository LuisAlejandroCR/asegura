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

export function validate(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    Logger.error(`Config validation failed:\n${errors.toString()}`);
    process.exit(1);
  }
  return validated;
}

export type { EnvironmentVariables };