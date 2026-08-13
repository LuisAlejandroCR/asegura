// main.ts: NestJS bootstrap — helmet, CORS, global validation and exception filter,
// then registers the Telegram webhook (or long-polling when PUBLIC_URL is unset).

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

  // AseguraWeb runs on another domain, so every call from texto.html/voz.html is
  // cross-origin. A CORS mismatch leaves no backend trace — the request arrives and is
  // answered, the browser just discards it — so log the configured origins at boot.
  logger.log(`CORS origins: ${corsOrigins.length ? corsOrigins.join(', ') : '(none — every cross-origin request is rejected)'}`);

  const webAppUrl = config.get<string>('WEB_APP_URL', '');
  if (webAppUrl && !corsOrigins.includes(new URL(webAppUrl).origin)) {
    logger.warn(
      `WEB_APP_URL (${webAppUrl}) is not in CORS_ORIGIN — texto.html and voz.html will ` +
        'fail on /web-session and /voice/session.',
    );
  }

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
      await agent.handleMessage(ctx, 'telegram');
    });

    const host = config.get<string>('PUBLIC_URL', '');
    if (host) {
      const secret = config.getOrThrow<string>('TELEGRAM_WEBHOOK_SECRET');
      await telegram.setWebhook(`${host}/webhook/telegram`, secret);
    } else {
      telegram.instance.start();
      logger.log('Telegram bot started in polling mode');
    }
  }

  const port = config.get<number>('PORT', 3000);
  // Explicit 0.0.0.0: in a container the external router reaches the container IP, not
  // loopback, and a 127.0.0.1 bind looks like a 502 with the process up and no errors.
  await app.listen(port, '0.0.0.0');
  // Boot loads the 500k-row affiliate CSV before listening, so this is the real peak
  // against the container limit. A kernel OOM is SIGKILL — nothing to catch or log —
  // so printing the headroom every boot is the only way to see it coming.
  const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  logger.log(`Asegura running on port ${port} (rss ${rssMb} MB)`);
}

bootstrap().catch((err) => {
  // Without this, a throw anywhere in bootstrap() (e.g. a missing required env var
  // discovered deep in setup) becomes an unhandled promise rejection — silent on some
  // Node versions, fatal-but-uninformative on others. Log clearly and exit intentionally.
  new Logger('Bootstrap').error(`Fatal error during startup: ${err}`);
  if (err instanceof Error && err.stack) {
    new Logger('Bootstrap').error(err.stack);
  }

  // process.exit() drops pending writes, and in a container stdout is a pipe (async), so
  // the line above was discarded 1 time out of 1 — the error handler ate its own message.
  // exitCode lets the loop drain; the unref'd timer only fires if something else hangs it.
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 2000).unref();
});
