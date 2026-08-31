import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock, SystemClock } from '../../common/clock';
import type {
  LoginRateLimitAvailability,
  LoginRateLimitStore,
} from './login-rate-limit-store';
import type {
  RateLimitConfig,
  RateLimitDecision,
} from './rate-limiter.service';

interface Bucket {
  count: number;
  expiresAt: number;
}

@Injectable()
export class MemoryLoginRateLimitStore implements LoginRateLimitStore {
  private readonly clock: Clock;
  private readonly buckets = new Map<string, Bucket>();

  constructor(_config: ConfigService, @Optional() clock?: Clock) {
    this.clock = clock ?? new SystemClock();
  }

  get availability(): LoginRateLimitAvailability {
    return 'available';
  }

  async initialize(): Promise<void> {}

  async destroy(): Promise<void> {}

  async check(
    accountKey: string,
    sourceKey: string,
    config: RateLimitConfig,
  ): Promise<RateLimitDecision> {
    const now = this.clock.nowMs();
    const accountBucket = this.buckets.get(`account:${accountKey}`);
    const sourceBucket = this.buckets.get(`source:${sourceKey}`);
    const accountExceeded = this.exceeded(
      accountBucket,
      now,
      config.accountMax,
    );
    const sourceExceeded = this.exceeded(sourceBucket, now, config.sourceMax);

    if (!accountExceeded && !sourceExceeded) {
      return { limited: false, retryAfterSeconds: 0 };
    }

    return {
      limited: true,
      retryAfterSeconds: Math.max(
        1,
        accountExceeded
          ? Math.ceil((accountBucket!.expiresAt - now) / 1000)
          : 0,
        sourceExceeded ? Math.ceil((sourceBucket!.expiresAt - now) / 1000) : 0,
      ),
    };
  }

  async recordFailure(
    accountKey: string,
    sourceKey: string,
    config: RateLimitConfig,
  ): Promise<void> {
    const now = this.clock.nowMs();
    this.touch(`account:${accountKey}`, now, config.accountWindowMs).count += 1;
    this.touch(`source:${sourceKey}`, now, config.sourceWindowMs).count += 1;
  }

  async clearOnSuccess(accountKey: string): Promise<void> {
    this.buckets.delete(`account:${accountKey}`);
  }

  reset(): void {
    this.buckets.clear();
  }

  private exceeded(
    bucket: Bucket | undefined,
    now: number,
    max: number,
  ): boolean {
    return !!bucket && bucket.expiresAt > now && bucket.count >= max;
  }

  private touch(key: string, now: number, windowMs: number): Bucket {
    const existing = this.buckets.get(key);
    if (existing && existing.expiresAt > now) return existing;

    const bucket = { count: 0, expiresAt: now + windowMs };
    this.buckets.set(key, bucket);
    if (this.buckets.size > 256) {
      for (const [candidateKey, candidate] of this.buckets) {
        if (candidate.expiresAt <= now) this.buckets.delete(candidateKey);
      }
    }
    return bucket;
  }
}
