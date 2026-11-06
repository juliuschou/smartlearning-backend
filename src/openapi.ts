import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('SmartLearning Backend API')
    .setDescription(
      'OpenAPI contract for the SmartLearning backend. The frontend project is responsible for generating and maintaining its API caller code.',
    )
    .setVersion('0.0.1')
    .build();

  return SwaggerModule.createDocument(app, config);
}
