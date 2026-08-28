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
  it('closes the replaced Redis adapter while preserving room membership', () => {
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

    expect(redisAdapters[0].close).toHaveBeenCalledTimes(1);
    expect(namespace.adapter).toBe(localAdapter);
    expect(localAdapter.addAll).toHaveBeenCalledWith(
      'socket-1',
      new Set(['socket-1', 'session:live-session']),
    );

    internals.available = true;
    internals.applyAdapter();

    expect(redisAdapters).toHaveLength(2);
    expect(namespace.adapter).toBe(redisAdapters[1]);
    expect(redisAdapters[0].close).toHaveBeenCalledTimes(1);
  });
});
