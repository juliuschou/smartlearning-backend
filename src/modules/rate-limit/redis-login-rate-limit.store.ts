import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type RedisClientType } from 'redis';
import { RateLimitUnavailableError } from '../../common/errors';
import type {
  LoginRateLimitAvailability,
  LoginRateLimitStore,
} from './login-rate-limit-store';
import type {
  RateLimitConfig,
  RateLimitDecision,
} from './rate-limiter.service';
import { LoginRateLimitKeyFactory } from './login-rate-limit-key.factory';

const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 500;
const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 30_000;

const PRECHECK_SCRIPT = `
local limited = 0
local retry = 0
for i, key in ipairs(KEYS) do
  local value = redis.call('GET', key)
  if value then
    local ttl = redis.call('PTTL', key)
    local count = tonumber(value)
    if not count or math.floor(count) ~= count or ttl < 0 then
      return { -1, 0 }
    end
    local max = tonumber(ARGV[i])
    if count >= max then
      limited = 1
      if ttl > retry then retry = ttl end
    end
  end
end
return { limited, retry }
`;

const RECORD_FAILURE_SCRIPT = `
-- Validate both buckets before mutating either one, so corruption cannot leave
-- the account and source scopes partially updated.
for _, key in ipairs(KEYS) do
  local value = redis.call('GET', key)
  if value then
    local count = tonumber(value)
    if not count or math.floor(count) ~= count then
      return -1
    end
  end
end
for i, key in ipairs(KEYS) do
  local value = redis.call('GET', key)
  local ttl = redis.call('PTTL', key)
  if not value or ttl == -2 or ttl < 0 then
    redis.call('SET', key, '1', 'PX', ARGV[i])
  else
    redis.call('INCR', key)
  end
end
return 1
`;

const CLEAR_ACCOUNT_SCRIPT = `
return redis.call('DEL', KEYS[1])
`;

type RedisClient = RedisClientType;

/** Redis-backed shared fixed-window login limiter. */
@Injectable()
export class RedisLoginRateLimitStore
  implements LoginRateLimitStore, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RedisLoginRateLimitStore.name);
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly mode: string | undefined;
  private client?: RedisClient;
  private available = false;
  private stopped = false;
  private retryTimer?: NodeJS.Timeout;
  private retryAttempt = 0;
  private initializing?: Promise<void>;
  private clientGeneration = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly keys: LoginRateLimitKeyFactory,
  ) {
    this.mode = this.config.get<string>('LOGIN_RATE_LIMIT_MODE');
    this.connectTimeoutMs = this.number(
      'LOGIN_RATE_LIMIT_CONNECT_TIMEOUT_MS',
      DEFAULT_CONNECT_TIMEOUT_MS,
    );
    this.commandTimeoutMs = this.number(
      'LOGIN_RATE_LIMIT_COMMAND_TIMEOUT_MS',
      DEFAULT_COMMAND_TIMEOUT_MS,
    );
  }

  get availability(): LoginRateLimitAvailability {
    return this.available ? 'available' : 'unavailable';
  }

  async onModuleInit(): Promise<void> {
    if (this.mode !== 'redis-required') return;
    await this.initialize();
  }

  async onModuleDestroy(): Promise<void> {
    await this.destroy();
  }

  async destroy(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    await this.close();
  }

  async initialize(): Promise<void> {
    if (this.mode !== 'redis-required' || this.stopped || this.available)
      return;
    if (this.initializing) return this.initializing;
    this.initializing = this.connect();
    try {
      await this.initializing;
    } finally {
      this.initializing = undefined;
    }
    if (!this.available) this.scheduleReconnect();
  }

  async check(
    accountKey: string,
    sourceKey: string,
    config: RateLimitConfig,
  ): Promise<RateLimitDecision> {
    const result = await this.eval<unknown[]>(
      PRECHECK_SCRIPT,
      [this.keys.account(accountKey), this.keys.source(sourceKey)],
      [String(config.accountMax), String(config.sourceMax)],
    );
    if (Number(result[0]) < 0) throw new RateLimitUnavailableError();
    if (Number(result[0]) === 0)
      return { limited: false, retryAfterSeconds: 0 };
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil(Number(result[1]) / 1000)),
    };
  }

  async recordFailure(
    accountKey: string,
    sourceKey: string,
    config: RateLimitConfig,
  ): Promise<void> {
    const result = await this.eval<number>(
      RECORD_FAILURE_SCRIPT,
      [this.keys.account(accountKey), this.keys.source(sourceKey)],
      [String(config.accountWindowMs), String(config.sourceWindowMs)],
    );
    if (Number(result) < 0) throw new RateLimitUnavailableError();
  }

  async clearOnSuccess(accountKey: string): Promise<void> {
    await this.eval<number>(
      CLEAR_ACCOUNT_SCRIPT,
      [this.keys.account(accountKey)],
      [],
    );
  }

  async close(): Promise<void> {
    this.available = false;
    const client = this.client;
    this.client = undefined;
    if (!client?.isOpen) return;
    try {
      await client.close();
    } catch (error) {
      this.logger.debug(
        { errorType: error instanceof Error ? error.name : typeof error },
        'Login rate-limit Redis close failed',
      );
    }
  }

  private async connect(): Promise<void> {
    const url = this.config.get<string>('LOGIN_RATE_LIMIT_REDIS_URL');
    if (!url) {
      this.markUnavailable('missing_url');
      return;
    }

    const client = createClient({
      url,
      socket: {
        connectTimeout: this.connectTimeoutMs,
        reconnectStrategy: false,
      },
    });
    const generation = ++this.clientGeneration;
    this.client = client;
    client.on('error', () => {
      if (this.client !== client || this.clientGeneration !== generation)
        return;
      this.markUnavailable('connection_error');
      void this.close().finally(() => this.scheduleReconnect());
    });
    client.on('end', () => {
      if (this.client !== client || this.clientGeneration !== generation)
        return;
      this.markUnavailable('connection_end');
      this.scheduleReconnect();
    });
    client.on('ready', () => {
      if (this.client !== client || this.clientGeneration !== generation)
        return;
      this.available = true;
      this.retryAttempt = 0;
    });

    try {
      await withTimeout(client.connect(), this.connectTimeoutMs);
      if (!client.isReady) {
        this.markUnavailable('not_ready');
        await this.close();
        return;
      }
      this.available = true;
      this.retryAttempt = 0;
    } catch {
      this.markUnavailable('connect_timeout');
      await this.close();
    }
  }

  private async eval<T>(
    script: string,
    keys: string[],
    args: string[],
  ): Promise<T> {
    const client = this.client;
    if (!this.available || !client?.isReady) {
      this.scheduleReconnect();
      throw new RateLimitUnavailableError();
    }
    try {
      return (await withTimeout(
        client.eval(script, { keys, arguments: args }),
        this.commandTimeoutMs,
      )) as T;
    } catch {
      this.markUnavailable('command_error');
      void this.close().finally(() => this.scheduleReconnect());
      throw new RateLimitUnavailableError();
    }
  }

  private markUnavailable(reason: string): void {
    this.available = false;
    this.logger.warn({ reason }, 'Login rate-limit Redis unavailable');
  }

  private scheduleReconnect(): void {
    if (
      this.stopped ||
      this.retryTimer ||
      !this.config.get<string>('LOGIN_RATE_LIMIT_REDIS_URL')
    ) {
      return;
    }
    const delay = Math.min(
      RETRY_MAX_MS,
      RETRY_INITIAL_MS * 2 ** this.retryAttempt,
    );
    this.retryAttempt = Math.min(this.retryAttempt + 1, 5);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.initialize();
    }, delay);
  }

  private number(key: string, fallback: number): number {
    const raw = this.config.get<string | number>(key);
    const value =
      raw === undefined || raw === null || raw === '' ? fallback : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
