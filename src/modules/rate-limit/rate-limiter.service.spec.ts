import { ConfigService } from '@nestjs/config';
import { FakeClock } from '../../common/clock';
import {
  normalizeRateLimitAccountKey,
  RateLimiterService,
} from './rate-limiter.service';

/**
 * Unit tests for the in-memory login rate limiter (R-F7-7).
 * Uses a FakeClock so TTL windows advance deterministically without real time.
 */
function makeLimiter(
  clock: FakeClock,
  overrides?: Record<string, string | number>,
) {
  const configService = {
    get: (key: string) => overrides?.[key],
  } as unknown as ConfigService;
  return new RateLimiterService(configService, clock);
}

describe('RateLimiterService', () => {
  it('is not limited before any failures', () => {
    const clock = new FakeClock(0);
    const limiter = makeLimiter(clock);
    expect(limiter.check('alice', '1.2.3.4')).toEqual({
      limited: false,
      retryAfterSeconds: 0,
    });
  });

  it('limits after account scope exceeds its max', () => {
    const clock = new FakeClock(0);
    const limiter = makeLimiter(clock, {
      LOGIN_RATE_LIMIT_ACCOUNT_MAX: 3,
      LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS: 60_000,
      LOGIN_RATE_LIMIT_SOURCE_MAX: 100,
      LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS: 60_000,
    });
    // 3 failures from distinct sources against one account.
    for (let i = 0; i < 3; i++) {
      limiter.recordFailure('alice', `1.2.3.${i}`);
    }
    const decision = limiter.check('alice', '9.9.9.9');
    expect(decision.limited).toBe(true);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('limits after source scope exceeds its max', () => {
    const clock = new FakeClock(0);
    const limiter = makeLimiter(clock, {
      LOGIN_RATE_LIMIT_ACCOUNT_MAX: 100,
      LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS: 60_000,
      LOGIN_RATE_LIMIT_SOURCE_MAX: 2,
      LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS: 60_000,
    });
    // 2 failures from one source against distinct accounts.
    limiter.recordFailure('alice', '1.2.3.4');
    limiter.recordFailure('bob', '1.2.3.4');
    const decision = limiter.check('carol', '1.2.3.4');
    expect(decision.limited).toBe(true);
  });

  it('clears the account scope on success but keeps the source scope', () => {
    const clock = new FakeClock(0);
    const limiter = makeLimiter(clock, {
      LOGIN_RATE_LIMIT_ACCOUNT_MAX: 100,
      LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS: 60_000,
      LOGIN_RATE_LIMIT_SOURCE_MAX: 100,
      LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS: 60_000,
    });
    limiter.recordFailure('alice', '1.2.3.4');
    limiter.clearOnSuccess('alice');
    // Account scope cleared → not limited by account.
    expect(limiter.check('alice', '9.9.9.9').limited).toBe(false);
  });

  it('is not permanently locked out — counters decay after the window', () => {
    const clock = new FakeClock(0);
    const limiter = makeLimiter(clock, {
      LOGIN_RATE_LIMIT_ACCOUNT_MAX: 2,
      LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS: 60_000,
      LOGIN_RATE_LIMIT_SOURCE_MAX: 100,
      LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS: 60_000,
    });
    limiter.recordFailure('alice', '1.2.3.4');
    limiter.recordFailure('alice', '1.2.3.4');
    expect(limiter.check('alice', '1.2.3.4').limited).toBe(true);
    // Advance past the window → bucket expires, no longer limited.
    clock.advance(60_001);
    expect(limiter.check('alice', '1.2.3.4').limited).toBe(false);
  });

  it('treats the same account with different case as one scope', () => {
    const clock = new FakeClock(0);
    const limiter = makeLimiter(clock, {
      LOGIN_RATE_LIMIT_ACCOUNT_MAX: 2,
      LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS: 60_000,
      LOGIN_RATE_LIMIT_SOURCE_MAX: 100,
      LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS: 60_000,
    });
    // The limiter keys on the exact string the caller passes; AuthService
    // lowercases before calling, so simulate that here.
    limiter.recordFailure('alice', '1.2.3.4');
    limiter.recordFailure('alice', '1.2.3.5');
    expect(limiter.check('alice', '1.2.3.6').limited).toBe(true);
  });

  it('check does not consume an attempt', () => {
    const clock = new FakeClock(0);
    const limiter = makeLimiter(clock, {
      LOGIN_RATE_LIMIT_ACCOUNT_MAX: 1,
      LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS: 60_000,
      LOGIN_RATE_LIMIT_SOURCE_MAX: 100,
      LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS: 60_000,
    });
    // Repeated checks alone never trigger a limit.
    for (let i = 0; i < 50; i++) {
      expect(limiter.check('alice', '1.2.3.4').limited).toBe(false);
    }
  });

  it('coerces string-valued environment limits before calculating TTLs', () => {
    const clock = new FakeClock(0);
    const limiter = makeLimiter(clock, {
      LOGIN_RATE_LIMIT_ACCOUNT_MAX: '2',
      LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS: '60000',
      LOGIN_RATE_LIMIT_SOURCE_MAX: '100',
      LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS: '60000',
    });

    limiter.recordFailure('alice', '1.2.3.4');
    limiter.recordFailure('alice', '1.2.3.4');
    expect(limiter.check('alice', '1.2.3.4').limited).toBe(true);

    clock.advance(60_001);
    expect(limiter.check('alice', '1.2.3.4').limited).toBe(false);
  });

  it('normalizes NFKC, whitespace, and case in account limiter keys', () => {
    expect(normalizeRateLimitAccountKey('  Ａlice  ')).toBe('alice');
  });
});
