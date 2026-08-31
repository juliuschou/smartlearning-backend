import { createClient, type RedisClientType } from 'redis';
import { LoginRateLimitKeyFactory } from '../src/modules/rate-limit/login-rate-limit-key.factory';
import { RedisLoginRateLimitStore } from '../src/modules/rate-limit/redis-login-rate-limit.store';
import type { RateLimitConfig } from '../src/modules/rate-limit/rate-limiter.service';
import { RateLimitUnavailableError } from '../src/common/errors';

const PREFIX = 'smartlearning:test:login-rate-limit:v1:{login}';
const config: RateLimitConfig = {
  accountMax: 2,
  accountWindowMs: 1_000,
  sourceMax: 100,
  sourceWindowMs: 1_000,
};

type TestRedisClient = RedisClientType;

describe('Redis login rate-limit store (integration)', () => {
  let redis: TestRedisClient | undefined;
  let first: RedisLoginRateLimitStore | undefined;
  let second: RedisLoginRateLimitStore | undefined;
  const url = process.env.LOGIN_RATE_LIMIT_TEST_REDIS_URL;

  beforeAll(async () => {
    if (process.env.RUN_LOGIN_RATE_LIMIT_REDIS_TESTS !== '1') {
      throw new Error(
        'Redis login-rate-limit tests require RUN_LOGIN_RATE_LIMIT_REDIS_TESTS=1',
      );
    }
    if (!url) {
      throw new Error(
        'Redis login-rate-limit tests require LOGIN_RATE_LIMIT_TEST_REDIS_URL',
      );
    }
    if (!url.startsWith('redis://') && !url.startsWith('rediss://')) {
      throw new Error(
        'Redis login-rate-limit test URL must use redis:// or rediss://',
      );
    }

    redis = createClient({ url });
    try {
      await redis.connect();
      const keys = new LoginRateLimitKeyFactory('a'.repeat(32), PREFIX);
      const serviceConfig = {
        get: (key: string) => {
          const values: Record<string, string> = {
            LOGIN_RATE_LIMIT_MODE: 'redis-required',
            LOGIN_RATE_LIMIT_REDIS_URL: url,
            LOGIN_RATE_LIMIT_CONNECT_TIMEOUT_MS: '2000',
            LOGIN_RATE_LIMIT_COMMAND_TIMEOUT_MS: '1000',
          };
          return values[key];
        },
      } as never;
      first = new RedisLoginRateLimitStore(serviceConfig, keys);
      second = new RedisLoginRateLimitStore(serviceConfig, keys);
      await Promise.all([first.initialize(), second.initialize()]);
      if (
        first.availability !== 'available' ||
        second.availability !== 'available'
      ) {
        throw new Error('Redis login-rate-limit test Redis is unavailable');
      }
      await cleanup(redis);
    } catch (error) {
      await first?.destroy();
      await second?.destroy();
      if (redis.isOpen) await redis.close();
      throw error;
    }
  });

  afterEach(async () => {
    if (redis) await cleanup(redis);
  });

  afterAll(async () => {
    await first?.destroy();
    await second?.destroy();
    if (redis?.isOpen) await redis.close();
  });

  it('atomically creates buckets with positive TTL and shares them across stores', async () => {
    await first!.recordFailure('alice', 'source-a', config);
    const accountKey = new LoginRateLimitKeyFactory(
      'a'.repeat(32),
      PREFIX,
    ).account('alice');
    expect(await redis!.pTTL(accountKey)).toBeGreaterThan(0);
    await second!.recordFailure('alice', 'source-a', config);
    await expect(
      second!.check('alice', 'source-a', config),
    ).resolves.toMatchObject({
      limited: true,
    });
  });

  it('does not extend the original fixed-window TTL on increment', async () => {
    await first!.recordFailure('alice', 'source-a', config);
    const keyFactory = new LoginRateLimitKeyFactory('a'.repeat(32), PREFIX);
    const before = await redis!.pTTL(keyFactory.account('alice'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    await second!.recordFailure('alice', 'source-a', config);
    const after = await redis!.pTTL(keyFactory.account('alice'));
    expect(after).toBeLessThan(before);
  });

  it('keeps concurrent increments and clears only the account bucket', async () => {
    await Promise.all(
      Array.from({ length: 20 }, () =>
        first!.recordFailure('concurrent', 'source-c', config),
      ),
    );
    const keyFactory = new LoginRateLimitKeyFactory('a'.repeat(32), PREFIX);
    expect(await redis!.get(keyFactory.account('concurrent'))).toBe('20');
    expect(await redis!.get(keyFactory.source('source-c'))).toBe('20');

    await first!.clearOnSuccess('concurrent');
    expect(await redis!.get(keyFactory.account('concurrent'))).toBeNull();
    expect(await redis!.get(keyFactory.source('source-c'))).toBe('20');
  });

  it('repairs a numeric no-TTL bucket during failure recording', async () => {
    const keyFactory = new LoginRateLimitKeyFactory('a'.repeat(32), PREFIX);
    await redis!.set(keyFactory.account('repair'), '9');
    await first!.recordFailure('repair', 'repair-source', config);
    expect(await redis!.get(keyFactory.account('repair'))).toBe('1');
    expect(await redis!.pTTL(keyFactory.account('repair'))).toBeGreaterThan(0);
  });

  it('fails closed on a corrupt no-TTL pre-check', async () => {
    const keyFactory = new LoginRateLimitKeyFactory('a'.repeat(32), PREFIX);
    await redis!.set(keyFactory.account('corrupt'), '9');
    await expect(
      first!.check('corrupt', 'corrupt-source', config),
    ).rejects.toBeInstanceOf(RateLimitUnavailableError);
  });

  it('recovers after real TTL expiry', async () => {
    const shortConfig = { ...config, accountMax: 1, accountWindowMs: 100 };
    await first!.recordFailure('expiring', 'expiring-source', shortConfig);
    await expect(
      first!.check('expiring', 'expiring-source', shortConfig),
    ).resolves.toMatchObject({
      limited: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(
      first!.check('expiring', 'expiring-source', shortConfig),
    ).resolves.toEqual({
      limited: false,
      retryAfterSeconds: 0,
    });
  });
});

async function cleanup(client: TestRedisClient): Promise<void> {
  let cursor = '0';
  do {
    const result = await client.scan(cursor, {
      MATCH: `${PREFIX}*`,
      COUNT: 100,
    });
    cursor = result.cursor;
    if (result.keys.length > 0) await client.unlink(result.keys);
  } while (cursor !== '0');
}
