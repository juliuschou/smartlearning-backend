import { Logger } from '@nestjs/common';
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

  it('logs fixed outage reasons without identifiers, keys, URLs, or messages', async () => {
    const loggerWarn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const loggerDebug = jest
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);
    const sentinel =
      'redis-secret-username-source-ip-digest-full-key-url-error-message';
    const store = makeStore({
      LOGIN_RATE_LIMIT_MODE: 'redis-required',
    });

    try {
      await store.initialize();
      (store as unknown as { client: unknown }).client = {
        isOpen: true,
        close: jest.fn().mockRejectedValue(new Error(sentinel)),
      };
      await store.destroy();

      const calls = JSON.stringify([
        ...loggerWarn.mock.calls,
        ...loggerDebug.mock.calls,
      ]);
      expect(calls).toContain('missing_url');
      expect(calls).not.toContain(sentinel);
      expect(calls).not.toContain('redis-secret');
      expect(calls).not.toContain('username');
      expect(calls).not.toContain('source-ip');
      expect(calls).not.toContain('full-key');
      expect(calls).not.toContain('redis://');
      expect(loggerDebug).toHaveBeenCalledWith(
        { errorType: 'Error' },
        'Login rate-limit Redis close failed',
      );
    } finally {
      loggerWarn.mockRestore();
      loggerDebug.mockRestore();
    }
  });

  it('does not connect when login mode is memory', async () => {
    const store = makeStore({ LOGIN_RATE_LIMIT_MODE: 'memory' });
    await store.initialize();
    expect(store.availability).toBe('unavailable');
    await store.destroy();
  });
});
