import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DeletionManifestExporter } from '../src/modules/governance/application/deletion-manifest.exporter';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  try {
    const exporter = app.get(DeletionManifestExporter);
    console.log('export result:', JSON.stringify(await exporter.exportDueBatch(10)));
  } finally {
    await app.close();
  }
}
void main();
