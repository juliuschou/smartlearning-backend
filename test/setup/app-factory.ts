import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../../src/app.module';
import { configureApplication } from '../../src/bootstrap/configure-app';
import { configureSwagger } from '../../src/bootstrap/configure-swagger';

/**
 * Build a configured Nest application for e2e/integration tests, reusing the
 * production bootstrap so both paths stay identical (Backend NestJS 實作規劃
 * Phase 1: "e2e app factory 必須重用 production bootstrap").
 */
export async function createTestApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
  });
  await configureApplication(app);
  configureSwagger(app);
  return app;
}

export type { NestExpressApplication };
