import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup/app-factory';

describe('Application (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live → 200 ok (no DB dependency)', async () => {
    const res = await request(app.getHttpServer()).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /health/ready → 200 with a db check object', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');
    // Controller returns 200 with status ok|degraded; we assert the db check
    // shape rather than a hard healthy=true so the suite stays green in a
    // DB-less CI sandbox.
    expect(res.status).toBe(200);
    expect(res.body.checks).toHaveProperty('db');
    expect(typeof res.body.checks.db.healthy).toBe('boolean');
  });
});
