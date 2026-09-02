import type { ConfigService } from '@nestjs/config';
import type { Server } from 'socket.io';
import { RealtimeRedisService } from './realtime-redis.service';

type FakeAdapter = {
  addAll: jest.Mock;
  close?: jest.Mock;
};

type FakeSocket = {
  id: string;
  rooms: Set<string>;
};

type RealtimeRedisInternals = {
  available: boolean;
  publisher?: object;
  subscriber?: object;
  getAdapterFactory: () => unknown;
  applyAdapter: () => void;
};

describe('RealtimeRedisService adapter lifecycle', () => {
  it('reuses the Redis adapter across an outage and closes it at shutdown', async () => {
    const config = {
      get: jest.fn((key: string) =>
        key === 'REALTIME_REDIS_MODE' ? 'optional' : undefined,
      ),
    } as unknown as ConfigService;
    const service = new RealtimeRedisService(config);
    const localAdapter: FakeAdapter = { addAll: jest.fn() };
    const redisAdapters: FakeAdapter[] = [];
    const localFactory = function localFactory(): FakeAdapter {
      return localAdapter;
    };
    const redisFactory = function redisFactory(): FakeAdapter {
      const adapter: FakeAdapter = {
        addAll: jest.fn(),
        close: jest.fn(),
      };
      redisAdapters.push(adapter);
      return adapter;
    };
    const namespace = {
      adapter: localAdapter,
      sockets: new Map<string, FakeSocket>([
        [
          'socket-1',
          {
            id: 'socket-1',
            rooms: new Set(['socket-1', 'session:live-session']),
          },
        ],
      ]),
    };
    const server = {
      adapter: jest.fn((factory?: unknown) =>
        factory === undefined ? localFactory : undefined,
      ),
      of: jest.fn(() => namespace),
    } as unknown as Server;
    const internals = service as unknown as RealtimeRedisInternals;
    internals.available = true;
    internals.publisher = {};
    internals.subscriber = {};
    internals.getAdapterFactory = () =>
      internals.available ? redisFactory : undefined;

    service.bindServer(server);
    expect(redisAdapters).toHaveLength(1);
    expect(namespace.adapter).toBe(redisAdapters[0]);

    internals.available = false;
    internals.applyAdapter();

    expect(redisAdapters[0].close).not.toHaveBeenCalled();
    expect(namespace.adapter).toBe(localAdapter);
    expect(localAdapter.addAll).toHaveBeenCalledWith(
      'socket-1',
      new Set(['socket-1', 'session:live-session']),
    );

    internals.available = true;
    internals.applyAdapter();

    expect(redisAdapters).toHaveLength(1);
    expect(namespace.adapter).toBe(redisAdapters[0]);
    expect(redisAdapters[0].close).not.toHaveBeenCalled();

    await service.close();
    expect(redisAdapters[0].close).toHaveBeenCalledTimes(1);
  });

  it('drains a retained async adapter close during shutdown', async () => {
    const config = {
      get: jest.fn((key: string) =>
        key === 'REALTIME_REDIS_MODE' ? 'optional' : undefined,
      ),
    } as unknown as ConfigService;
    const service = new RealtimeRedisService(config);
    const localAdapter: FakeAdapter = { addAll: jest.fn() };
    let resolveClose!: () => void;
    const closePending = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const redisAdapter: FakeAdapter = {
      addAll: jest.fn(),
      close: jest.fn(() => closePending),
    };
    const redisFactory = function redisFactory(): FakeAdapter {
      return redisAdapter;
    };
    const namespace = {
      adapter: localAdapter,
      sockets: new Map<string, FakeSocket>(),
    };
    const server = {
      adapter: jest.fn((factory?: unknown) =>
        factory === undefined ? () => localAdapter : undefined,
      ),
      of: jest.fn(() => namespace),
    } as unknown as Server;
    const internals = service as unknown as RealtimeRedisInternals;
    internals.available = true;
    internals.publisher = {};
    internals.subscriber = {};
    internals.getAdapterFactory = () =>
      internals.available ? redisFactory : undefined;

    service.bindServer(server);
    internals.available = false;
    internals.applyAdapter();

    expect(redisAdapter.close).not.toHaveBeenCalled();

    let shutdownFinished = false;
    const shutdown = service.close().then(() => {
      shutdownFinished = true;
    });
    expect(redisAdapter.close).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);

    resolveClose();
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });

  it('isolates synchronous and asynchronous adapter close failures', async () => {
    const createHarness = (
      close: jest.Mock,
    ): {
      service: RealtimeRedisService;
      localAdapter: FakeAdapter;
      namespace: { adapter: FakeAdapter; sockets: Map<string, FakeSocket> };
      internals: RealtimeRedisInternals;
    } => {
      const config = {
        get: jest.fn((key: string) =>
          key === 'REALTIME_REDIS_MODE' ? 'optional' : undefined,
        ),
      } as unknown as ConfigService;
      const service = new RealtimeRedisService(config);
      const localAdapter: FakeAdapter = { addAll: jest.fn() };
      const redisAdapter: FakeAdapter = { addAll: jest.fn(), close };
      const namespace = {
        adapter: localAdapter,
        sockets: new Map<string, FakeSocket>(),
      };
      const server = {
        adapter: jest.fn((factory?: unknown) =>
          factory === undefined ? () => localAdapter : undefined,
        ),
        of: jest.fn(() => namespace),
      } as unknown as Server;
      const internals = service as unknown as RealtimeRedisInternals;
      internals.available = true;
      internals.publisher = {};
      internals.subscriber = {};
      internals.getAdapterFactory = () =>
        internals.available ? () => redisAdapter : undefined;
      service.bindServer(server);
      return { service, localAdapter, namespace, internals };
    };

    const synchronous = createHarness(
      jest.fn(() => {
        throw new Error('sync close failure');
      }),
    );
    synchronous.internals.available = false;
    expect(() => synchronous.internals.applyAdapter()).not.toThrow();
    expect(synchronous.namespace.adapter).toBe(synchronous.localAdapter);
    await expect(synchronous.service.close()).resolves.toBeUndefined();

    const asynchronous = createHarness(
      jest.fn(() => Promise.reject(new Error('async close failure'))),
    );
    asynchronous.internals.available = false;
    expect(() => asynchronous.internals.applyAdapter()).not.toThrow();
    await expect(asynchronous.service.close()).resolves.toBeUndefined();
  });
});
