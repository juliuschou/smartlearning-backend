import { ConfigService } from '@nestjs/config';
import { FakeClock } from '../../common/clock';
import {
  normalizeRateLimitAccountKey,
  RateLimiterService,
} from './rate-limiter.service';

function makeLimiter(
  clock: FakeClock,
  overrides?: Record<string, string | number>,
  metrics?: { recordLoginRateLimitHit: () => void },
) {
  const configService = {
    get: (key: string) => overrides?.[key],
  } as unknown as ConfigService;
  return new RateLimiterService(
    configService,
    clock,
    undefined,
    undefined,
    metrics as never,
  );
}

describe('RateLimiterService', () => {
  it('is not limited before any failures', async () => {
    const limiter = makeLimiter(new FakeClock(0));
    await expect(limiter.check('alice', '1.2.3.4')).resolves.toEqual({
      limited: false,
      retryAfterSeconds: 0,
    });
  });

  it('limits after account scope reaches its max', async () => {
    const limiter = makeLimiter(new FakeClock(0), {
      LOGIN_RATE_LIMIT_ACCOUNT_MAX: 3,
      LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS: 60_000,
      LOGIN_RATE_LIMIT_SOURCE_MAX: 100,
      LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS: 60_000,
    });
    for (let i = 0; i < 3; i++) {
      await limiter.recordFailure('alice', `1.2.3.${i}`);
    }
    const decision = await limiter.check('alice', '9.9.9.9');
    expect(decision.limited).toBe(true);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('limits after source scope reaches its max', async () => {
    const limiter = makeLimiter(new FakeClock(0), {
      LOGIN_RATE_LIMIT_ACCOUNT_MAX: 100,
      LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS: 60_000,
      LOGIN_RATE_LIMIT_SOURCE_MAX: 2,
      LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS: 60_000,
    });
    await limiter.recordFailure('alice', '1.2.3.4');
    await limiter.recordFailure('bob', '1.2.3.4');
    await expect(limiter.check('carol', '1.2.3.4')).resolves.toMatchObject({
      limited: true,
    });
  });

  it('clears account scope on success but keeps source scope', async () => {
    const limiter = makeLimiter(new FakeClock(0), {
      LOGIN_RATE_LIMIT_ACCOUNT_MAX: 100,
      LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS: 60_000,
      LOGIN_RATE_LIMIT_SOURCE_MAX: 1,
      LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS: 60_000,
    });
    await limiter.recordFailure('alice', '1.2.3.4');
    await limiter.clearOnSuccess('alice');
    await expect(limiter.check('alice', '9.9.9.9')).resolves.toEqual({
      limited: false,
      retryAfterSeconds: 0,
    });
    await expect(limiter.check('other', '1.2.3.4')).resolves.toMatchObject({
      limited: true,
    });
  });

  it('is not permanently locked out after the window', async () => {
    const clock = new FakeClock(0);
    const limiter = makeLimiter(clock, {
      LOGIN_RATE_LIMIT_ACCOUNT_MAX: 2,
      LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS: 60_000,
      LOGIN_RATE_LIMIT_SOURCE_MAX: 100,
      LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS: 60_000,
    });
    await limiter.recordFailure('alice', '1.2.3.4');
    await limiter.recordFailure('alice', '1.2.3.4');
    await expect(limiter.check('alice', '1.2.3.4')).resolves.toMatchObject({
      limited: true,
    });
    clock.advance(60_001);
    await expect(limiter.check('alice', '1.2.3.4')).resolves.toEqual({
      limited: false,
      retryAfterSeconds: 0,
    });
  });

  it('does not consume an attempt during check', async () => {
    const limiter = makeLimiter(new FakeClock(0), {
      LOGIN_RATE_LIMIT_ACCOUNT_MAX: 1,
      LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS: 60_000,
      LOGIN_RATE_LIMIT_SOURCE_MAX: 100,
      LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS: 60_000,
    });
    for (let i = 0; i < 50; i++) {
      await expect(limiter.check('alice', '1.2.3.4')).resolves.toMatchObject({
        limited: false,
      });
    }
  });

  it('coerces string-valued environment limits', async () => {
    const clock = new FakeClock(0);
    const limiter = makeLimiter(clock, {
      LOGIN_RATE_LIMIT_ACCOUNT_MAX: '2',
      LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS: '60000',
      LOGIN_RATE_LIMIT_SOURCE_MAX: '100',
      LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS: '60000',
    });
    await limiter.recordFailure('alice', '1.2.3.4');
    await limiter.recordFailure('alice', '1.2.3.4');
    await expect(limiter.check('alice', '1.2.3.4')).resolves.toMatchObject({
      limited: true,
    });
    clock.advance(60_001);
    await expect(limiter.check('alice', '1.2.3.4')).resolves.toMatchObject({
      limited: false,
    });
  });

  it('records only limited decisions', async () => {
    const recordLoginRateLimitHit = jest.fn();
    const limiter = makeLimiter(
      new FakeClock(0),
      {
        LOGIN_RATE_LIMIT_ACCOUNT_MAX: 1,
        LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS: 60_000,
        LOGIN_RATE_LIMIT_SOURCE_MAX: 100,
        LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS: 60_000,
      },
      { recordLoginRateLimitHit },
    );

    await limiter.check('alice', '1.2.3.4');
    await limiter.recordFailure('alice', '1.2.3.4');
    await limiter.check('alice', '1.2.3.4');

    expect(recordLoginRateLimitHit).toHaveBeenCalledTimes(1);
  });

  it('does not let a metrics failure replace the rate-limit decision', async () => {
    const limiter = makeLimiter(
      new FakeClock(0),
      {
        LOGIN_RATE_LIMIT_ACCOUNT_MAX: 1,
        LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS: 60_000,
        LOGIN_RATE_LIMIT_SOURCE_MAX: 100,
        LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS: 60_000,
      },
      {
        recordLoginRateLimitHit: () => {
          throw new Error('metrics failure');
        },
      },
    );

    await limiter.recordFailure('alice', '1.2.3.4');
    await expect(limiter.check('alice', '1.2.3.4')).resolves.toMatchObject({
      limited: true,
    });
  });

  it('normalizes NFKC, whitespace, and case', () => {
    expect(normalizeRateLimitAccountKey('  Ａlice  ')).toBe('alice');
  });
});
