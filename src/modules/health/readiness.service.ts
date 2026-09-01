import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeRedisService } from '../realtime/realtime-redis.service';
import { RateLimiterService } from '../rate-limit/rate-limiter.service';
import { MetricsService } from '../metrics/metrics.service';

export interface ReadinessCheck {
  healthy: boolean;
  latencyMs?: number;
  mode?: string;
  adapter?: string;
  readiness?: string;
  error?: string;
}

export interface ReadinessResult {
  status: 'ok' | 'degraded';
  timestamp: string;
  checks: Record<string, ReadinessCheck>;
  httpStatus: 200 | 503;
}

/** Dependency readiness with safe, low-cardinality diagnostics. */
@Injectable()
export class ReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RealtimeRedisService,
    private readonly loginRateLimiter: RateLimiterService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async check(): Promise<ReadinessResult> {
    const checks: Record<string, ReadinessCheck> = {};
    let dbHealthy = true;
    const dbStart = Date.now();
    try {
      await this.prisma.prisma.$queryRaw`SELECT 1`;
      checks.db = { healthy: true, latencyMs: Date.now() - dbStart };
    } catch {
      dbHealthy = false;
      checks.db = { healthy: false, error: 'database_unavailable' };
    }

    const policy = this.redis.policy;
    const redisHealthy =
      this.redis.redisMode === 'off' || this.redis.availability === 'available';
    checks.redis = {
      healthy: redisHealthy,
      mode: this.redis.redisMode,
      adapter: policy.adapter,
      readiness: policy.readiness,
      ...(redisHealthy ? {} : { error: 'redis_unavailable' }),
    };

    const loginRateLimitHealthy = this.loginRateLimiter.acceptsTraffic;
    checks.loginRateLimit = {
      healthy: loginRateLimitHealthy,
      mode: this.loginRateLimiter.loginRateLimitMode,
      readiness: loginRateLimitHealthy ? 'healthy' : 'unready',
      ...(loginRateLimitHealthy
        ? {}
        : { error: 'login_rate_limit_unavailable' }),
    };

    this.recordReadiness('database', dbHealthy);
    this.recordReadiness('realtime_redis', redisHealthy);
    this.recordReadiness('login_rate_limit', loginRateLimitHealthy);

    const operational =
      dbHealthy && policy.acceptsTraffic && loginRateLimitHealthy;
    return {
      status: operational && redisHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
      httpStatus: operational ? 200 : 503,
    };
  }

  private recordReadiness(
    dependency: 'database' | 'realtime_redis' | 'login_rate_limit',
    healthy: boolean,
  ): void {
    try {
      this.metrics?.recordReadiness(dependency, healthy);
    } catch {
      // Metrics cannot change readiness policy or its HTTP status.
    }
  }
}
