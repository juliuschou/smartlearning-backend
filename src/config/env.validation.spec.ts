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
      DELETION_MANIFEST_PROVIDER: 's3',
      S3_ENDPOINT: 'https://s3.example.com',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'manifests',
      S3_ACCESS_KEY_ID: 'access',
      S3_SECRET_ACCESS_KEY: 'secret',
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

  it('requires complete S3 manifest settings when selected', () => {
    expect(() =>
      validateEnv({ ...baseEnv, DELETION_MANIFEST_PROVIDER: 's3' }),
    ).toThrow('Invalid environment configuration:');
  });

  it('preserves local manifest provider as the safe default', () => {
    expect(validateEnv({ ...baseEnv }).DELETION_MANIFEST_PROVIDER).toBe(
      'local',
    );
  });

  it('accepts a complete S3 manifest configuration', () => {
    const config = validateEnv({
      ...baseEnv,
      DELETION_MANIFEST_PROVIDER: 's3',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'manifests',
      S3_ACCESS_KEY_ID: 'access',
      S3_SECRET_ACCESS_KEY: 'secret',
    });
    expect(config.DELETION_MANIFEST_PROVIDER).toBe('s3');
  });

  it('accepts a valid production Redis login configuration', () => {
    const config = validateEnv({
      ...baseEnv,
      NODE_ENV: 'production',
      LOGIN_RATE_LIMIT_MODE: 'redis-required',
      LOGIN_RATE_LIMIT_REDIS_URL: 'redis://localhost:6379',
      LOGIN_RATE_LIMIT_KEY_SECRET: 'a'.repeat(32),
      DELETION_MANIFEST_PROVIDER: 's3',
      S3_ENDPOINT: 'https://s3.example.com',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'manifests',
      S3_ACCESS_KEY_ID: 'access',
      S3_SECRET_ACCESS_KEY: 'secret',
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

  // BE-5 CP2 Checkpoint B — production manifest durability and S3 safety.
  const prodS3 = {
    NODE_ENV: 'production',
    LOGIN_RATE_LIMIT_MODE: 'redis-required',
    LOGIN_RATE_LIMIT_REDIS_URL: 'redis://localhost:6379',
    LOGIN_RATE_LIMIT_KEY_SECRET: 'a'.repeat(32),
    DELETION_MANIFEST_PROVIDER: 's3',
    S3_ENDPOINT: 'https://s3.example.com',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'manifests',
    S3_ACCESS_KEY_ID: 'access',
    S3_SECRET_ACCESS_KEY: 'secret',
  } as const;

  it('rejects the process-local manifest provider in production', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        LOGIN_RATE_LIMIT_MODE: 'redis-required',
        LOGIN_RATE_LIMIT_REDIS_URL: 'redis://localhost:6379',
        LOGIN_RATE_LIMIT_KEY_SECRET: 'a'.repeat(32),
        DELETION_MANIFEST_PROVIDER: 'local',
      }),
    ).toThrow('DELETION_MANIFEST_PROVIDER=local is not allowed');
  });

  it('rejects none encryption in production', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        ...prodS3,
        S3_SERVER_SIDE_ENCRYPTION: 'none',
      }),
    ).toThrow('S3_SERVER_SIDE_ENCRYPTION=none is not allowed');
  });

  it('requires a KMS key id when aws:kms is selected', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        ...prodS3,
        S3_SERVER_SIDE_ENCRYPTION: 'aws:kms',
      }),
    ).toThrow('S3_SERVER_SIDE_ENCRYPTION=aws:kms requires S3_KMS_KEY_ID');
  });

  it('accepts aws:kms with an explicit key id', () => {
    const config = validateEnv({
      ...baseEnv,
      ...prodS3,
      S3_SERVER_SIDE_ENCRYPTION: 'aws:kms',
      S3_KMS_KEY_ID: 'arn:aws:kms:us-east-1:123456789012:key/abc',
    });
    expect(config.S3_KMS_KEY_ID).toBe(
      'arn:aws:kms:us-east-1:123456789012:key/abc',
    );
  });

  it('rejects a non-https S3 endpoint in production', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        ...prodS3,
        S3_ENDPOINT: 'http://s3.example.com',
      }),
    ).toThrow('S3_ENDPOINT must use https: in NODE_ENV=production');
  });

  it('rejects purge enabled in production without a durable S3 provider', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        LOGIN_RATE_LIMIT_MODE: 'redis-required',
        LOGIN_RATE_LIMIT_REDIS_URL: 'redis://localhost:6379',
        LOGIN_RATE_LIMIT_KEY_SECRET: 'a'.repeat(32),
        DELETION_MANIFEST_PROVIDER: 'local',
        RETENTION_PURGE_ENABLED: 'true',
      }),
    ).toThrow(
      'RETENTION_PURGE_ENABLED requires a durable S3 manifest provider',
    );
  });

  it('allows none encryption outside production (MinIO rehearsal)', () => {
    const config = validateEnv({
      ...baseEnv,
      NODE_ENV: 'test',
      DELETION_MANIFEST_PROVIDER: 's3',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'manifests',
      S3_ACCESS_KEY_ID: 'access',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_SERVER_SIDE_ENCRYPTION: 'none',
    });
    expect(config.S3_SERVER_SIDE_ENCRYPTION).toBe('none');
  });

  // BE-5.2 Checkpoint E — independent purge + manifest-export workers.
  it('defaults the retention purge lease/max-attempts and export fields', () => {
    const config = validateEnv({ ...baseEnv, NODE_ENV: 'test' });
    expect(config.RETENTION_OPERATIONS_ENABLED).toBe(false);
    expect(config.RETENTION_PURGE_SCHEDULER_ENABLED).toBe(false);
    expect(config.RETENTION_MANIFEST_EXPORT_ENABLED).toBe(false);
    expect(config.RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED).toBe(false);
    expect(config.RETENTION_MANIFEST_EXPORT_TICK_MS).toBe(15 * 60 * 1000);
    expect(config.RETENTION_MANIFEST_EXPORT_BATCH_SIZE).toBe(50);
    expect(config.RETENTION_PURGE_LEASE_MS).toBeUndefined();
    expect(config.RETENTION_PURGE_MAX_ATTEMPTS).toBeUndefined();
  });

  it('coerces the retention worker and manifest-export fields from strings', () => {
    const config = validateEnv({
      ...baseEnv,
      NODE_ENV: 'test',
      RETENTION_OPERATIONS_ENABLED: '1',
      RETENTION_PURGE_ENABLED: '1',
      RETENTION_PURGE_SCHEDULER_ENABLED: '1',
      RETENTION_PURGE_LEASE_MS: '25000',
      RETENTION_PURGE_MAX_ATTEMPTS: '7',
      RETENTION_MANIFEST_EXPORT_ENABLED: '1',
      RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED: '1',
      RETENTION_MANIFEST_EXPORT_TICK_MS: '60000',
      RETENTION_MANIFEST_EXPORT_BATCH_SIZE: '10',
    });
    expect(config.RETENTION_PURGE_SCHEDULER_ENABLED).toBe(true);
    expect(config.RETENTION_PURGE_LEASE_MS).toBe(25000);
    expect(config.RETENTION_PURGE_MAX_ATTEMPTS).toBe(7);
    expect(config.RETENTION_MANIFEST_EXPORT_ENABLED).toBe(true);
    expect(config.RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED).toBe(true);
    expect(config.RETENTION_MANIFEST_EXPORT_TICK_MS).toBe(60000);
    expect(config.RETENTION_MANIFEST_EXPORT_BATCH_SIZE).toBe(10);
  });

  it('allows one-shot operation gates while schedulers remain disabled', () => {
    const config = validateEnv({
      ...baseEnv,
      NODE_ENV: 'test',
      RETENTION_PURGE_ENABLED: 'true',
      RETENTION_MANIFEST_EXPORT_ENABLED: 'true',
    });

    expect(config.RETENTION_PURGE_SCHEDULER_ENABLED).toBe(false);
    expect(config.RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED).toBe(false);
  });

  it('rejects a purge scheduler without purge operation authorization', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'test',
        RETENTION_PURGE_SCHEDULER_ENABLED: 'true',
      }),
    ).toThrow(
      'RETENTION_PURGE_SCHEDULER_ENABLED requires RETENTION_OPERATIONS_ENABLED and RETENTION_PURGE_ENABLED',
    );
  });

  it('rejects a manifest-export scheduler without export authorization', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'test',
        RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED: 'true',
      }),
    ).toThrow(
      'RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED requires RETENTION_OPERATIONS_ENABLED and RETENTION_MANIFEST_EXPORT_ENABLED',
    );
  });

  it('rejects manifest export enabled in production without a durable S3 provider', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        LOGIN_RATE_LIMIT_MODE: 'redis-required',
        LOGIN_RATE_LIMIT_REDIS_URL: 'redis://localhost:6379',
        LOGIN_RATE_LIMIT_KEY_SECRET: 'a'.repeat(32),
        DELETION_MANIFEST_PROVIDER: 'local',
        RETENTION_MANIFEST_EXPORT_ENABLED: 'true',
      }),
    ).toThrow(
      'RETENTION_MANIFEST_EXPORT_ENABLED requires a durable S3 manifest provider',
    );
  });
});
