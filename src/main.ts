import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { createOpenApiDocument } from './openapi';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
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
