import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateIf,
  validateSync,
} from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RealtimeRedisMode } from '../modules/realtime/live-session-realtime-contract';

export type NodeEnv = 'development' | 'test' | 'production';

/**
 * Typed environment configuration.
 *
 * Validated at bootstrap time so missing/invalid required values fail fast
 * instead of producing cryptic runtime errors. Secrets that must be present
 * only in certain phases (e.g. COOKIE_SECRET for Phase 2 auth) are declared
 * here as soon as the bootstrap depends on them.
 */
export class EnvConfig {
  @IsEnum(['development', 'test', 'production'])
  NODE_ENV: NodeEnv = 'development';

  @IsNumber()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  @IsString()
  DATABASE_URL!: string;

  @IsString()
  CORS_ORIGIN!: string;

  @IsString()
  COOKIE_SECRET!: string;

  // Explicit deployment boundary: 0 for direct access, 1 for one Nginx hop.
  @IsNumber()
  @Min(0)
  @Max(10)
  TRUST_PROXY_HOPS = 0;

  @IsNumber()
  @Min(1000)
  @Max(120_000)
  SHUTDOWN_TIMEOUT_MS = 10_000;

  // Redis is optional for single-instance realtime; the explicit mode controls
  // whether an unavailable adapter is healthy, degraded, or traffic-blocking.
  @IsOptional()
  @IsString()
  REDIS_URL?: string;

  @IsEnum(['off', 'optional', 'required'])
  REALTIME_REDIS_MODE: RealtimeRedisMode = RealtimeRedisMode.OFF;

  // Web Session lifetime (M2 關鍵技術決策 §4). Idle 30m, absolute 8h defaults.
  @IsNumber()
  @Min(1)
  SESSION_IDLE_MS = 30 * 60 * 1000;

  @IsNumber()
  @Min(60_000)
  @Max(24 * 60 * 60 * 1000)
  SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;

  // __Host- cookies require Secure. Tests run over plain HTTP via supertest,
  // so this toggle lets the test env disable Secure while keeping production
  // Secure-by-default. Production must never set this to false.
  @IsOptional()
  @IsBoolean()
  SESSION_COOKIE_SECURE?: boolean;

  // Test-only transport failpoint token; bootstrap still gates activation on NODE_ENV=test.
  @IsOptional()
  @IsString()
  FE42_RESPONSE_LOSS_TOKEN?: string;

  // One-time bootstrap credentials are consumed only by the bootstrap CLI.
  @IsOptional()
  @IsString()
  BOOTSTRAP_ADMIN_USERNAME?: string;

  @IsOptional()
  @IsString()
  BOOTSTRAP_ADMIN_PASSWORD?: string;

  @IsOptional()
  @IsString()
  BOOTSTRAP_ADMIN_DISPLAY_NAME?: string;

  // Login rate limit (US-F7 / R-F7-7). Production requires shared Redis;
  // development/test retain the in-memory default for DB-free tests.
  @IsEnum(['memory', 'redis-required'])
  LOGIN_RATE_LIMIT_MODE: 'memory' | 'redis-required' = 'memory';

  @ValidateIf((config) => config.LOGIN_RATE_LIMIT_MODE === 'redis-required')
  @IsString()
  LOGIN_RATE_LIMIT_REDIS_URL?: string;

  @ValidateIf((config) => config.LOGIN_RATE_LIMIT_MODE === 'redis-required')
  @IsString()
  @MinLength(32)
  LOGIN_RATE_LIMIT_KEY_SECRET?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  LOGIN_RATE_LIMIT_CONNECT_TIMEOUT_MS?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  LOGIN_RATE_LIMIT_COMMAND_TIMEOUT_MS?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  LOGIN_RATE_LIMIT_ACCOUNT_MAX?: number;

  @IsOptional()
  @IsNumber()
  @Min(1000)
  LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  LOGIN_RATE_LIMIT_SOURCE_MAX?: number;

  @IsOptional()
  @IsNumber()
  @Min(1000)
  LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS?: number;

  // Per-CLI-credential operation limits (CP4, in-memory single instance).
  @IsOptional()
  @IsNumber()
  @Min(1)
  CLI_COURSES_LIST_RATE_LIMIT_MAX?: number;

  @IsOptional()
  @IsNumber()
  @Min(1000)
  CLI_COURSES_LIST_RATE_LIMIT_WINDOW_MS?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  CLI_COURSES_CREATE_RATE_LIMIT_MAX?: number;

  @IsOptional()
  @IsNumber()
  @Min(1000)
  CLI_COURSES_CREATE_RATE_LIMIT_WINDOW_MS?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  CLI_BATCH_VALIDATE_RATE_LIMIT_MAX?: number;

  @IsOptional()
  @IsNumber()
  @Min(1000)
  CLI_BATCH_VALIDATE_RATE_LIMIT_WINDOW_MS?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  CLI_BATCH_CONFIRM_RATE_LIMIT_MAX?: number;

  @IsOptional()
  @IsNumber()
  @Min(1000)
  CLI_BATCH_CONFIRM_RATE_LIMIT_WINDOW_MS?: number;

  // Active LiveSession hard limit and maintenance sweep interval.
  @IsNumber()
  @Min(1)
  LIVE_SESSION_AUTO_CLOSE_MS = 8 * 60 * 60 * 1000;

  @IsNumber()
  @Min(1000)
  LIVE_SESSION_AUTO_CLOSE_TICK_MS = 60 * 1000;

  @IsBoolean()
  RETENTION_OPERATIONS_ENABLED = false;

  @IsBoolean()
  RETENTION_PURGE_ENABLED = false;

  // Per-operation authorization and recurring scheduler startup are separate
  // gates beneath RETENTION_OPERATIONS_ENABLED. One-shot operator commands keep
  // the scheduler gate false so application-context startup cannot trigger an
  // additional sweep before the explicit CLI invocation.
  @IsBoolean()
  RETENTION_PURGE_SCHEDULER_ENABLED = false;

  @IsNumber()
  @Min(60_000)
  @Max(24 * 60 * 60 * 1000)
  RETENTION_PURGE_TICK_MS = 15 * 60 * 1000;

  @IsNumber()
  @Min(1)
  @Max(100)
  RETENTION_PURGE_BATCH_SIZE = 50;

  // Retention purge worker lease/max-attempt budget (BE-5.2 Checkpoint E).
  // Defaults mirror the pre-existing hardcoded values so existing deployments are
  // unaffected until they opt in. A purge item whose lease exceeds this window is
  // reclaimed by another worker; a row exceeding max attempts is quarantined.
  @IsOptional()
  @IsNumber()
  @Min(1000)
  RETENTION_PURGE_LEASE_MS?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  RETENTION_PURGE_MAX_ATTEMPTS?: number;

  // Independent retention worker: manifest export. Disabled by default; durable
  // manifest export requires a durable S3 provider in production (fail-closed rule
  // below). The purge loop and this loop have fully independent enable/tick/batch so
  // they can be paused, scaled, or retuned without coupling.
  @IsBoolean()
  RETENTION_MANIFEST_EXPORT_ENABLED = false;

  @IsBoolean()
  RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED = false;

  @IsNumber()
  @Min(60_000)
  @Max(24 * 60 * 60 * 1000)
  RETENTION_MANIFEST_EXPORT_TICK_MS = 15 * 60 * 1000;

  @IsNumber()
  @Min(1)
  @Max(100)
  RETENTION_MANIFEST_EXPORT_BATCH_SIZE = 50;

  @IsEnum(['local', 's3'])
  DELETION_MANIFEST_PROVIDER: 'local' | 's3' = 'local';

  @ValidateIf((config) => config.DELETION_MANIFEST_PROVIDER === 's3')
  @IsString()
  S3_ENDPOINT?: string;

  @ValidateIf((config) => config.DELETION_MANIFEST_PROVIDER === 's3')
  @IsString()
  S3_REGION?: string;

  @ValidateIf((config) => config.DELETION_MANIFEST_PROVIDER === 's3')
  @IsString()
  S3_BUCKET?: string;

  @IsOptional()
  @IsString()
  S3_PREFIX = 'deletion-manifests';

  @ValidateIf((config) => config.DELETION_MANIFEST_PROVIDER === 's3')
  @IsString()
  @MinLength(1)
  S3_ACCESS_KEY_ID?: string;

  @ValidateIf((config) => config.DELETION_MANIFEST_PROVIDER === 's3')
  @IsString()
  @MinLength(1)
  S3_SECRET_ACCESS_KEY?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  S3_OBJECT_LOCK_DAYS = 90;

  /** 'AES256' (default) | 'aws:kms' | 'none' for stores without SSE support. */
  @IsOptional()
  @IsIn(['AES256', 'aws:kms', 'none'])
  S3_SERVER_SIDE_ENCRYPTION?: 'AES256' | 'aws:kms' | 'none';

  /** Required when S3_SERVER_SIDE_ENCRYPTION=aws:kms. */
  @IsOptional()
  @IsString()
  S3_KMS_KEY_ID?: string;
}

/**
 * Validate and parse raw env into a typed `EnvConfig`.
 * Used as the ConfigModule `validate` hook so it runs against the env AFTER
 * dotenv has loaded the envFilePath — process.env values are merged with the
 * parsed file. Throws on the first validation error (fail fast, no silent
 * defaults for required values).
 */
export function validateEnv(
  raw: Record<string, string | undefined> = process.env,
): EnvConfig {
  // ConfigModule's `validate` passes the parsed file env; merge with
  // process.env so explicit process env wins and defaults apply.
  const num = (v: string | undefined, fallback: number): number =>
    v != null && v !== '' ? Number(v) : fallback;
  const optionalNum = (v: string | undefined): number | undefined =>
    v != null && v !== '' ? Number(v) : undefined;
  const bool = (v: string | undefined): boolean | undefined =>
    v == null || v === '' ? undefined : v === 'true' || v === '1';

  const merged: Record<string, unknown> = {
    ...raw,
    PORT: num(raw.PORT, 3000),
    TRUST_PROXY_HOPS: num(raw.TRUST_PROXY_HOPS, 0),
    SHUTDOWN_TIMEOUT_MS: num(raw.SHUTDOWN_TIMEOUT_MS, 10_000),
    SESSION_IDLE_MS: num(raw.SESSION_IDLE_MS, 30 * 60 * 1000),
    SESSION_ABSOLUTE_MS: num(raw.SESSION_ABSOLUTE_MS, 8 * 60 * 60 * 1000),
    LIVE_SESSION_AUTO_CLOSE_MS: num(
      raw.LIVE_SESSION_AUTO_CLOSE_MS,
      8 * 60 * 60 * 1000,
    ),
    LIVE_SESSION_AUTO_CLOSE_TICK_MS: num(
      raw.LIVE_SESSION_AUTO_CLOSE_TICK_MS,
      60 * 1000,
    ),
    RETENTION_OPERATIONS_ENABLED:
      bool(raw.RETENTION_OPERATIONS_ENABLED) ?? false,
    RETENTION_PURGE_ENABLED: bool(raw.RETENTION_PURGE_ENABLED) ?? false,
    RETENTION_PURGE_SCHEDULER_ENABLED:
      bool(raw.RETENTION_PURGE_SCHEDULER_ENABLED) ?? false,
    RETENTION_PURGE_TICK_MS: num(raw.RETENTION_PURGE_TICK_MS, 15 * 60 * 1000),
    RETENTION_PURGE_BATCH_SIZE: num(raw.RETENTION_PURGE_BATCH_SIZE, 50),
    RETENTION_PURGE_LEASE_MS: optionalNum(raw.RETENTION_PURGE_LEASE_MS),
    RETENTION_PURGE_MAX_ATTEMPTS: optionalNum(raw.RETENTION_PURGE_MAX_ATTEMPTS),
    RETENTION_MANIFEST_EXPORT_ENABLED:
      bool(raw.RETENTION_MANIFEST_EXPORT_ENABLED) ?? false,
    RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED:
      bool(raw.RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED) ?? false,
    RETENTION_MANIFEST_EXPORT_TICK_MS: num(
      raw.RETENTION_MANIFEST_EXPORT_TICK_MS,
      15 * 60 * 1000,
    ),
    RETENTION_MANIFEST_EXPORT_BATCH_SIZE: num(
      raw.RETENTION_MANIFEST_EXPORT_BATCH_SIZE,
      50,
    ),
    DELETION_MANIFEST_PROVIDER: raw.DELETION_MANIFEST_PROVIDER || 'local',
    S3_PREFIX: raw.S3_PREFIX || 'deletion-manifests',
    S3_OBJECT_LOCK_DAYS: num(raw.S3_OBJECT_LOCK_DAYS, 90),
    S3_KMS_KEY_ID: raw.S3_KMS_KEY_ID || undefined,
    REALTIME_REDIS_MODE: raw.REALTIME_REDIS_MODE || RealtimeRedisMode.OFF,
    LOGIN_RATE_LIMIT_MODE:
      raw.LOGIN_RATE_LIMIT_MODE ||
      (raw.NODE_ENV === 'production' ? 'redis-required' : 'memory'),
    LOGIN_RATE_LIMIT_CONNECT_TIMEOUT_MS: optionalNum(
      raw.LOGIN_RATE_LIMIT_CONNECT_TIMEOUT_MS,
    ),
    LOGIN_RATE_LIMIT_COMMAND_TIMEOUT_MS: optionalNum(
      raw.LOGIN_RATE_LIMIT_COMMAND_TIMEOUT_MS,
    ),
    LOGIN_RATE_LIMIT_ACCOUNT_MAX: optionalNum(raw.LOGIN_RATE_LIMIT_ACCOUNT_MAX),
    LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS: optionalNum(
      raw.LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS,
    ),
    LOGIN_RATE_LIMIT_SOURCE_MAX: optionalNum(raw.LOGIN_RATE_LIMIT_SOURCE_MAX),
    LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS: optionalNum(
      raw.LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS,
    ),
    SESSION_COOKIE_SECURE: bool(raw.SESSION_COOKIE_SECURE),
    CLI_COURSES_LIST_RATE_LIMIT_MAX: optionalNum(
      raw.CLI_COURSES_LIST_RATE_LIMIT_MAX,
    ),
    CLI_COURSES_LIST_RATE_LIMIT_WINDOW_MS: optionalNum(
      raw.CLI_COURSES_LIST_RATE_LIMIT_WINDOW_MS,
    ),
    CLI_COURSES_CREATE_RATE_LIMIT_MAX: optionalNum(
      raw.CLI_COURSES_CREATE_RATE_LIMIT_MAX,
    ),
    CLI_COURSES_CREATE_RATE_LIMIT_WINDOW_MS: optionalNum(
      raw.CLI_COURSES_CREATE_RATE_LIMIT_WINDOW_MS,
    ),
    CLI_BATCH_VALIDATE_RATE_LIMIT_MAX: optionalNum(
      raw.CLI_BATCH_VALIDATE_RATE_LIMIT_MAX,
    ),
    CLI_BATCH_VALIDATE_RATE_LIMIT_WINDOW_MS: optionalNum(
      raw.CLI_BATCH_VALIDATE_RATE_LIMIT_WINDOW_MS,
    ),
    CLI_BATCH_CONFIRM_RATE_LIMIT_MAX: optionalNum(
      raw.CLI_BATCH_CONFIRM_RATE_LIMIT_MAX,
    ),
    CLI_BATCH_CONFIRM_RATE_LIMIT_WINDOW_MS: optionalNum(
      raw.CLI_BATCH_CONFIRM_RATE_LIMIT_WINDOW_MS,
    ),
  };

  const config = plainToInstance(EnvConfig, merged, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(config, { whitelist: true });
  if (errors.length > 0) {
    const messages = errors
      .flatMap((e) => Object.values(e.constraints ?? {}))
      .join('; ');
    throw new Error(`Invalid environment configuration: ${messages}`);
  }
  if (config.NODE_ENV !== 'test' && config.SESSION_COOKIE_SECURE === false) {
    throw new Error(
      'SESSION_COOKIE_SECURE=false is only allowed in NODE_ENV=test',
    );
  }
  if (
    config.NODE_ENV === 'production' &&
    config.LOGIN_RATE_LIMIT_MODE !== 'redis-required'
  ) {
    throw new Error(
      'LOGIN_RATE_LIMIT_MODE=memory is not allowed in NODE_ENV=production',
    );
  }
  if (
    config.LOGIN_RATE_LIMIT_MODE === 'redis-required' &&
    config.LOGIN_RATE_LIMIT_REDIS_URL
  ) {
    let parsed: URL;
    try {
      parsed = new URL(config.LOGIN_RATE_LIMIT_REDIS_URL);
    } catch {
      throw new Error('LOGIN_RATE_LIMIT_REDIS_URL must be a valid Redis URL');
    }
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      throw new Error(
        'LOGIN_RATE_LIMIT_REDIS_URL must use redis:// or rediss://',
      );
    }
  }
  if (config.CORS_ORIGIN.split(',').some((origin) => origin.trim() === '*')) {
    throw new Error('CORS_ORIGIN must not contain a wildcard origin');
  }
  if (
    config.RETENTION_PURGE_SCHEDULER_ENABLED &&
    (!config.RETENTION_OPERATIONS_ENABLED || !config.RETENTION_PURGE_ENABLED)
  ) {
    throw new Error(
      'RETENTION_PURGE_SCHEDULER_ENABLED requires RETENTION_OPERATIONS_ENABLED and RETENTION_PURGE_ENABLED',
    );
  }
  if (
    config.RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED &&
    (!config.RETENTION_OPERATIONS_ENABLED ||
      !config.RETENTION_MANIFEST_EXPORT_ENABLED)
  ) {
    throw new Error(
      'RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED requires RETENTION_OPERATIONS_ENABLED and RETENTION_MANIFEST_EXPORT_ENABLED',
    );
  }
  // Deletion-manifest durability (BE-5 CP2 Checkpoint B). The process-local
  // provider cannot be durable across replicas, and a purge that cannot
  // export a durable manifest must not be enabled. Enforce in code, not
  // comments alone. The purge check runs first so a purge-without-durable-
  // provider misconfiguration reports its specific cause rather than the
  // generic local-provider rejection.
  if (
    config.NODE_ENV === 'production' &&
    config.RETENTION_PURGE_ENABLED &&
    config.DELETION_MANIFEST_PROVIDER !== 's3'
  ) {
    throw new Error(
      'RETENTION_PURGE_ENABLED requires a durable S3 manifest provider in NODE_ENV=production',
    );
  }
  if (
    config.NODE_ENV === 'production' &&
    config.RETENTION_MANIFEST_EXPORT_ENABLED &&
    config.DELETION_MANIFEST_PROVIDER !== 's3'
  ) {
    throw new Error(
      'RETENTION_MANIFEST_EXPORT_ENABLED requires a durable S3 manifest provider in NODE_ENV=production',
    );
  }
  if (
    config.NODE_ENV === 'production' &&
    config.DELETION_MANIFEST_PROVIDER === 'local'
  ) {
    throw new Error(
      'DELETION_MANIFEST_PROVIDER=local is not allowed in NODE_ENV=production',
    );
  }
  if (
    config.NODE_ENV === 'production' &&
    config.S3_SERVER_SIDE_ENCRYPTION === 'none'
  ) {
    throw new Error(
      'S3_SERVER_SIDE_ENCRYPTION=none is not allowed in NODE_ENV=production',
    );
  }
  if (config.S3_SERVER_SIDE_ENCRYPTION === 'aws:kms' && !config.S3_KMS_KEY_ID) {
    throw new Error('S3_SERVER_SIDE_ENCRYPTION=aws:kms requires S3_KMS_KEY_ID');
  }
  if (
    config.NODE_ENV === 'production' &&
    config.DELETION_MANIFEST_PROVIDER === 's3' &&
    config.S3_ENDPOINT
  ) {
    let parsed: URL;
    try {
      parsed = new URL(config.S3_ENDPOINT);
    } catch {
      throw new Error('S3_ENDPOINT must be a valid URL');
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('S3_ENDPOINT must use https: in NODE_ENV=production');
    }
  }
  return config;
}
