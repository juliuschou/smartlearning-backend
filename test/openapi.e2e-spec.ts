import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup/app-factory';

jest.setTimeout(30_000);

describe('OpenAPI document (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/docs-json → 200 with an OpenAPI document', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json');
    expect(res.status).toBe(200);
    // Raw OpenAPI JSON is NOT wrapped in the success envelope.
    expect(res.body).not.toHaveProperty('data');
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.info.title).toBe('SmartLearning backend API');
  });

  it('exposes /api/v1 courses paths without double prefixing', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json');
    const paths = Object.keys(res.body.paths);
    expect(paths).toContain('/api/v1/courses');
    expect(paths).toContain('/api/v1/courses/{courseId}/enrollments');
    expect(paths).toContain(
      '/api/v1/courses/{courseId}/enrollments/{studentAccountId}',
    );
    expect(paths).toContain('/api/v1/me/courses');
    // US-F8/F16 admin account list/detail/permission contract.
    expect(paths).toContain('/api/v1/admin/accounts');
    expect(paths).toContain('/api/v1/admin/accounts/{id}');
    expect(paths).toContain('/api/v1/admin/accounts/{id}/permissions');
    // BE-8.2 CP2 — account profile update + mustChangePassword gate.
    expect(paths).toContain(
      '/api/v1/admin/accounts/{id}/require-password-change',
    );
    expect(paths).toContain(
      '/api/v1/admin/accounts/{id}/cli-credentials/{credentialId}/rotate',
    );
    // Health routes stay outside /api/v1 per the global-prefix exclusion.
    expect(paths).toContain('/health/live');
    expect(paths).toContain('/health/ready');
    // No accidental /api/api/v1 double prefix.
    expect(paths.some((p) => p.startsWith('/api/api/'))).toBe(false);

    const roster = res.body.paths['/api/v1/courses/{courseId}/enrollments'];
    expect(roster.get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'courseId',
          in: 'path',
          required: true,
        }),
        expect.objectContaining({
          name: 'page',
          in: 'query',
          schema: expect.objectContaining({ minimum: 1 }),
        }),
        expect.objectContaining({
          name: 'pageSize',
          in: 'query',
          schema: expect.objectContaining({ minimum: 1, maximum: 100 }),
        }),
      ]),
    );
    expect(
      roster.post.requestBody.content['application/json'].schema.$ref,
    ).toContain('CreateEnrollmentDto');
    expect(
      roster.post.responses['201'].content['application/json'].schema.$ref,
    ).toContain('EnrollmentDto');
    expect(roster.post.responses['409'].description).toMatch(/Archived course/);

    const courses = res.body.paths['/api/v1/courses'];
    for (const operation of [courses.get, courses.post]) {
      expect(operation.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'X-CLI-Key',
            in: 'header',
            required: false,
          }),
        ]),
      );
    }
    expect(courses.get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'page', in: 'query' }),
        expect.objectContaining({
          name: 'pageSize',
          in: 'query',
          schema: expect.objectContaining({ minimum: 1, maximum: 100 }),
        }),
      ]),
    );
    expect(res.body.components.schemas.CliCourseSummaryDto).toBeDefined();
    expect(
      Object.keys(res.body.components.schemas.CliCourseSummaryDto.properties),
    ).toEqual(['id', 'name', 'status']);

    const validateBatch =
      res.body.paths['/api/v1/courses/{courseId}/question-batches/validate']
        .post;
    expect(validateBatch.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'X-CLI-Key',
          in: 'header',
          required: false,
        }),
      ]),
    );

    const myCourses = res.body.paths['/api/v1/me/courses'].get;
    expect(myCourses.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'page', in: 'query' }),
        expect.objectContaining({ name: 'pageSize', in: 'query' }),
      ]),
    );
    expect(res.body.components.schemas.CreateEnrollmentDto).toBeDefined();
    expect(res.body.components.schemas.EnrollmentDto).toBeDefined();
    expect(res.body.components.schemas.EnrollmentStudentDto).toBeDefined();
    expect(res.body.components.schemas.MyCourseDto).toBeDefined();

    // BE-8.2 CP2 — UpdateAccountDto allowlist has no sensitive fields/examples.
    const updateAccount = res.body.components.schemas.UpdateAccountDto;
    expect(updateAccount).toBeDefined();
    const updateProps = Object.keys(updateAccount.properties ?? {});
    expect(updateProps).toEqual(
      expect.arrayContaining(['displayName', 'role', 'canCreateCourse']),
    );
    expect(updateProps).not.toContain('password');
    expect(updateProps).not.toContain('passwordHash');
    expect(updateProps).not.toContain('username');
    expect(updateProps).not.toContain('status');
    expect(JSON.stringify(updateAccount)).not.toContain('password');

    const rotatePath =
      res.body.paths[
        '/api/v1/admin/accounts/{id}/cli-credentials/{credentialId}/rotate'
      ].post;
    expect(rotatePath.requestBody).toBeUndefined();
    expect(
      rotatePath.responses['201'].content['application/json'].schema.$ref,
    ).toContain('RotateCliCredentialResponseDto');
    expect(rotatePath.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', in: 'path', required: true }),
        expect.objectContaining({
          name: 'credentialId',
          in: 'path',
          required: true,
        }),
      ]),
    );

    const cliCredential = res.body.components.schemas.CliCredentialDto;
    const cliCredentialProps = Object.keys(cliCredential.properties ?? {});
    expect(cliCredentialProps).toContain('rotatedFromId');
    expect(cliCredential.properties.rotatedFromId.nullable).toBe(true);
    expect(cliCredentialProps).not.toContain('keyHash');
    expect(cliCredentialProps).not.toContain('expiresAt');
    expect(cliCredentialProps).not.toContain('gracePeriod');
    expect(cliCredentialProps).not.toContain('pendingVerification');

    const rotateResponse =
      res.body.components.schemas.RotateCliCredentialResponseDto;
    expect(rotateResponse.properties.rawKey).toBeDefined();
    expect(Object.keys(rotateResponse.properties)).not.toContain('keyHash');
    expect(JSON.stringify(rotateResponse)).not.toMatch(
      /expiresAt|ttl|grace|pending/i,
    );
  });

  it('keeps sensitive properties and schema metadata within their contracts', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json');
    const schemas = res.body.components.schemas as Record<
      string,
      {
        properties?: Record<string, unknown>;
        allOf?: Array<{
          $ref?: string;
          properties?: Record<string, unknown>;
        }>;
      }
    >;

    const schemaProperties = (
      name: string,
      visited = new Set<string>(),
    ): Record<string, unknown> => {
      if (visited.has(name)) return {};
      visited.add(name);
      const schema = schemas[name];
      if (!schema) return {};
      const properties = { ...(schema.properties ?? {}) };
      for (const component of schema.allOf ?? []) {
        const refName = component.$ref?.split('/').pop();
        if (refName)
          Object.assign(properties, schemaProperties(refName, visited));
        Object.assign(properties, component.properties ?? {});
      }
      return properties;
    };

    const schemasWithProperty = (property: string): string[] =>
      Object.keys(schemas).filter((name) =>
        Object.prototype.hasOwnProperty.call(schemaProperties(name), property),
      );

    expect(schemasWithProperty('keyHash')).toEqual([]);
    expect(schemasWithProperty('rawKey').sort()).toEqual(
      [
        'CreateCliCredentialResponseDto',
        'RotateCliCredentialResponseDto',
      ].sort(),
    );
    expect(schemasWithProperty('expiresAt').sort()).toEqual(
      ['SessionDto', 'ValidateBatchResponseDto'].sort(),
    );
    expect(schemasWithProperty('validationToken')).toEqual([
      'ValidateBatchResponseDto',
    ]);

    const metadata: Array<{ path: string; value: unknown }> = [];
    const visit = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}/${index}`));
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        const childPath = `${path}/${key}`;
        if (key === 'example' || key === 'examples' || key === 'default') {
          metadata.push({ path: childPath, value: child });
        }
        visit(child, childPath);
      }
    };
    visit(res.body, '');

    const serializedMetadata = JSON.stringify(metadata);
    expect(serializedMetadata).not.toMatch(
      /password|passwordHash|keyHash|rawKey|token|payloadHash|textAnswer|selectedOptionRefs|prompt|correctOptionRefs|answer|secret/i,
    );
  });

  it('GET /api/docs → 200 Swagger UI HTML', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/text\/html/);
  });
});
