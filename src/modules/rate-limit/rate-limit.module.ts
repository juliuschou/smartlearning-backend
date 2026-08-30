import { Global, Module } from '@nestjs/common';
import { OperationRateLimitGuard } from './operation-rate-limit.guard';
import { OperationRateLimiterService } from './operation-rate-limiter.service';
import { RateLimiterService } from './rate-limiter.service';

/**
 * Rate limit module — US-F7 / R-F7-7 login abuse boundary.
 *
 * Global so `AuthService` can inject `RateLimiterService` without a feature
 * import. In-memory single-instance; multi-instance/Redis is deferred.
 */
@Global()
@Module({
  providers: [
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
