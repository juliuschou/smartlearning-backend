import 'reflect-metadata';
import { validateEnv } from './env.validation';

const baseEnv = {
  DATABASE_URL: 'postgresql://user:password@localhost:5432/db',
  CORS_ORIGIN: 'http://localhost:3000',
  COOKIE_SECRET: 'test-secret',
};

const cliRateLimitEnv = {
  CLI_COURSES_LIST_RATE_LIMIT_MAX: '2',
  CLI_COURSES_LIST_RATE_LIMIT_WINDOW_MS: '1000',
  CLI_COURSES_CREATE_RATE_LIMIT_MAX: '3',
  CLI_COURSES_CREATE_RATE_LIMIT_WINDOW_MS: '2000',
  CLI_BATCH_VALIDATE_RATE_LIMIT_MAX: '4',
  CLI_BATCH_VALIDATE_RATE_LIMIT_WINDOW_MS: '3000',
  CLI_BATCH_CONFIRM_RATE_LIMIT_MAX: '5',
  CLI_BATCH_CONFIRM_RATE_LIMIT_WINDOW_MS: '4000',
} as const;

describe('validateEnv', () => {
  it('allows the plain-HTTP cookie exception only for tests', () => {
    const config = validateEnv({
      ...baseEnv,
      NODE_ENV: 'test',
      SESSION_COOKIE_SECURE: 'false',
    });

    expect(config.SESSION_COOKIE_SECURE).toBe(false);
  });

  it('rejects explicitly disabled secure cookies outside tests', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        LOGIN_RATE_LIMIT_REDIS_URL: 'redis://localhost:6379',
        LOGIN_RATE_LIMIT_KEY_SECRET: 'a'.repeat(32),
        SESSION_COOKIE_SECURE: 'false',
      }),
    ).toThrow('SESSION_COOKIE_SECURE=false is only allowed in NODE_ENV=test');
  });

  it('rejects wildcard CORS origins', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        CORS_ORIGIN: 'http://localhost:3000, *',
      }),
    ).toThrow('CORS_ORIGIN must not contain a wildcard origin');
  });

  it('coerces proxy and shutdown settings from strings', () => {
    const config = validateEnv({
      ...baseEnv,
      NODE_ENV: 'production',
      LOGIN_RATE_LIMIT_MODE: 'redis-required',
      LOGIN_RATE_LIMIT_REDIS_URL: 'redis://localhost:6379',
      LOGIN_RATE_LIMIT_KEY_SECRET: 'a'.repeat(32),
      TRUST_PROXY_HOPS: '1',
      SHUTDOWN_TIMEOUT_MS: '15000',
    });

    expect(config.TRUST_PROXY_HOPS).toBe(1);
    expect(config.SHUTDOWN_TIMEOUT_MS).toBe(15000);
  });

  it.each([
    ['TRUST_PROXY_HOPS', '-1'],
    ['TRUST_PROXY_HOPS', '11'],
    ['SHUTDOWN_TIMEOUT_MS', '999'],
    ['SHUTDOWN_TIMEOUT_MS', '120001'],
  ])('rejects an invalid topology setting for %s', (key, value) => {
    expect(() => validateEnv({ ...baseEnv, [key]: value })).toThrow(
      'Invalid environment configuration:',
    );
  });

  it('coerces all eight CLI rate-limit env fields to numbers', () => {
    const config = validateEnv({
      ...baseEnv,
      NODE_ENV: 'test',
      ...cliRateLimitEnv,
    });

    for (const [key, value] of Object.entries(cliRateLimitEnv)) {
      expect((config as unknown as Record<string, unknown>)[key]).toBe(
        Number(value),
      );
    }
  });

  it('preserves the optional response-loss token in test configuration', () => {
    const config = validateEnv({
      ...baseEnv,
      NODE_ENV: 'test',
      FE42_RESPONSE_LOSS_TOKEN: 'test-only-response-loss-token',
    });

    expect(config.FE42_RESPONSE_LOSS_TOKEN).toBe(
      'test-only-response-loss-token',
    );
  });

  it('defaults login rate limiting to memory outside production', () => {
    const config = validateEnv({ ...baseEnv, NODE_ENV: 'test' });
    expect(config.LOGIN_RATE_LIMIT_MODE).toBe('memory');
  });

  it('coerces login rate-limit settings from strings', () => {
    const config = validateEnv({
      ...baseEnv,
      NODE_ENV: 'test',
      LOGIN_RATE_LIMIT_ACCOUNT_MAX: '3',
      LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS: '1000',
      LOGIN_RATE_LIMIT_SOURCE_MAX: '5',
      LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS: '2000',
      LOGIN_RATE_LIMIT_CONNECT_TIMEOUT_MS: '2000',
      LOGIN_RATE_LIMIT_COMMAND_TIMEOUT_MS: '500',
    });

    expect(config.LOGIN_RATE_LIMIT_ACCOUNT_MAX).toBe(3);
    expect(config.LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS).toBe(1000);
    expect(config.LOGIN_RATE_LIMIT_SOURCE_MAX).toBe(5);
    expect(config.LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS).toBe(2000);
    expect(config.LOGIN_RATE_LIMIT_CONNECT_TIMEOUT_MS).toBe(2000);
    expect(config.LOGIN_RATE_LIMIT_COMMAND_TIMEOUT_MS).toBe(500);
  });

  it('requires Redis settings for redis-required mode', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'test',
        LOGIN_RATE_LIMIT_MODE: 'redis-required',
      }),
    ).toThrow('Invalid environment configuration:');
  });

  it('rejects memory login limiting in production', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        LOGIN_RATE_LIMIT_MODE: 'memory',
      }),
    ).toThrow('LOGIN_RATE_LIMIT_MODE=memory is not allowed');
  });

  it('accepts a valid production Redis login configuration', () => {
    const config = validateEnv({
      ...baseEnv,
      NODE_ENV: 'production',
      LOGIN_RATE_LIMIT_MODE: 'redis-required',
      LOGIN_RATE_LIMIT_REDIS_URL: 'redis://localhost:6379',
      LOGIN_RATE_LIMIT_KEY_SECRET: 'a'.repeat(32),
    });
    expect(config.LOGIN_RATE_LIMIT_MODE).toBe('redis-required');
  });

  it.each([
    ['LOGIN_RATE_LIMIT_ACCOUNT_MAX', '0'],
    ['LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS', '999'],
    ['LOGIN_RATE_LIMIT_SOURCE_MAX', '0'],
    ['LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS', '999'],
    ['LOGIN_RATE_LIMIT_CONNECT_TIMEOUT_MS', '0'],
    ['LOGIN_RATE_LIMIT_COMMAND_TIMEOUT_MS', '0'],
  ])('rejects an invalid login rate-limit bound for %s', (key, value) => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'test',
        [key]: value,
      }),
    ).toThrow('Invalid environment configuration:');
  });

  it.each([
    ['CLI_COURSES_LIST_RATE_LIMIT_MAX', '0'],
    ['CLI_COURSES_LIST_RATE_LIMIT_WINDOW_MS', '999'],
    ['CLI_COURSES_CREATE_RATE_LIMIT_MAX', '0'],
    ['CLI_COURSES_CREATE_RATE_LIMIT_WINDOW_MS', '999'],
    ['CLI_BATCH_VALIDATE_RATE_LIMIT_MAX', '0'],
    ['CLI_BATCH_VALIDATE_RATE_LIMIT_WINDOW_MS', '999'],
    ['CLI_BATCH_CONFIRM_RATE_LIMIT_MAX', '0'],
    ['CLI_BATCH_CONFIRM_RATE_LIMIT_WINDOW_MS', '999'],
  ])('rejects an invalid CLI rate-limit bound for %s', (key, value) => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        [key]: value,
      }),
    ).toThrow('Invalid environment configuration:');
  });
});
