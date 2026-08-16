import {
  ArgumentsHost,
  Catch,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type { Request, Response } from 'express';
import { DomainError, ErrorCode } from '../errors';
import {
  createErrorEnvelope,
  type ApiErrorDetail,
  requestIdFrom,
} from './api-envelope';
import {
  compareDeterministically,
  isValidationException,
} from './validation-exception';

/**
 * Maps every thrown error to the stable API envelope.
 * Owns HTTP status mapping so application/domain code stays HTTP-agnostic.
 * Never leaks stack traces or internal messages in production.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const httpAdapter = host.switchToHttp();
    const request = httpAdapter.getRequest<Request>();
    const res = httpAdapter.getResponse<Response>();
    const requestId = requestIdFrom(request);
    const { error, status } = this.map(exception);

    if (status >= 500) {
      const exceptionType =
        exception instanceof Error ? exception.name : typeof exception;
      this.logger.error(
        `Unhandled error code=${error.code} status=${status} requestId=${requestId} type=${exceptionType}`,
      );
    }

    res.status(status).json(createErrorEnvelope(error, requestId));
  }

  private map(exception: unknown): {
    error: ApiErrorDetail;
    status: number;
  } {
    if (exception instanceof DomainError) {
      const domainError = exception.toEnvelope().error;
      return {
        error: {
          ...domainError,
          retryAfterSeconds: domainError.retryAfterSeconds ?? null,
        },
        status: exception.httpStatus,
      };
    }

    // Prisma error mapping — keeps DB constraints out of controllers.
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.mapPrismaKnown(exception);
    }

    // NestJS built-in HttpException — coerce to the stable envelope.
    if (this.isHttpException(exception)) {
      const status = exception.getStatus();
      const normalized = this.normalizeHttpException(
        exception.getResponse(),
        status,
        isValidationException(exception),
      );
      const isServerError = status >= HttpStatus.INTERNAL_SERVER_ERROR;
      return {
        error: this.error(
          this.statusToCode(status),
          isServerError ? 'Internal error' : normalized.message,
          !isServerError,
          isServerError ? undefined : normalized.field,
          isServerError ? 'Retry; contact support if it persists.' : undefined,
        ),
        status,
      };
    }

    // Fallback: never leak internals.
    return {
      error: this.error(
        ErrorCode.INTERNAL_ERROR,
        'Internal error',
        false,
        undefined,
        'Retry; contact support if it persists.',
      ),
      status: HttpStatus.INTERNAL_SERVER_ERROR,
    };
  }

  private mapPrismaKnown(e: Prisma.PrismaClientKnownRequestError): {
    error: ApiErrorDetail;
    status: number;
  } {
    switch (e.code) {
      case 'P2002':
        return {
          error: this.error(
            ErrorCode.CONFLICT,
            'Resource already exists',
            true,
          ),
          status: HttpStatus.CONFLICT,
        };
      case 'P2025':
        return {
          error: this.error(ErrorCode.NOT_FOUND, 'Resource not found', true),
          status: HttpStatus.NOT_FOUND,
        };
      default:
        return {
          error: this.error(ErrorCode.INTERNAL_ERROR, 'Internal error', false),
          status: HttpStatus.INTERNAL_SERVER_ERROR,
        };
    }
  }

  private error(
    code: ErrorCode,
    message: string,
    blocking: boolean,
    field?: string,
    nextStep?: string,
  ): ApiErrorDetail {
    return {
      code,
      message,
      ...(field ? { field } : {}),
      blocking,
      ...(nextStep ? { nextStep } : {}),
      retryAfterSeconds: null,
    };
  }

  private normalizeHttpException(
    response: unknown,
    status: number,
    isValidation: boolean,
  ): {
    message: string;
    field?: string;
  } {
    if (isValidation && isRecord(response)) {
      const issues = validationIssuesOf(response.validationIssues);
      if (issues.length > 0) {
        return {
          message: issues.map((issue) => issue.message).join('; '),
          field: issues[0].field,
        };
      }
    }

    return { message: this.publicMessageForStatus(status) };
  }

  private publicMessageForStatus(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'Request validation failed';
      case HttpStatus.UNAUTHORIZED:
        return 'Authentication required';
      case HttpStatus.FORBIDDEN:
        return 'Forbidden';
      case HttpStatus.NOT_FOUND:
        return 'Resource not found';
      case HttpStatus.CONFLICT:
        return 'Resource conflict';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'Too many requests';
      default:
        return 'Request rejected';
    }
  }

  private statusToCode(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ErrorCode.VALIDATION_FAILED;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      default:
        return status >= HttpStatus.BAD_REQUEST &&
          status < HttpStatus.INTERNAL_SERVER_ERROR
          ? ErrorCode.BAD_REQUEST
          : ErrorCode.INTERNAL_ERROR;
    }
  }

  private isHttpException(
    e: unknown,
  ): e is { getStatus(): number; getResponse(): unknown } {
    return typeof (e as { getStatus?: () => number })?.getStatus === 'function';
  }
}

interface SafeValidationIssue {
  field: string;
  message: string;
}

function validationIssuesOf(value: unknown): SafeValidationIssue[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .filter(
      (issue): issue is Record<string, unknown> =>
        typeof issue.field === 'string' && typeof issue.message === 'string',
    )
    .map((issue) => ({
      field: issue.field as string,
      message: issue.message as string,
    }))
    .sort(
      (left, right) =>
        compareDeterministically(left.field, right.field) ||
        compareDeterministically(left.message, right.message),
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
