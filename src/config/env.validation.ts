import {
  IsBoolean,
  IsEnum,
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
  return config;
}
