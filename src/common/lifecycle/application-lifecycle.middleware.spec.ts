import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import { ApplicationLifecycleMiddleware } from './application-lifecycle.middleware';
import { ApplicationLifecycleService } from './application-lifecycle.service';

describe('ApplicationLifecycleMiddleware', () => {
  function setup(shuttingDown = false) {
    const lifecycle = {
      isShuttingDown: shuttingDown,
      tryEnterRequest: jest.fn(() => (shuttingDown ? false : jest.fn())),
    } as unknown as ApplicationLifecycleService;
    const middleware = new ApplicationLifecycleMiddleware(lifecycle);
    const response = Object.assign(new EventEmitter(), {}) as Response;
    const next = jest.fn() as NextFunction;
    return { lifecycle, middleware, response, next };
  }

  it('tracks an accepted request until response completion', () => {
    const { middleware, response, next, lifecycle } = setup();
    middleware.use({ path: '/api/v1/courses' } as Request, response, next);

    expect(next).toHaveBeenCalledWith();
    expect(lifecycle.tryEnterRequest).toHaveBeenCalledTimes(1);
    response.emit('finish');
    response.emit('close');
  });

  it('rejects new application work after shutdown', () => {
    const { middleware, response, next } = setup(true);
    middleware.use({ path: '/api/v1/courses' } as Request, response, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'SERVER_SHUTTING_DOWN',
        httpStatus: 503,
      }),
    );
  });

  it.each(['/health/live', '/health/ready', '/metrics'])(
    'allows %s during shutdown for orchestration',
    (path) => {
      const { middleware, response, next } = setup(true);
      middleware.use({ path } as Request, response, next);
      expect(next).toHaveBeenCalledWith();
    },
  );
});
