import type { PrismaService } from '../../prisma/prisma.service';
import type { RealtimeRedisService } from '../realtime/realtime-redis.service';
import type { RateLimiterService } from '../rate-limit/rate-limiter.service';
import { ReadinessService } from './readiness.service';

function makeReadiness(options: {
  db?: Promise<unknown>;
  mode: 'off' | 'optional' | 'required';
  availability: 'available' | 'unavailable';
  loginMode?: 'memory' | 'redis-required';
  loginAvailable?: boolean;
}): {
  readiness: ReadinessService;
  queryRaw: jest.Mock;
  metrics: { recordReadiness: jest.Mock };
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
  const loginRateLimiter = {
    loginRateLimitMode: options.loginMode ?? 'memory',
    acceptsTraffic: options.loginAvailable ?? true,
  } as unknown as RateLimiterService;
  const metrics = { recordReadiness: jest.fn() };
  return {
    readiness: new ReadinessService(
      prisma,
      redis,
      loginRateLimiter,
      metrics as never,
    ),
    queryRaw,
    metrics,
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

  it('blocks required login limiting when Redis is unavailable', async () => {
    const { readiness } = makeReadiness({
      mode: 'off',
      availability: 'unavailable',
      loginMode: 'redis-required',
      loginAvailable: false,
    });

    const result = await readiness.check();

    expect(result).toMatchObject({ status: 'degraded', httpStatus: 503 });
    expect(result.checks.loginRateLimit).toEqual({
      healthy: false,
      mode: 'redis-required',
      readiness: 'unready',
      error: 'login_rate_limit_unavailable',
    });
  });

  it('records each dependency observation without changing readiness policy', async () => {
    const { readiness, metrics } = makeReadiness({
      mode: 'optional',
      availability: 'unavailable',
    });

    await readiness.check();

    expect(metrics.recordReadiness).toHaveBeenCalledWith('database', true);
    expect(metrics.recordReadiness).toHaveBeenCalledWith(
      'realtime_redis',
      false,
    );
    expect(metrics.recordReadiness).toHaveBeenCalledWith(
      'login_rate_limit',
      true,
    );
  });

  it('preserves the readiness result when metrics recording throws', async () => {
    const { readiness } = makeReadiness({
      mode: 'optional',
      availability: 'unavailable',
    });
    const metrics = readiness as unknown as {
      metrics: { recordReadiness: jest.Mock };
    };
    metrics.metrics.recordReadiness.mockImplementation(() => {
      throw new Error('metrics failure');
    });

    await expect(readiness.check()).resolves.toMatchObject({
      status: 'degraded',
      httpStatus: 200,
    });
  });

  it('reports shutdown as unready without probing dependencies', async () => {
    const { readiness, queryRaw } = makeReadiness({
      mode: 'required',
      availability: 'available',
    });
    (
      readiness as unknown as { lifecycle: { isShuttingDown: boolean } }
    ).lifecycle = { isShuttingDown: true };

    const result = await readiness.check();

    expect(result).toMatchObject({ status: 'degraded', httpStatus: 503 });
    expect(result.checks.application).toEqual({
      healthy: false,
      readiness: 'unready',
      error: 'shutting_down',
    });
    expect(queryRaw).not.toHaveBeenCalled();
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
