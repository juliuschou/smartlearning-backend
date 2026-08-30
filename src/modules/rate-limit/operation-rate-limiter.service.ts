import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock, SystemClock } from '../../common/clock';
import { type RateLimitDecision } from './rate-limiter.service';
import { OperationRateLimitPolicy } from './operation-rate-limit';

interface OperationRateLimitConfig {
  max: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  expiresAt: number;
}

const DEFAULT_OPERATION_RATE_LIMIT_CONFIG: Record<
  OperationRateLimitPolicy,
  OperationRateLimitConfig
> = {
  [OperationRateLimitPolicy.CLI_COURSES_LIST]: {
    max: 60,
    windowMs: 60_000,
  },
  [OperationRateLimitPolicy.CLI_COURSES_CREATE]: {
    max: 10,
    windowMs: 60_000,
  },
  [OperationRateLimitPolicy.CLI_BATCH_VALIDATE]: {
    max: 30,
    windowMs: 60_000,
  },
  [OperationRateLimitPolicy.CLI_BATCH_CONFIRM]: {
    max: 20,
    windowMs: 60_000,
  },
};

const POLICY_ENV: Record<
  OperationRateLimitPolicy,
  { max: string; windowMs: string }
> = {
  [OperationRateLimitPolicy.CLI_COURSES_LIST]: {
    max: 'CLI_COURSES_LIST_RATE_LIMIT_MAX',
    windowMs: 'CLI_COURSES_LIST_RATE_LIMIT_WINDOW_MS',
  },
  [OperationRateLimitPolicy.CLI_COURSES_CREATE]: {
    max: 'CLI_COURSES_CREATE_RATE_LIMIT_MAX',
    windowMs: 'CLI_COURSES_CREATE_RATE_LIMIT_WINDOW_MS',
  },
  [OperationRateLimitPolicy.CLI_BATCH_VALIDATE]: {
    max: 'CLI_BATCH_VALIDATE_RATE_LIMIT_MAX',
    windowMs: 'CLI_BATCH_VALIDATE_RATE_LIMIT_WINDOW_MS',
  },
  [OperationRateLimitPolicy.CLI_BATCH_CONFIRM]: {
    max: 'CLI_BATCH_CONFIRM_RATE_LIMIT_MAX',
    windowMs: 'CLI_BATCH_CONFIRM_RATE_LIMIT_WINDOW_MS',
  },
};

/**
 * Per-CLI-credential request limiter for CLI Course and question-batch routes.
 * Storage is intentionally process-local in CP4; Redis-backed sharing is CP5.
 */
@Injectable()
export class OperationRateLimiterService {
  private readonly clock: Clock;
  private readonly config: Record<
    OperationRateLimitPolicy,
    OperationRateLimitConfig
  >;
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly configService: ConfigService,
    @Optional() clock?: Clock,
  ) {
    this.clock = clock ?? new SystemClock();
    this.config = Object.fromEntries(
      Object.values(OperationRateLimitPolicy).map((policy) => {
        const defaults = DEFAULT_OPERATION_RATE_LIMIT_CONFIG[policy];
        const env = POLICY_ENV[policy];
        return [
          policy,
          {
            max: this.number(env.max, defaults.max),
            windowMs: this.number(env.windowMs, defaults.windowMs),
          },
        ];
      }),
    ) as Record<OperationRateLimitPolicy, OperationRateLimitConfig>;
  }

  consume(
    policy: OperationRateLimitPolicy,
    credentialId: string,
  ): RateLimitDecision {
    const now = this.clock.nowMs();
    const config = this.config[policy];
    const key = `${policy}:${credentialId}`;
    const bucket = this.touch(key, now, config.windowMs);

    if (bucket.count >= config.max) {
      return {
        limited: true,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((bucket.expiresAt - now) / 1000),
        ),
      };
    }

    bucket.count += 1;
    return { limited: false, retryAfterSeconds: 0 };
  }

  getConfig(policy: OperationRateLimitPolicy): OperationRateLimitConfig {
    return this.config[policy];
  }

  reset(): void {
    this.buckets.clear();
  }

  private number(key: string, fallback: number): number {
    const raw = this.configService.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }

  private touch(key: string, now: number, windowMs: number): Bucket {
    const existing = this.buckets.get(key);
    if (existing && existing.expiresAt > now) return existing;

    const bucket = { count: 0, expiresAt: now + windowMs };
    this.buckets.set(key, bucket);
    if (this.buckets.size > 256) {
      for (const [bucketKey, candidate] of this.buckets) {
        if (candidate.expiresAt <= now) this.buckets.delete(bucketKey);
      }
    }
    return bucket;
  }
}
