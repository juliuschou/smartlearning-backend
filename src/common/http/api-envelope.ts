import type { Request } from 'express';
import { ErrorCode, type ErrorCode as ErrorCodeType } from '../errors';
import {
  REQUEST_ID_HEADER,
  REQUEST_ID_PROPERTY,
} from './request-id.middleware';

/** Version of the shared REST/Socket/CLI wire contract. */
export const API_SCHEMA_VERSION = 1 as const;

export interface ApiMeta {
  schemaVersion: typeof API_SCHEMA_VERSION;
  requestId: string;
}

export interface ApiErrorDetail {
  code: ErrorCodeType;
  message: string;
  field?: string;
  blocking: boolean;
  nextStep?: string;
  retryAfterSeconds: number | null;
}

export interface ApiSuccessEnvelope<T> {
  data: T | null;
  meta: ApiMeta;
  error: null;
}

export interface ApiErrorEnvelope {
  data: null;
  meta: ApiMeta;
  error: ApiErrorDetail;
}

export type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope;

/** Read the ID stamped by RequestIdMiddleware without generating a second ID. */
export function requestIdFrom(request: Request): string {
  const stamped = request as Request & Record<string, unknown>;
  const requestId = stamped[REQUEST_ID_PROPERTY] ?? stamped.id;
  if (typeof requestId === 'string' && requestId.length > 0) {
    return requestId;
  }

  const header = request.get?.(REQUEST_ID_HEADER);
  return header && header.length > 0 ? header : 'unknown';
}

export function createApiMeta(requestId: string): ApiMeta {
  return {
    schemaVersion: API_SCHEMA_VERSION,
    requestId,
  };
}

export function createSuccessEnvelope<T>(
  data: T | null | undefined,
  requestId: string,
): ApiSuccessEnvelope<T> {
  return {
    data: data ?? null,
    meta: createApiMeta(requestId),
    error: null,
  };
}

export function createErrorEnvelope(
  error: Omit<ApiErrorDetail, 'retryAfterSeconds'> & {
    retryAfterSeconds?: number | null;
  },
  requestId: string,
): ApiErrorEnvelope {
  const retryAfterSeconds = error.retryAfterSeconds;

  return {
    data: null,
    meta: createApiMeta(requestId),
    error: {
      ...error,
      retryAfterSeconds:
        typeof retryAfterSeconds === 'number' &&
        Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds
          : null,
    },
  };
}

/**
 * Check the complete wire shape rather than only its top-level keys. This
 * prevents malformed controller return values from bypassing normalization.
 */
export function isApiEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  if (!isRecord(value) || !hasApiMeta(value.meta)) return false;
  if (value.error === null) return 'data' in value;
  return value.data === null && isApiErrorDetail(value.error, true);
}

/**
 * Normalize an envelope returned by a handler to the current request context.
 * A handler cannot preserve a stale request ID or omit the retry field by
 * returning an envelope-shaped object.
 */
export function normalizeApiEnvelope(
  value: unknown,
  requestId: string,
): ApiEnvelope<unknown> | undefined {
  if (!isRecord(value) || !hasApiMeta(value.meta)) return undefined;

  if (value.error === null && 'data' in value) {
    return createSuccessEnvelope(value.data, requestId);
  }

  if (value.data === null && isApiErrorDetail(value.error, false)) {
    return createErrorEnvelope(value.error, requestId);
  }

  return undefined;
}

function hasApiMeta(value: unknown): value is ApiMeta {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === API_SCHEMA_VERSION &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0
  );
}

function isApiErrorDetail(
  value: unknown,
  requireRetryAfterSeconds: boolean,
): value is ApiErrorDetail {
  if (!isRecord(value)) return false;
  if (!isErrorCode(value.code) || typeof value.message !== 'string') {
    return false;
  }
  if (typeof value.blocking !== 'boolean') return false;
  if (
    'field' in value &&
    value.field !== undefined &&
    typeof value.field !== 'string'
  ) {
    return false;
  }
  if (
    'nextStep' in value &&
    value.nextStep !== undefined &&
    typeof value.nextStep !== 'string'
  ) {
    return false;
  }
  if (
    requireRetryAfterSeconds &&
    (!('retryAfterSeconds' in value) || value.retryAfterSeconds === undefined)
  ) {
    return false;
  }

  const retryAfterSeconds = value.retryAfterSeconds;
  return (
    retryAfterSeconds === undefined ||
    retryAfterSeconds === null ||
    (typeof retryAfterSeconds === 'number' &&
      Number.isFinite(retryAfterSeconds))
  );
}

function isErrorCode(value: unknown): value is ErrorCodeType {
  return (
    typeof value === 'string' &&
    (Object.values(ErrorCode) as string[]).includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
