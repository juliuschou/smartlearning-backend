import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AuthConfig } from './auth/auth.config';
import { createOpenApiDocument } from './openapi';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const authConfig = app.get(AuthConfig, { strict: false });
  authConfig.assertSessionDurations();
  void authConfig.cookieSigningSecret;
  const allowedOrigins = authConfig.allowedOrigins;

  app.use(cookieParser());
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, false);
      return callback(null, allowedOrigins.has(origin) ? origin : false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  const openApiEnabled =
    process.env.OPENAPI_ENABLED === 'true' ||
    (process.env.OPENAPI_ENABLED !== 'false' &&
      process.env.NODE_ENV !== 'production');

  if (openApiEnabled) {
    const document = createOpenApiDocument(app);
    app.getHttpAdapter().get('/openapi.json', (_request, response) => {
      response.json(document);
    });
  }

  await app.listen(process.env.PORT ?? 3000);
}

if (require.main === module) {
  void bootstrap();
}
