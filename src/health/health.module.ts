// health.module.ts: the GET /health endpoint used by Railway's deploy healthcheck.
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
})
export class HealthModule {}
