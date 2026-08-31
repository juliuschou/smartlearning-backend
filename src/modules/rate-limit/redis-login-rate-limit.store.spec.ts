import { ConfigService } from '@nestjs/config';
import { RateLimitUnavailableError } from '../../common/errors';
import { LoginRateLimitKeyFactory } from './login-rate-limit-key.factory';
import { RedisLoginRateLimitStore } from './redis-login-rate-limit.store';

function makeStore(values: Record<string, string | undefined>) {
  const config = {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
  return new RedisLoginRateLimitStore(
    config,
    new LoginRateLimitKeyFactory('a'.repeat(32)),
  );
}

describe('RedisLoginRateLimitStore', () => {
  it('fails closed when required Redis is unavailable', async () => {
    const store = makeStore({
      LOGIN_RATE_LIMIT_MODE: 'redis-required',
      LOGIN_RATE_LIMIT_CONNECT_TIMEOUT_MS: '10',
      LOGIN_RATE_LIMIT_COMMAND_TIMEOUT_MS: '10',
    });

    await store.initialize();
    expect(store.availability).toBe('unavailable');
    await expect(
      store.check('alice', 'source', {
        accountMax: 2,
        accountWindowMs: 1000,
        sourceMax: 5,
        sourceWindowMs: 1000,
      }),
    ).rejects.toBeInstanceOf(RateLimitUnavailableError);
    await store.destroy();
  });

  it('does not connect when login mode is memory', async () => {
    const store = makeStore({ LOGIN_RATE_LIMIT_MODE: 'memory' });
    await store.initialize();
    expect(store.availability).toBe('unavailable');
    await store.destroy();
  });
});
