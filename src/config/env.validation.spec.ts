import 'reflect-metadata';
import { validateEnv } from './env.validation';

const baseEnv = {
  DATABASE_URL: 'postgresql://user:password@localhost:5432/db',
  CORS_ORIGIN: 'http://localhost:3000',
  COOKIE_SECRET: 'test-secret',
};

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
});
