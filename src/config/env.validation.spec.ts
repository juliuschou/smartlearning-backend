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
