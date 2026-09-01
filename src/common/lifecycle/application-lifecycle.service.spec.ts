import { EventEmitter } from 'node:events';
import type { ConfigService } from '@nestjs/config';
import type { Server } from 'socket.io';
import { ApplicationLifecycleService } from './application-lifecycle.service';

describe('ApplicationLifecycleService', () => {
  function makeService(timeout = 1000): ApplicationLifecycleService {
    const config = {
      get: jest.fn().mockReturnValue(timeout),
    } as unknown as ConfigService;
    return new ApplicationLifecycleService(config);
  }

  it('fences new requests and releases an in-flight request once', async () => {
    const service = makeService();
    const release = service.tryEnterRequest();
    expect(release).toEqual(expect.any(Function));
    expect(service.inFlightRequests).toBe(1);

    const shutdown = service.beforeApplicationShutdown();
    expect(service.isShuttingDown).toBe(true);
    expect(service.tryEnterRequest()).toBe(false);

    if (typeof release !== 'function') throw new Error('request was rejected');
    release();
    release();
    await shutdown;
    expect(service.inFlightRequests).toBe(0);
  });

  it('signals retryable shutdown and disconnects live sockets', async () => {
    const service = makeService();
    const socket = Object.assign(new EventEmitter(), {
      id: 'socket-1',
      emit: jest.fn(),
      disconnect: jest.fn(),
    });
    const namespace = { sockets: new Map([['socket-1', socket]]) };
    const server = {
      of: jest.fn().mockReturnValue(namespace),
    } as unknown as Server;
    service.registerSocketServer(server);

    await service.beforeApplicationShutdown();

    expect(socket.emit).toHaveBeenCalledWith('server.shutdown', {
      code: 'SERVER_SHUTTING_DOWN',
      retryable: true,
    });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('does not keep a shutdown timer after in-flight work drains', async () => {
    jest.useFakeTimers();
    try {
      const service = makeService(60_000);
      const release = service.tryEnterRequest();
      const shutdown = service.beforeApplicationShutdown();
      if (typeof release !== 'function')
        throw new Error('request was rejected');
      release();
      await shutdown;
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
