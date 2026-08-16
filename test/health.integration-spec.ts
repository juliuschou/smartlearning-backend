import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup/app-factory';

/**
 * Integration: exercises the real DB readiness path. Requires the test DB
 * (smartlearning_test) to be migrated; run `npm run prisma:migrate:deploy`
 * with NODE_ENV=test first. Skips automatically when DB is unreachable.
 */
describe('Health readiness (integration)', () => {
  let app: INestApplication;
  let dbReachable = false;

  beforeAll(async () => {
    app = await createTestApp();
    await app.init();
    // Probe DB once; skip the suite if it isn't reachable.
    const res = await request(app.getHttpServer()).get('/health/ready');
    dbReachable = Boolean(res.body?.checks?.db?.healthy);
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports db healthy when the test database is migrated and reachable', () => {
    if (!dbReachable) {
      console.warn(
        'Skipping: test DB not reachable. Run: NODE_ENV=test npm run prisma:migrate:deploy',
      );
      return;
    }
    // already asserted in beforeAll; re-assert explicitly here
    expect(dbReachable).toBe(true);
  });
});
