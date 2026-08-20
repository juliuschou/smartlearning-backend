import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup/app-factory';

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
    // US-F8 admin account list/detail contract.
    expect(paths).toContain('/api/v1/admin/accounts');
    expect(paths).toContain('/api/v1/admin/accounts/{id}');
    // Health routes stay outside /api/v1 per the global-prefix exclusion.
    expect(paths).toContain('/health/live');
    expect(paths).toContain('/health/ready');
    // No accidental /api/api/v1 double prefix.
    expect(paths.some((p) => p.startsWith('/api/api/'))).toBe(false);
  });

  it('GET /api/docs → 200 Swagger UI HTML', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/text\/html/);
  });
});
