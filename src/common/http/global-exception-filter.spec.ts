import {
  BadRequestException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  DomainError,
  ErrorCode,
  RateLimitedError,
  RateLimitUnavailableError,
  ValidationError,
} from '../errors';
import { GlobalExceptionFilter } from './global-exception-filter';
import { validationExceptionFactory } from './validation-exception';

function hostFor(requestId = 'req-1') {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  const request = {
    requestId,
    get: jest.fn(),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { host, response, request };
}

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  let loggerError: jest.SpyInstance;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerError.mockRestore();
  });

  it('wraps domain errors with data, metadata, and stable error fields', () => {
    const { host, response } = hostFor('req-domain');

    filter.catch(
      new ValidationError('Name is required', 'name', 'Fix it'),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(response.json).toHaveBeenCalledWith({
      data: null,
      meta: { schemaVersion: 1, requestId: 'req-domain' },
      error: {
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Name is required',
        field: 'name',
        blocking: true,
        nextStep: 'Fix it',
        retryAfterSeconds: null,
      },
    });
  });

  it('preserves the rate-limit status and retry hint in the envelope', () => {
    const { host, response } = hostFor('req-rate-limit');

    filter.catch(new RateLimitedError(17), host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
    expect(response.json).toHaveBeenCalledWith({
      data: null,
      meta: { schemaVersion: 1, requestId: 'req-rate-limit' },
      error: {
        code: ErrorCode.RATE_LIMITED,
        message: 'Too many attempts. Please try again later.',
        blocking: true,
        retryAfterSeconds: 17,
      },
    });
  });

  it('maps login rate-limit outage to a stable 503 without retry details', () => {
    const { host, response } = hostFor('req-rate-limit-outage');

    filter.catch(new RateLimitUnavailableError(), host);

    expect(response.status).toHaveBeenCalledWith(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect(response.json).toHaveBeenCalledWith({
      data: null,
      meta: { schemaVersion: 1, requestId: 'req-rate-limit-outage' },
      error: {
        code: ErrorCode.AUTH_RATE_LIMIT_UNAVAILABLE,
        message:
          'Authentication is temporarily unavailable. Please try again later.',
        blocking: true,
        retryAfterSeconds: null,
      },
    });
  });

  it('normalizes validation issues deterministically and keeps the first field', () => {
    const { host, response } = hostFor('req-validation');
    const exception = validationExceptionFactory([
      {
        property: 'z',
        constraints: { isInvalid: 'invalid' },
        children: [],
      },
      {
        property: 'a',
        constraints: { isRequired: 'required' },
        children: [],
      },
    ]);

    filter.catch(exception, host);

    expect(response.json).toHaveBeenCalledWith({
      data: null,
      meta: { schemaVersion: 1, requestId: 'req-validation' },
      error: {
        code: ErrorCode.VALIDATION_FAILED,
        message: 'a: required; z: invalid',
        field: 'a',
        blocking: true,
        retryAfterSeconds: null,
      },
    });
  });

  it('maps built-in HTTP exceptions without leaking response objects', () => {
    const { host, response } = hostFor('req-http');

    filter.catch(new BadRequestException('Bad input'), host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(response.json).toHaveBeenCalledWith({
      data: null,
      meta: { schemaVersion: 1, requestId: 'req-http' },
      error: {
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Request validation failed',
        blocking: true,
        retryAfterSeconds: null,
      },
    });
  });

  it('does not expose arbitrary client exception messages', () => {
    const { host, response } = hostFor('req-safe-message');

    filter.catch(new BadRequestException('password=secret'), host);

    expect(response.json.mock.calls[0][0].error).toEqual({
      code: ErrorCode.VALIDATION_FAILED,
      message: 'Request validation failed',
      blocking: true,
      retryAfterSeconds: null,
    });
    expect(JSON.stringify(response.json.mock.calls[0][0])).not.toContain(
      'password=secret',
    );
  });

  it('keeps unmapped client statuses in the client-error code family', () => {
    const { host, response } = hostFor('req-422');

    filter.catch(
      new (class extends BadRequestException {
        getStatus(): number {
          return HttpStatus.UNPROCESSABLE_ENTITY;
        }
      })('unprocessable details'),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    expect(response.json.mock.calls[0][0].error).toEqual({
      code: ErrorCode.VALIDATION_FAILED,
      message: 'Request validation failed',
      blocking: true,
      retryAfterSeconds: null,
    });
  });

  it('maps Prisma conflicts without exposing constraint targets', () => {
    const { host, response } = hostFor('req-prisma');
    const exception = new Prisma.PrismaClientKnownRequestError(
      'duplicate username',
      {
        code: 'P2002',
        clientVersion: '7.9.1',
        meta: { target: ['username'] },
      },
    );

    filter.catch(exception, host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    const body = response.json.mock.calls[0][0];
    expect(body.error).toEqual({
      code: ErrorCode.CONFLICT,
      message: 'Resource already exists',
      blocking: true,
      retryAfterSeconds: null,
    });
    expect(JSON.stringify(body)).not.toContain('username');
  });

  it('maps P2025 to a generic not-found envelope', () => {
    const { host, response } = hostFor('req-not-found');
    const exception = new Prisma.PrismaClientKnownRequestError(
      'missing row details',
      {
        code: 'P2025',
        clientVersion: '7.9.1',
      },
    );

    filter.catch(exception, host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(response.json.mock.calls[0][0].error).toEqual({
      code: ErrorCode.NOT_FOUND,
      message: 'Resource not found',
      blocking: true,
      retryAfterSeconds: null,
    });
  });

  it('sanitizes unknown errors and preserves request metadata', () => {
    const { host, response } = hostFor('req-internal');

    filter.catch(new Error('database password=secret'), host);

    expect(response.status).toHaveBeenCalledWith(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    const body = response.json.mock.calls[0][0];
    expect(body).toEqual({
      data: null,
      meta: { schemaVersion: 1, requestId: 'req-internal' },
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Internal error',
        blocking: false,
        nextStep: 'Retry; contact support if it persists.',
        retryAfterSeconds: null,
      },
    });
    expect(JSON.stringify(body)).not.toContain('database password');
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('requestId=req-internal'),
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
      'database password=secret',
    );
  });

  it('keeps the narrow DomainError API request-neutral', () => {
    const error = new DomainError(
      ErrorCode.CONFLICT,
      'Conflict',
      HttpStatus.CONFLICT,
    );

    expect(error.toEnvelope().error.code).toBe(ErrorCode.CONFLICT);
    expect(error.toEnvelope().error.retryAfterSeconds).toBeUndefined();
  });
});
