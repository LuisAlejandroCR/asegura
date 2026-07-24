import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { AgentService } from './modules/agent/agent.service';
import { TelegramAdapter } from './modules/channel/telegram-adapter.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: [
            "'self'",
            config.get('SUPABASE_URL'),
            config.get('LLM_BASE_URL'),
          ].filter(Boolean),
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );

  const corsOrigins = config
    .get<string>('CORS_ORIGIN', '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: corsOrigins.length ? corsOrigins : false,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new GlobalExceptionFilter());

  const agent = app.get(AgentService);
  const telegram = app.get(TelegramAdapter);

  if (telegram.instance) {
    telegram.instance.on('message', async (ctx) => {
      await agent.handleMessage(ctx);
    });

    const host = config.get<string>('HOST', '');
    if (host) {
      const secret = config.getOrThrow<string>('TELEGRAM_WEBHOOK_SECRET');
      await telegram.setWebhook(`${host}/webhook/telegram`, secret);
    } else {
      telegram.instance.start();
      logger.log('Telegram bot started in polling mode');
    }
  }

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
  logger.log(`Asegura running on port ${port}`);
}

bootstrap().catch((err) => {
  // Without this, a throw anywhere in bootstrap() (e.g. a missing required env var
  // discovered deep in setup) becomes an unhandled promise rejection — silent on some
  // Node versions, fatal-but-uninformative on others. Log clearly and exit intentionally.
  new Logger('Bootstrap').error(`Fatal error during startup: ${err}`);
  process.exit(1);
});
