import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';
import { plainToInstance } from 'class-transformer';

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

  // Redis is optional until Phase 7/9; presence flips the readiness check.
  @IsOptional()
  @IsString()
  REDIS_URL?: string;

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
  const bool = (v: string | undefined): boolean | undefined =>
    v == null || v === '' ? undefined : v === 'true' || v === '1';

  const merged: Record<string, unknown> = {
    ...raw,
    PORT: num(raw.PORT, 3000),
    SESSION_IDLE_MS: num(raw.SESSION_IDLE_MS, 30 * 60 * 1000),
    SESSION_ABSOLUTE_MS: num(raw.SESSION_ABSOLUTE_MS, 8 * 60 * 60 * 1000),
    SESSION_COOKIE_SECURE: bool(raw.SESSION_COOKIE_SECURE),
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
  return config;
}
