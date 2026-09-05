import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import {
  installTestResponseLossFailpoint,
  TEST_RESPONSE_LOSS_HEADER,
} from './test-response-loss-failpoint';

describe('test response-loss failpoint', () => {
  function setup(enabled = true) {
    const middlewares: Array<
      (request: Request, response: Response, next: NextFunction) => void
    > = [];
    const app = {
      use: (
        middleware: (
          request: Request,
          response: Response,
          next: NextFunction,
        ) => void,
      ) => middlewares.push(middleware),
    };
    installTestResponseLossFailpoint(app, { enabled, token: 'secret' });
    const socket = { destroy: jest.fn() };
    const response = Object.assign(new EventEmitter(), {
      socket,
      end: jest.fn(function end(this: Response) {
        return this;
      }),
    }) as unknown as Response;
    return { middleware: middlewares[0], response, socket };
  }

  it('aborts one matching submission response and leaves later responses alone', () => {
    const { middleware, response, socket } = setup();
    const next = jest.fn();
    const request = {
      method: 'POST',
      path: '/api/v1/live-sessions/123e4567-e89b-12d3-a456-426614174000/submissions',
      header: (name: string) => {
        if (name === TEST_RESPONSE_LOSS_HEADER) return 'secret';
        if (name === 'idempotency-key') return 'first-key';
        return undefined;
      },
    } as unknown as Request;

    middleware(request, response, next);
    expect(next).toHaveBeenCalledTimes(1);
    response.end('body' as never);
    expect(socket.destroy).toHaveBeenCalledTimes(1);

    const laterSocket = { destroy: jest.fn() };
    const laterResponse = Object.assign(new EventEmitter(), {
      socket: laterSocket,
      end: jest.fn(function end(this: Response) {
        return this;
      }),
    }) as unknown as Response;
    middleware(request, laterResponse, next);
    laterResponse.end('later body' as never);
    expect(laterSocket.destroy).not.toHaveBeenCalled();
    expect(laterResponse.end).toHaveBeenCalledTimes(1);
  });

  it('does not install when disabled or for non-target requests', () => {
    const disabled = setup(false);
    expect(disabled.middleware).toBeUndefined();

    const { middleware, response, socket } = setup();
    const next = jest.fn();
    middleware(
      {
        method: 'GET',
        path: '/api/v1/live-sessions/123e4567-e89b-12d3-a456-426614174000/submissions',
        header: () => 'secret',
      } as unknown as Request,
      response,
      next,
    );
    response.end('body' as never);
    expect(next).toHaveBeenCalledTimes(1);
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(response.end).toHaveBeenCalledTimes(1);
  });
});
