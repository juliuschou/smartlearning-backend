import type { PrismaService } from '../../prisma/prisma.service';
import type { RealtimeRedisService } from '../realtime/realtime-redis.service';
import { ReadinessService } from './readiness.service';

function makeReadiness(options: {
  db?: Promise<unknown>;
  mode: 'off' | 'optional' | 'required';
  availability: 'available' | 'unavailable';
}): {
  readiness: ReadinessService;
  queryRaw: jest.Mock;
} {
  const queryRaw = jest
    .fn()
    .mockReturnValue(options.db ?? Promise.resolve([{ '?column?': 1 }]));
  const prisma = {
    prisma: { $queryRaw: queryRaw },
  } as unknown as PrismaService;
  const redis = {
    redisMode: options.mode,
    availability: options.availability,
    policy: {
      adapter:
        options.availability === 'available' && options.mode !== 'off'
          ? 'redis'
          : 'local',
      readiness:
        options.mode === 'required' && options.availability === 'unavailable'
          ? 'unready'
          : options.mode === 'optional' &&
              options.availability === 'unavailable'
            ? 'degraded'
            : 'healthy',
      acceptsTraffic:
        options.mode !== 'required' || options.availability === 'available',
    },
  } as unknown as RealtimeRedisService;
  return {
    readiness: new ReadinessService(prisma, redis),
    queryRaw,
  };
}

describe('ReadinessService', () => {
  it('reports local realtime mode as healthy without Redis', async () => {
    const { readiness } = makeReadiness({
      mode: 'off',
      availability: 'unavailable',
    });

    const result = await readiness.check();

    expect(result).toMatchObject({ status: 'ok', httpStatus: 200 });
    expect(result.checks.redis).toMatchObject({
      healthy: true,
      mode: 'off',
      adapter: 'local',
      readiness: 'healthy',
    });
  });

  it('reports optional Redis fallback as degraded but ready', async () => {
    const { readiness } = makeReadiness({
      mode: 'optional',
      availability: 'unavailable',
    });

    const result = await readiness.check();

    expect(result).toMatchObject({ status: 'degraded', httpStatus: 200 });
    expect(result.checks.redis).toMatchObject({
      healthy: false,
      error: 'redis_unavailable',
      readiness: 'degraded',
    });
  });

  it('blocks required mode when Redis is unavailable', async () => {
    const { readiness } = makeReadiness({
      mode: 'required',
      availability: 'unavailable',
    });

    const result = await readiness.check();

    expect(result).toMatchObject({ status: 'degraded', httpStatus: 503 });
    expect(result.checks.redis).toMatchObject({
      healthy: false,
      error: 'redis_unavailable',
      readiness: 'unready',
    });
  });

  it('blocks readiness when PostgreSQL is unavailable', async () => {
    const { readiness, queryRaw } = makeReadiness({
      mode: 'off',
      availability: 'unavailable',
      db: Promise.reject(new Error('database down')),
    });

    const result = await readiness.check();

    expect(queryRaw).toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'degraded', httpStatus: 503 });
    expect(result.checks.db).toEqual({
      healthy: false,
      error: 'database_unavailable',
    });
  });
});
