import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { Response } from 'express';
import { DomainError, ErrorCode, ErrorEnvelope } from '../errors';

/**
 * Maps every thrown error to the stable {@link ErrorEnvelope}.
 * Owns HTTP status mapping so application/domain code stays HTTP-agnostic.
 * Never leaks stack traces or internal messages in production.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const httpAdapter = host.switchToHttp();
    const res = httpAdapter.getResponse<Response>();

    const { envelope, status } = this.map(exception);

    if (status >= 500) {
      this.logger.error(
        `Unhandled error: ${this.describe(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    res.status(status).json(envelope);
  }

  private map(exception: unknown): { envelope: ErrorEnvelope; status: number } {
    if (exception instanceof DomainError) {
      return { envelope: exception.toEnvelope(), status: exception.httpStatus };
    }

    // Prisma error mapping — keeps DB constraints out of controllers.
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.mapPrismaKnown(exception);
    }

    // NestJS built-in HttpException — coerce to envelope.
    if (this.isHttpException(exception)) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : (response as { message?: string[] | string }).message instanceof
              Array
            ? (response as { message: string[] }).message.join('; ')
            : ((response as { message?: string }).message ?? 'Request error');
      const code = this.statusToCode(status);
      return { envelope: this.envelope(code, message), status };
    }

    // Fallback: never leak internals.
    return {
      envelope: this.envelope(
        ErrorCode.INTERNAL_ERROR,
        'Internal error',
        false,
        'Retry; contact support if it persists.',
      ),
      status: HttpStatus.INTERNAL_SERVER_ERROR,
    };
  }

  private mapPrismaKnown(e: Prisma.PrismaClientKnownRequestError): {
    envelope: ErrorEnvelope;
    status: number;
  } {
    switch (e.code) {
      case 'P2002': {
        // unique constraint violation
        const target = e.meta?.target;
        const field = Array.isArray(target) ? target.join(', ') : undefined;
        return {
          envelope: this.envelope(
            ErrorCode.CONFLICT,
            'Resource already exists',
            true,
            field,
          ),
          status: HttpStatus.CONFLICT,
        };
      }
      case 'P2025': // record not found
        return {
          envelope: this.envelope(ErrorCode.NOT_FOUND, 'Resource not found'),
          status: HttpStatus.NOT_FOUND,
        };
      default:
        return {
          envelope: this.envelope(
            ErrorCode.INTERNAL_ERROR,
            'Internal error',
            false,
          ),
          status: HttpStatus.INTERNAL_SERVER_ERROR,
        };
    }
  }

  // --- helpers ---

  private envelope(
    code: ErrorCode,
    message: string,
    blocking = true,
    field?: string,
    nextStep?: string,
  ): ErrorEnvelope {
    return { error: { code, message, field, blocking, nextStep } };
  }

  private statusToCode(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
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
        return ErrorCode.INTERNAL_ERROR;
    }
  }

  private isHttpException(
    e: unknown,
  ): e is { getStatus(): number; getResponse(): unknown } {
    return typeof (e as { getStatus?: () => number })?.getStatus === 'function';
  }

  private describe(e: unknown): string {
    if (e instanceof Error) return `${e.name}: ${e.message}`;
    return String(e);
  }
}
