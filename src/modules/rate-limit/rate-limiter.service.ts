import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock, SystemClock } from '../../common/clock';

/**
 * In-memory login rate limiter — US-F7 / R-F7-7.
 *
 * MVP floor: a single-instance, in-process fixed-window counter with TTL. No
 * Redis dependency (the Web Auth design defers Redis/multi-instance consistency
 * to a later architecture decision). This satisfies R-F7-7's acceptance:
 *  - dual scope (account identifier + source IP),
 *  - no permanent lockout (counters decay via TTL),
 *  - stable `RATE_LIMITED` response with a retry hint,
 *  - no account-existence leak (the limiter decision is made before the
 *    dummy-hash timing path and returns the same `RATE_LIMITED` regardless of
 *    whether the account exists).
 *
 * Multi-instance caveat: with >1 backend instance, each instance keeps its own
 * counters, so the effective limit is `limit × instanceCount`. Acceptable for
 * the MVP single-instance topology; documented for the later Redis move.
 */
export interface RateLimitConfig {
  /** Max failures per window for one account identifier. */
  accountMax: number;
  /** Window length (ms) for the account scope. */
  accountWindowMs: number;
  /** Max failures per window for one source (IP). */
  sourceMax: number;
  /** Window length (ms) for the source scope. */
  sourceWindowMs: number;
}

/** Result of a limit check. */
export interface RateLimitDecision {
  limited: boolean;
  /** Seconds until the limiting window expires (for Retry-After / envelope). */
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  expiresAt: number;
}

/** Default config (overridable via env). 10 failed / 5min per account, 20 / 5min per source. */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  accountMax: 10,
  accountWindowMs: 5 * 60 * 1000,
  sourceMax: 20,
  sourceWindowMs: 5 * 60 * 1000,
};

/** Normalize the identifier used for the account-scope limiter key. */
export function normalizeRateLimitAccountKey(identifier: string): string {
  return identifier.normalize('NFKC').trim().toLowerCase();
}

@Injectable()
export class RateLimiterService {
  private readonly config: RateLimitConfig;
  private readonly clock: Clock;
  // Lazy-allocated buckets keyed by scope:key. Small and bounded by active
  // attackers; expired entries are swept on access.
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly configService: ConfigService,
    @Optional() clock?: Clock,
  ) {
    this.clock = clock ?? new SystemClock();
    // Coerce to Number explicitly: `ConfigService.get<number>()` is only a
    // TypeScript hint and does NOT convert the underlying env value, which is
    // always a string. Without this, `nowMs() + windowMs` would string-concat
    // (number + string), producing an `expiresAt` ~10000× too large so buckets
    // never expire and the limit becomes a permanent lockout.
    const num = (key: string, fallback: number): number => {
      const raw = this.configService.get<string | number>(key);
      if (raw === undefined || raw === null || raw === '') return fallback;
      const n = Number(raw);
      return Number.isFinite(n) ? n : fallback;
    };
    this.config = {
      accountMax: num(
        'LOGIN_RATE_LIMIT_ACCOUNT_MAX',
        DEFAULT_RATE_LIMIT_CONFIG.accountMax,
      ),
      accountWindowMs: num(
        'LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS',
        DEFAULT_RATE_LIMIT_CONFIG.accountWindowMs,
      ),
      sourceMax: num(
        'LOGIN_RATE_LIMIT_SOURCE_MAX',
        DEFAULT_RATE_LIMIT_CONFIG.sourceMax,
      ),
      sourceWindowMs: num(
        'LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS',
        DEFAULT_RATE_LIMIT_CONFIG.sourceWindowMs,
      ),
    };
  }

  /**
   * Check whether the caller is currently rate-limited, **without** consuming
   * an attempt. Call on the login path *before* credential verification. Reads
   * the existing counters; if either scope is over its max, returns
   * `limited=true` with the longest remaining window. Does not reveal whether
   * the account exists — the decision is the same for a missing account, so
   * the caller surfaces the same `RATE_LIMITED` in both cases.
   */
  check(accountKey: string, sourceKey: string): RateLimitDecision {
    const now = this.clock.nowMs();
    const accountBucket = this.buckets.get(`account:${accountKey}`);
    const sourceBucket = this.buckets.get(`source:${sourceKey}`);

    const accountExceeded =
      !!accountBucket &&
      accountBucket.expiresAt > now &&
      accountBucket.count >= this.config.accountMax;
    const sourceExceeded =
      !!sourceBucket &&
      sourceBucket.expiresAt > now &&
      sourceBucket.count >= this.config.sourceMax;

    if (!accountExceeded && !sourceExceeded) {
      return { limited: false, retryAfterSeconds: 0 };
    }

    const accountRetry = accountExceeded
      ? Math.ceil((accountBucket!.expiresAt - now) / 1000)
      : 0;
    const sourceRetry = sourceExceeded
      ? Math.ceil((sourceBucket!.expiresAt - now) / 1000)
      : 0;
    return {
      limited: true,
      retryAfterSeconds: Math.max(accountRetry, sourceRetry, 1),
    };
  }

  /**
   * Record a failed attempt for both scopes (increment counters). Call on the
   * **failure** path only. Idempotent per failure — one increment per failed
   * login. Does not itself decide; the caller re-checks or relies on the next
   * request's `check` to surface `RATE_LIMITED`.
   */
  recordFailure(accountKey: string, sourceKey: string): void {
    const now = this.clock.nowMs();
    const accountBucket = this.touch(
      `account:${accountKey}`,
      now,
      this.config.accountWindowMs,
    );
    const sourceBucket = this.touch(
      `source:${sourceKey}`,
      now,
      this.config.sourceWindowMs,
    );
    accountBucket.count += 1;
    sourceBucket.count += 1;
  }

  /**
   * Clear the account-scope counter on a successful login. The source scope is
   * left to decay via TTL so one source's failures don't get flushed by an
   * unrelated successful login from the same IP.
   */
  clearOnSuccess(accountKey: string): void {
    this.buckets.delete(`account:${accountKey}`);
  }

  /** Expose the resolved config for tests / diagnostics. */
  getConfig(): RateLimitConfig {
    return this.config;
  }

  /** Test-only: reset all buckets. */
  reset(): void {
    this.buckets.clear();
  }

  private touch(key: string, now: number, windowMs: number): Bucket {
    const existing = this.buckets.get(key);
    if (existing && existing.expiresAt > now) {
      return existing;
    }
    // Expired or absent → start a fresh window.
    const bucket: Bucket = { count: 0, expiresAt: now + windowMs };
    this.buckets.set(key, bucket);
    // Opportunistic sweep of any expired entries (bounded cost).
    if (this.buckets.size > 256) {
      for (const [k, b] of this.buckets) {
        if (b.expiresAt <= now) this.buckets.delete(k);
      }
    }
    return bucket;
  }
}
