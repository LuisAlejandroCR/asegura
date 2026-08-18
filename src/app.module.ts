// app.module.ts: NestJS root module — wires config validation, throttling and every
// feature module (agent, channel, quoting, policy, payments, database, health).

import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validate } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { AgentModule } from './modules/agent/agent.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { VoiceModule } from './modules/voice/voice.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
    }),
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 100 },
    ]),
    DatabaseModule,
    HealthModule,
    AgentModule,
    PaymentsModule,
    VoiceModule,
  ],
  providers: [
    // Importing ThrottlerModule only registers the storage; without this binding no request
    // is ever counted. Buckets are per-IP, which needs `trust proxy` set in main.ts.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
