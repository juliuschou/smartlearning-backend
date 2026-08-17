import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Mount the OpenAPI document and Swagger UI.
 *
 * Called after `configureApplication()` and before `app.listen()`/`app.init()`.
 *
 * Routing notes (verified against Nest RoutePathFactory behavior):
 * - The Swagger scanner honors the configured global prefix + URI versioning,
 *   so generated paths already appear as `/api/v1/...` (and health as
 *   `/health/...`). We therefore do NOT add a `/api/v1` server URL, which would
 *   cause generated clients/UI to concatenate the prefix twice.
 * - `useGlobalPrefix: true` mounts the docs routes under the global `/api`
 *   prefix, yielding `/api/docs` (UI) and `/api/docs-json` (raw JSON).
 * - `raw: ['json']` serves only the JSON document and avoids invoking js-yaml
 *   serialization. The js-yaml dependency is still pinned/overridden to a
 *   patched version for supply-chain/audit safety.
 * - The docs routes bypass `ApiResponseInterceptor` (it only wraps `/api/v1`),
 *   so the OpenAPI JSON is served raw rather than inside the success envelope.
 */
export function configureSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('SmartLearning backend API')
    .setDescription(
      'REST API for the SmartLearning interactive classroom platform. ' +
        'All `/api/v1/**` success and error responses are wrapped in a ' +
        'common envelope `{ data, meta: { schemaVersion, requestId }, error }`; ' +
        'read `data` for the payload and `error` for failures.',
    )
    .setVersion('1')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('docs', app, document, {
    useGlobalPrefix: true,
    jsonDocumentUrl: 'docs-json',
    raw: ['json'],
  });
}
