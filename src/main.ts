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

  // AseguraWeb (apps/web) corre en otro dominio (Vercel), así que TODA llamada de
  // texto.html/voz.html es cross-origin: si CORS_ORIGIN no lista ese origen exacto, el
  // navegador bloquea la respuesta y la UI solo puede mostrar "No se pudo conectar" —
  // sin nada en los logs del backend, porque la petición sí llegó y sí respondió.
  // Dejar el origen configurado (y el de WEB_APP_URL) visible al arrancar convierte ese
  // fallo mudo en una línea de log comparable de un vistazo.
  logger.log(`CORS origins: ${corsOrigins.length ? corsOrigins.join(', ') : '(ninguno — se rechaza todo origen cruzado)'}`);

  const webAppUrl = config.get<string>('WEB_APP_URL', '');
  if (webAppUrl && !corsOrigins.includes(new URL(webAppUrl).origin)) {
    logger.warn(
      `WEB_APP_URL (${webAppUrl}) no está en CORS_ORIGIN — texto.html y voz.html van a ` +
        'fallar con "No se pudo conectar" al llamar /web-session y /voice/session.',
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
  // 0.0.0.0 explícito: en un contenedor (Railway) el router externo entra por la IP del
  // contenedor, no por loopback. Dejarlo al default hace que un bind a 127.0.0.1 se vea
  // como "Application failed to respond" (502) con el proceso arriba y sin errores.
  await app.listen(port, '0.0.0.0');
  // RSS al ligar el puerto: el arranque carga el CSV de afiliados (500k filas) ANTES de
  // escuchar, así que este número es el pico real contra el límite del contenedor. Un
  // OOM del kernel es un SIGKILL: no hay excepción que atrapar ni línea que loguear, el
  // proceso simplemente desaparece. Tener el margen impreso en cada arranque es la única
  // forma de ver que se está acercando antes de que pase.
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

  // process.exit() NO vacía la escritura pendiente: cuando stdout es un pipe (siempre, en
  // un contenedor) los write son asíncronos, así que el exit inmediato descartaba el
  // mensaje de arriba. Efecto real en Railway: el deploy moría y en los logs no aparecía
  // NADA después de "Starting Container" — el propio handler de errores se comía la única
  // pista de por qué. Verificado: con process.exit(1) el "Fatal error during startup"
  // salía 0 de 1 veces.
  //
  // exitCode + salida natural deja que el event loop drene el buffer antes de terminar.
  // El timer unref'd no mantiene vivo el proceso (si no queda nada pendiente, Node sale
  // solo y nunca dispara); solo actúa si algo más dejó el loop colgado, para que un
  // arranque fallido no se quede colgado para siempre.
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 2000).unref();
});
