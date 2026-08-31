import type {
  RateLimitConfig,
  RateLimitDecision,
} from './rate-limiter.service';

export type LoginRateLimitAvailability = 'available' | 'unavailable';

export interface LoginRateLimitStore {
  readonly availability: LoginRateLimitAvailability;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  check(
    accountKey: string,
    sourceKey: string,
    config: RateLimitConfig,
  ): Promise<RateLimitDecision>;
  recordFailure(
    accountKey: string,
    sourceKey: string,
    config: RateLimitConfig,
  ): Promise<void>;
  clearOnSuccess(accountKey: string): Promise<void>;
}

export const MEMORY_LOGIN_RATE_LIMIT_STORE = Symbol(
  'MEMORY_LOGIN_RATE_LIMIT_STORE',
);
export const REDIS_LOGIN_RATE_LIMIT_STORE = Symbol(
  'REDIS_LOGIN_RATE_LIMIT_STORE',
);
