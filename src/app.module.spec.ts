import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { RateLimiterService } from './modules/rate-limit/rate-limiter.service';

describe('AppModule', () => {
  it('should compile and provide the application module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef).toBeDefined();
    expect(moduleRef.get(AppModule)).toBeInstanceOf(AppModule);
    expect(moduleRef.get(RateLimiterService)).toBeInstanceOf(
      RateLimiterService,
    );

    await moduleRef.close();
  });
});
