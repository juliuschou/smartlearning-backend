import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OperationRateLimitGuard } from './operation-rate-limit.guard';
import { OperationRateLimiterService } from './operation-rate-limiter.service';
import {
  MEMORY_LOGIN_RATE_LIMIT_STORE,
  REDIS_LOGIN_RATE_LIMIT_STORE,
} from './login-rate-limit-store';
import { LoginRateLimitKeyFactory } from './login-rate-limit-key.factory';
import { MemoryLoginRateLimitStore } from './memory-login-rate-limit.store';
import { RedisLoginRateLimitStore } from './redis-login-rate-limit.store';
import { RateLimiterService } from './rate-limiter.service';

@Global()
@Module({
  providers: [
    {
      provide: LoginRateLimitKeyFactory,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new LoginRateLimitKeyFactory(
          config.get<string>('LOGIN_RATE_LIMIT_KEY_SECRET') ??
            'development-only-login-rate-limit-secret',
        ),
    },
    {
      provide: MEMORY_LOGIN_RATE_LIMIT_STORE,
      useClass: MemoryLoginRateLimitStore,
    },
    {
      provide: REDIS_LOGIN_RATE_LIMIT_STORE,
      useClass: RedisLoginRateLimitStore,
    },
    RateLimiterService,
    OperationRateLimiterService,
    OperationRateLimitGuard,
  ],
  exports: [
    RateLimiterService,
    OperationRateLimiterService,
    OperationRateLimitGuard,
  ],
})
export class RateLimitModule {}
