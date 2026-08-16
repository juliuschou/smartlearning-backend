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

export const API_PREFIX = 'api';
export const API_VERSION = 'v1';

/**
 * Configure the Nest application identically for production and tests.
 * Extracted so `main.ts` and the e2e app factory share one setup path
 * (Backend NestJS 實作規劃 Phase 1: configureApplication).
 *
 * Call this after `NestFactory.create()` and before `app.listen()`/`app.init()`.
 */
export function configureApplication(app: INestApplication): void {
  const expressApp = app as NestExpressApplication;
  const configService = app.get(ConfigService);

  // Global prefix + URI versioning → /api/v1/...
  expressApp.setGlobalPrefix(API_PREFIX, {
    exclude: ['health/(.*)'],
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
  const origins =
    corsOrigin === '*'
      ? true
      : corsOrigin
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

  // Graceful shutdown: SIGTERM/SIGINT trigger module destroy hooks (Prisma disconnect).
  expressApp.enableShutdownHooks();
}

/** Re-exported for the e2e factory so it imports AppModule from one place. */
export { AppModule, PINO_REDACT_PATHS, PINO_REDACT_REMOVE };
