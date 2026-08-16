import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup/app-factory';

describe('Common API envelope (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps the liveness probe raw while still returning a request ID header', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/live')
      .set('x-request-id', 'health-contract');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data).toBeUndefined();
    expect(res.headers['x-request-id']).toBe('health-contract');
  });

  it('returns a complete error envelope for an unauthenticated versioned route', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/courses')
      .set('x-request-id', 'error-contract');

    expect(res.status).toBe(401);
    expect(res.headers['x-request-id']).toBe('error-contract');
    expect(res.body).toEqual({
      data: null,
      meta: { schemaVersion: 1, requestId: 'error-contract' },
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        blocking: true,
        retryAfterSeconds: null,
      },
    });
  });

  it('returns deterministic validation metadata for invalid login input', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
    expect(res.body.meta.schemaVersion).toBe(1);
    expect(res.body.meta.requestId).toBe(res.headers['x-request-id']);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.blocking).toBe(true);
    expect(res.body.error.field).toBe('password');
    expect(res.body.error.message).toContain('password');
    expect(res.body.error.retryAfterSeconds).toBeNull();
  });

  it('generates and echoes a request ID when the client omits one', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/courses');

    expect(res.status).toBe(401);
    expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9-]{1,128}$/);
    expect(res.body.meta.requestId).toBe(res.headers['x-request-id']);
  });
});
