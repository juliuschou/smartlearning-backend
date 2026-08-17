import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApplication } from './bootstrap/configure-app';
import { configureSwagger } from './bootstrap/configure-swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useLogger(app.get(Logger));

  // Shared setup for production + e2e (prefix, versioning, validation, error
  // envelope, helmet, cookies, CORS, shutdown hooks).
  configureApplication(app);

  // OpenAPI document + Swagger UI (/api/docs, /api/docs-json).
  configureSwagger(app);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);

  await app.listen(port);
  const logger = app.get(Logger);
  logger.log(`Application is running on port ${port}`);
}

void bootstrap();
