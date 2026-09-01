import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ReadinessService } from '../src/modules/health/readiness.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RealtimeRedisService } from '../src/modules/realtime/realtime-redis.service';
import { createTestApp } from './setup/app-factory';

describe('Metrics endpoint (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves anonymous raw Prometheus text at the version-neutral root path', async () => {
    const response = await request(app.getHttpServer())
      .get('/metrics')
      .query({ secret: 'CP7-SENTINEL-QUERY' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/plain/);
    expect(response.body).not.toHaveProperty('data');
    expect(response.text).toContain('smartlearning_http_requests_total');
    expect(response.text).not.toContain('CP7-SENTINEL-QUERY');
  });

  it('does not expose a versioned metrics alias and uses safe route labels', async () => {
    const routeResponse = await request(app.getHttpServer()).get(
      '/api/v1/courses/CP7-SENTINEL-ID?token=CP7-SENTINEL-TOKEN',
    );
    expect(routeResponse.status).toBe(401);

    const unmatchedResponse = await request(app.getHttpServer()).get(
      '/CP7-SENTINEL-PATH?answer=CP7-SENTINEL-ANSWER',
    );
    expect(unmatchedResponse.status).toBe(404);

    const versioned = await request(app.getHttpServer()).get('/api/v1/metrics');
    expect(versioned.status).toBe(404);

    const metrics = await request(app.getHttpServer()).get('/metrics');
    expect(metrics.text).toContain('route="/api/v1/courses/:id"');
    expect(metrics.text).toContain('route="__unmatched__"');
    expect(metrics.text).not.toMatch(/CP7-SENTINEL-(?:ID|TOKEN|PATH|ANSWER)/);
  });

  it('does not perform dependency I/O during a scrape', async () => {
    const readiness = app.get(ReadinessService);
    const prisma = app.get(PrismaService);
    const redis = app.get(RealtimeRedisService);
    const readinessSpy = jest.spyOn(readiness, 'check');
    const querySpy = jest.spyOn(prisma.prisma, '$queryRaw');
    const redisAvailability = redis.availability;

    await request(app.getHttpServer()).get('/metrics');

    expect(readinessSpy).not.toHaveBeenCalled();
    expect(querySpy).not.toHaveBeenCalled();
    expect(redis.availability).toBe(redisAvailability);
    readinessSpy.mockRestore();
    querySpy.mockRestore();
  });
});
