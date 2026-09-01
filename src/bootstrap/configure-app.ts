import { VersioningType, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  ApiResponseInterceptor,
  GlobalExceptionFilter,
  validationExceptionFactory,
} from '../common/http';
import { PINO_REDACT_PATHS, PINO_REDACT_REMOVE } from '../common/observability';
import { AppModule } from '../app.module';
import { configureWebSocket } from './configure-websocket';
import { RateLimiterService } from '../modules/rate-limit/rate-limiter.service';
import { LiveSessionPublisher } from '../modules/realtime/live-session-publisher';
import { ApplicationLifecycleService } from '../common/lifecycle';

export const API_PREFIX = 'api';
export const API_VERSION = 'v1';

/**
 * Configure the Nest application identically for production and tests.
 * Extracted so `main.ts` and the e2e app factory share one setup path
 * (Backend NestJS 實作規劃 Phase 1: configureApplication).
 *
 * Call this after `NestFactory.create()` and before `app.listen()`/`app.init()`.
 */
export async function configureApplication(
  app: INestApplication,
): Promise<void> {
  const expressApp = app as NestExpressApplication;
  const configService = app.get(ConfigService);

  // Trust only the explicitly configured reverse-proxy hop. The proxy fixture
  // overwrites forwarded headers; direct backend access is not a public path.
  const trustProxyHops = configService.get<number>('TRUST_PROXY_HOPS', 0);
  expressApp.set('trust proxy', trustProxyHops);

  // Global prefix + URI versioning → /api/v1/...
  expressApp.setGlobalPrefix(API_PREFIX, {
    exclude: ['health/(.*)', 'metrics'],
  });
  expressApp.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: API_VERSION,
  });

  // Security headers + cookie parsing.
  expressApp.use(helmet());
  expressApp.use(cookieParser(configService.get<string>('COOKIE_SECRET')));

  // CORS — explicit origin allowlist from env; dev allows the configured origin.
  const corsOrigin = configService.get<string>('CORS_ORIGIN') ?? '';
  const origins = corsOrigin
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  expressApp.enableCors({
    origin: origins,
    credentials: true,
  });

  // Request ID stamping is registered in AppModule.configure() via the Nest
  // middleware consumer (DI-friendly); here we only register filters/middleware
  // that need the express instance directly.

  // Global validation — whitelist + forbid unknown, transform DTOs.
  expressApp.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );

  // Global response/error envelopes.
  expressApp.useGlobalInterceptors(new ApiResponseInterceptor());
  expressApp.useGlobalFilters(new GlobalExceptionFilter());

  // Login limiting uses a separate Redis command client when production mode
  // requires it. Initial failure is intentionally non-fatal; readiness and
  // login requests fail closed until bounded reconnect succeeds.
  await app.get(RateLimiterService).initialize();

  // Socket.IO adapter for the durable /live namespace. Bound here so production
  // and the e2e app factory share one websocket setup path.
  await configureWebSocket(expressApp);

  // Graceful shutdown: fence new requests before module destroy hooks, close
  // live sockets with a retryable signal, and drain the durable publisher first.
  const lifecycle = app.get(ApplicationLifecycleService);
  lifecycle.registerShutdownDrain(() =>
    app.get(LiveSessionPublisher).onModuleDestroy(),
  );
  expressApp.enableShutdownHooks();
}

/** Re-exported for the e2e factory so it imports AppModule from one place. */
export { AppModule, PINO_REDACT_PATHS, PINO_REDACT_REMOVE };
