import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import { MetricsMiddleware } from './metrics.middleware';

describe('MetricsMiddleware', () => {
  function setup(request: Partial<Request>, statusCode = 200) {
    const metrics = {
      recordHttpRequest: jest.fn(),
    };
    const middleware = new MetricsMiddleware(metrics as never);
    const response = Object.assign(new EventEmitter(), {
      statusCode,
    }) as Response;
    const next = jest.fn() as NextFunction;
    middleware.use(request as Request, response, next);
    return { metrics, response, next };
  }

  it('records the final status and matched route template once', () => {
    const { metrics, response, next } = setup({
      method: 'GET',
      baseUrl: '/api/v1',
      route: { path: '/courses/:id' } as never,
    });

    expect(next).toHaveBeenCalledTimes(1);
    response.emit('finish');
    response.emit('close');

    expect(metrics.recordHttpRequest).toHaveBeenCalledTimes(1);
    expect(metrics.recordHttpRequest).toHaveBeenCalledWith(
      'GET',
      '/api/v1/courses/:id',
      200,
      expect.any(Number),
    );
  });

  it('uses unknown status for an aborted response and unmatched route for unsafe paths', () => {
    const { metrics, response } = setup({
      method: 'POST',
      baseUrl: '/api/v1',
      route: { path: ['/items/:id', '/unsafe'] } as never,
    });

    response.emit('close');

    expect(metrics.recordHttpRequest).toHaveBeenCalledWith(
      'POST',
      '__unmatched__',
      0,
      expect.any(Number),
    );
  });

  it('contains a recorder failure after response completion', () => {
    const metrics = {
      recordHttpRequest: jest.fn(() => {
        throw new Error('metrics sentinel');
      }),
    };
    const middleware = new MetricsMiddleware(metrics as never);
    const response = Object.assign(new EventEmitter(), {
      statusCode: 500,
    }) as Response;

    expect(() => {
      middleware.use(
        {
          method: 'GET',
          baseUrl: '',
          route: { path: '/failure' },
        } as Request,
        response,
        jest.fn(),
      );
      response.emit('finish');
    }).not.toThrow();
  });
});
