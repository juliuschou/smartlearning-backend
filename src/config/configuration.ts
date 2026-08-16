import { validateEnv, type EnvConfig, type NodeEnv } from './env.validation';

/**
 * Typed configuration loader for `ConfigModule.forRoot({ load: [configuration] })`.
 *
 * `ConfigService.get<T>('key')` returns typed values; nested access via
 * `config()` is also available. Validates on load.
 */
export function configuration(): EnvConfig {
  return validateEnv(process.env);
}

export { EnvConfig, NodeEnv };
