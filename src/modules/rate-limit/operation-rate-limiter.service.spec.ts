import { ConfigService } from '@nestjs/config';
import { FakeClock } from '../../common/clock';
import { OperationRateLimitPolicy } from './operation-rate-limit';
import { OperationRateLimiterService } from './operation-rate-limiter.service';

function makeLimiter(
  clock: FakeClock,
  overrides: Record<string, string | number> = {},
) {
  const configService = {
    get: (key: string) => overrides[key],
  } as unknown as ConfigService;
  return new OperationRateLimiterService(configService, clock);
}

describe('OperationRateLimiterService', () => {
  it('limits the max+1 operation for a policy and credential', () => {
    const limiter = makeLimiter(new FakeClock(0), {
      CLI_COURSES_LIST_RATE_LIMIT_MAX: 2,
      CLI_COURSES_LIST_RATE_LIMIT_WINDOW_MS: 1_000,
    });

    expect(
      limiter.consume(OperationRateLimitPolicy.CLI_COURSES_LIST, 'cred-1'),
    ).toEqual({ limited: false, retryAfterSeconds: 0 });
    expect(
      limiter.consume(OperationRateLimitPolicy.CLI_COURSES_LIST, 'cred-1'),
    ).toEqual({ limited: false, retryAfterSeconds: 0 });
    expect(
      limiter.consume(OperationRateLimitPolicy.CLI_COURSES_LIST, 'cred-1'),
    ).toEqual({ limited: true, retryAfterSeconds: 1 });
  });

  it('allows the same policy and credential again after a FakeClock expiry', () => {
    const clock = new FakeClock(10_000);
    const limiter = makeLimiter(clock, {
      CLI_COURSES_LIST_RATE_LIMIT_MAX: 1,
      CLI_COURSES_LIST_RATE_LIMIT_WINDOW_MS: 1_000,
    });

    limiter.consume(OperationRateLimitPolicy.CLI_COURSES_LIST, 'cred-1');
    expect(
      limiter.consume(OperationRateLimitPolicy.CLI_COURSES_LIST, 'cred-1'),
    ).toEqual({ limited: true, retryAfterSeconds: 1 });

    clock.advance(1_001);

    expect(
      limiter.consume(OperationRateLimitPolicy.CLI_COURSES_LIST, 'cred-1'),
    ).toEqual({ limited: false, retryAfterSeconds: 0 });
  });

  it('isolates buckets by policy and credential key', () => {
    const limiter = makeLimiter(new FakeClock(0), {
      CLI_COURSES_LIST_RATE_LIMIT_MAX: 1,
      CLI_COURSES_LIST_RATE_LIMIT_WINDOW_MS: 1_000,
      CLI_COURSES_CREATE_RATE_LIMIT_MAX: 1,
      CLI_COURSES_CREATE_RATE_LIMIT_WINDOW_MS: 1_000,
    });

    expect(
      limiter.consume(OperationRateLimitPolicy.CLI_COURSES_LIST, 'cred-1'),
    ).toEqual({ limited: false, retryAfterSeconds: 0 });
    expect(
      limiter.consume(OperationRateLimitPolicy.CLI_COURSES_LIST, 'cred-1'),
    ).toEqual({ limited: true, retryAfterSeconds: 1 });
    expect(
      limiter.consume(OperationRateLimitPolicy.CLI_COURSES_LIST, 'cred-2'),
    ).toEqual({ limited: false, retryAfterSeconds: 0 });
    expect(
      limiter.consume(OperationRateLimitPolicy.CLI_COURSES_CREATE, 'cred-1'),
    ).toEqual({ limited: false, retryAfterSeconds: 0 });
  });

  it('coerces string config values before enforcing limits and TTLs', () => {
    const clock = new FakeClock(0);
    const limiter = makeLimiter(clock, {
      CLI_COURSES_LIST_RATE_LIMIT_MAX: '2',
      CLI_COURSES_LIST_RATE_LIMIT_WINDOW_MS: '1000',
    });

    expect(
      limiter.getConfig(OperationRateLimitPolicy.CLI_COURSES_LIST),
    ).toEqual({
      max: 2,
      windowMs: 1_000,
    });
    limiter.consume(OperationRateLimitPolicy.CLI_COURSES_LIST, 'cred-1');
    limiter.consume(OperationRateLimitPolicy.CLI_COURSES_LIST, 'cred-1');
    expect(
      limiter.consume(OperationRateLimitPolicy.CLI_COURSES_LIST, 'cred-1'),
    ).toEqual({ limited: true, retryAfterSeconds: 1 });

    clock.advance(1_001);

    expect(
      limiter.consume(OperationRateLimitPolicy.CLI_COURSES_LIST, 'cred-1'),
    ).toEqual({ limited: false, retryAfterSeconds: 0 });
  });
});
