import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { createOpenApiDocument } from './openapi';

async function exportOpenApi(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });

  try {
    const document = createOpenApiDocument(app);
    if (
      !document.openapi.startsWith('3.') ||
      typeof document.paths !== 'object'
    ) {
      throw new Error('Generated document is not a valid OpenAPI 3 document.');
    }

    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { version: string };
    if (document.info.version !== packageJson.version) {
      throw new Error(
        'OpenAPI info.version does not match package.json version.',
      );
    }

    const outputDirectory = join(process.cwd(), 'dist');
    const outputPath = join(outputDirectory, 'openapi.json');
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
    process.stdout.write(`OpenAPI document exported to ${outputPath}\n`);
  } finally {
    await app.close();
  }
}

void exportOpenApi();
