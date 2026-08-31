import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock } from '../../common/clock';
import { RateLimitUnavailableError } from '../../common/errors';
import {
  MEMORY_LOGIN_RATE_LIMIT_STORE,
  REDIS_LOGIN_RATE_LIMIT_STORE,
  type LoginRateLimitStore,
} from './login-rate-limit-store';
import { MemoryLoginRateLimitStore } from './memory-login-rate-limit.store';

export type LoginRateLimitMode = 'memory' | 'redis-required';

export interface RateLimitConfig {
  accountMax: number;
  accountWindowMs: number;
  sourceMax: number;
  sourceWindowMs: number;
}

export interface RateLimitDecision {
  limited: boolean;
  retryAfterSeconds: number;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  accountMax: 10,
  accountWindowMs: 5 * 60 * 1000,
  sourceMax: 20,
  sourceWindowMs: 5 * 60 * 1000,
};

export function normalizeRateLimitAccountKey(identifier: string): string {
  return identifier.normalize('NFKC').trim().toLowerCase();
}

@Injectable()
export class RateLimiterService implements OnModuleDestroy {
  private readonly config: RateLimitConfig;
  private readonly mode: LoginRateLimitMode;
  private readonly store?: LoginRateLimitStore;
  private readonly memoryStore?: MemoryLoginRateLimitStore;

  constructor(
    private readonly configService: ConfigService,
    @Optional() clock?: Clock,
    @Optional()
    @Inject(MEMORY_LOGIN_RATE_LIMIT_STORE)
    memoryStore?: LoginRateLimitStore,
    @Optional()
    @Inject(REDIS_LOGIN_RATE_LIMIT_STORE)
    redisStore?: LoginRateLimitStore,
  ) {
    this.mode = this.parseMode(
      this.configService.get<string>('LOGIN_RATE_LIMIT_MODE'),
    );
    this.config = {
      accountMax: this.number(
        'LOGIN_RATE_LIMIT_ACCOUNT_MAX',
        DEFAULT_RATE_LIMIT_CONFIG.accountMax,
      ),
      accountWindowMs: this.number(
        'LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS',
        DEFAULT_RATE_LIMIT_CONFIG.accountWindowMs,
      ),
      sourceMax: this.number(
        'LOGIN_RATE_LIMIT_SOURCE_MAX',
        DEFAULT_RATE_LIMIT_CONFIG.sourceMax,
      ),
      sourceWindowMs: this.number(
        'LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS',
        DEFAULT_RATE_LIMIT_CONFIG.sourceWindowMs,
      ),
    };

    const fallbackMemory =
      memoryStore ?? new MemoryLoginRateLimitStore(this.configService, clock);
    this.memoryStore =
      fallbackMemory instanceof MemoryLoginRateLimitStore
        ? fallbackMemory
        : undefined;
    this.store = this.mode === 'redis-required' ? redisStore! : fallbackMemory;
  }

  async initialize(): Promise<void> {
    if (!this.store) throw new RateLimitUnavailableError();
    await this.store.initialize();
  }

  async onModuleDestroy(): Promise<void> {
    await this.store?.destroy();
  }

  get loginRateLimitMode(): LoginRateLimitMode {
    return this.mode;
  }

  get availability(): 'available' | 'unavailable' {
    return this.store?.availability ?? 'unavailable';
  }

  get acceptsTraffic(): boolean {
    return this.mode === 'memory' || this.availability === 'available';
  }

  async check(
    accountKey: string,
    sourceKey: string,
  ): Promise<RateLimitDecision> {
    return this.run(() => {
      if (!this.store) throw new RateLimitUnavailableError();
      return this.store.check(
        normalizeRateLimitAccountKey(accountKey),
        sourceKey,
        this.config,
      );
    });
  }

  async recordFailure(accountKey: string, sourceKey: string): Promise<void> {
    await this.run(async () => {
      if (!this.store) throw new RateLimitUnavailableError();
      await this.store.recordFailure(
        normalizeRateLimitAccountKey(accountKey),
        sourceKey,
        this.config,
      );
    });
  }

  async clearOnSuccess(accountKey: string): Promise<void> {
    await this.run(async () => {
      if (!this.store) throw new RateLimitUnavailableError();
      await this.store.clearOnSuccess(normalizeRateLimitAccountKey(accountKey));
    }, true);
  }

  getConfig(): RateLimitConfig {
    return this.config;
  }

  reset(): void {
    this.memoryStore?.reset();
  }

  private async run<T>(
    operation: () => Promise<T>,
    postCommit = false,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (this.mode !== 'redis-required' || postCommit) throw error;
      if (error instanceof RateLimitUnavailableError) throw error;
      throw new RateLimitUnavailableError();
    }
  }

  private parseMode(value: string | undefined): LoginRateLimitMode {
    return value === 'redis-required' ? 'redis-required' : 'memory';
  }

  private number(key: string, fallback: number): number {
    const raw = this.configService.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }
}
