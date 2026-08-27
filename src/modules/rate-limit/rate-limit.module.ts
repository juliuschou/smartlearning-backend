import { Global, Module } from '@nestjs/common';
import { RateLimiterService } from './rate-limiter.service';

/**
 * Rate limit module — US-F7 / R-F7-7 login abuse boundary.
 *
 * Global so `AuthService` can inject `RateLimiterService` without a feature
 * import. In-memory single-instance; multi-instance/Redis is deferred.
 */
@Global()
@Module({
  providers: [RateLimiterService],
  exports: [RateLimiterService],
})
export class RateLimitModule {}
