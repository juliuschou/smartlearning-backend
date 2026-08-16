import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { ApiResponseInterceptor } from './api-response.interceptor';

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function handlerFor(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

describe('ApiResponseInterceptor', () => {
  const interceptor = new ApiResponseInterceptor();

  it('wraps versioned REST values and adds request metadata', async () => {
    const result = await firstValueFrom(
      interceptor.intercept(
        contextFor({ originalUrl: '/api/v1/courses', requestId: 'req-1' }),
        handlerFor({ id: 'course-1' }),
      ),
    );

    expect(result).toEqual({
      data: { id: 'course-1' },
      meta: { schemaVersion: 1, requestId: 'req-1' },
      error: null,
    });
  });

  it('keeps page data nested under the response data field', async () => {
    const page = {
      data: [{ id: 'course-1' }],
      meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    };

    const result = await firstValueFrom(
      interceptor.intercept(
        contextFor({ originalUrl: '/api/v1/courses', requestId: 'req-2' }),
        handlerFor(page),
      ),
    );

    expect(result).toEqual({
      data: page,
      meta: { schemaVersion: 1, requestId: 'req-2' },
      error: null,
    });
  });

  it('normalizes undefined success values to null', async () => {
    const result = await firstValueFrom(
      interceptor.intercept(
        contextFor({ originalUrl: '/api/v1/auth/session', requestId: 'req-3' }),
        handlerFor(undefined),
      ),
    );

    expect(result).toEqual({
      data: null,
      meta: { schemaVersion: 1, requestId: 'req-3' },
      error: null,
    });
  });

  it('does not double-wrap an existing canonical envelope', async () => {
    const envelope = {
      data: { ok: true },
      meta: { schemaVersion: 1, requestId: 'req-4' },
      error: null,
    };

    const result = await firstValueFrom(
      interceptor.intercept(
        contextFor({ originalUrl: '/api/v1/courses', requestId: 'req-4' }),
        handlerFor(envelope),
      ),
    );

    expect(result).toEqual(envelope);
  });

  it('normalizes stale metadata and fills missing retry hints', async () => {
    const staleSuccess = {
      data: { ok: true },
      meta: { schemaVersion: 1, requestId: 'stale-request' },
      error: null,
    };
    const staleError = {
      data: null,
      meta: { schemaVersion: 1, requestId: 'stale-request' },
      error: {
        code: 'CONFLICT',
        message: 'Conflict',
        blocking: true,
      },
    };

    const success = await firstValueFrom(
      interceptor.intercept(
        contextFor({ originalUrl: '/api/v1/courses', requestId: 'req-5' }),
        handlerFor(staleSuccess),
      ),
    );
    const error = await firstValueFrom(
      interceptor.intercept(
        contextFor({ originalUrl: '/api/v1/courses', requestId: 'req-6' }),
        handlerFor(staleError),
      ),
    );

    expect(success).toEqual({
      data: { ok: true },
      meta: { schemaVersion: 1, requestId: 'req-5' },
      error: null,
    });
    expect(error).toEqual({
      data: null,
      meta: { schemaVersion: 1, requestId: 'req-6' },
      error: {
        code: 'CONFLICT',
        message: 'Conflict',
        blocking: true,
        retryAfterSeconds: null,
      },
    });
  });

  it('wraps malformed envelope-shaped values instead of trusting them', async () => {
    const malformed = {
      data: null,
      meta: { schemaVersion: 1, requestId: 'stale-request' },
      error: { code: 'NOT_A_STABLE_CODE', message: 'internal', blocking: true },
    };

    const result = await firstValueFrom(
      interceptor.intercept(
        contextFor({ originalUrl: '/api/v1/courses', requestId: 'req-7' }),
        handlerFor(malformed),
      ),
    );

    expect(result).toEqual({
      data: malformed,
      meta: { schemaVersion: 1, requestId: 'req-7' },
      error: null,
    });
  });

  it('leaves health and non-versioned responses unchanged', async () => {
    const health = { status: 'ok' };
    const nonVersioned = { status: 'ok' };

    const healthResult = await firstValueFrom(
      interceptor.intercept(
        contextFor({ originalUrl: '/health/live', requestId: 'req-5' }),
        handlerFor(health),
      ),
    );
    const nonVersionedResult = await firstValueFrom(
      interceptor.intercept(
        contextFor({ originalUrl: '/api/courses', requestId: 'req-6' }),
        handlerFor(nonVersioned),
      ),
    );

    expect(healthResult).toBe(health);
    expect(nonVersionedResult).toBe(nonVersioned);
  });
});
