import { HttpStatus } from '@nestjs/common';
import { type ErrorCode } from './error-codes';

/**
 * Error envelope shape — the only error shape clients receive over HTTP/Socket.
 * See M2 關鍵技術決策 §10.
 */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    /** Optional field/item path, e.g. "items[2].options[0].text". */
    field?: string;
    /** True when this error blocks the operation. */
    blocking: boolean;
    /** Optional actionable next step for the client. */
    nextStep?: string;
    /** Optional retry hint; transport layers serialize absent hints as null. */
    retryAfterSeconds?: number | null;
  };
}

/**
 * Base class for domain errors that the global exception filter maps to the
 * stable envelope. Application/domain code throws these; the filter owns
 * the HTTP status mapping so controllers/gateways stay free of HTTP concerns.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly httpStatus: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR,
    public readonly field?: string,
    public readonly nextStep?: string,
    public readonly retryAfterSeconds?: number | null,
  ) {
    super(message);
    this.name = this.constructor.name;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        field: this.field,
        blocking: true,
        nextStep: this.nextStep,
        retryAfterSeconds: this.retryAfterSeconds,
      },
    };
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, field?: string, nextStep?: string) {
    super(
      'VALIDATION_FAILED' as ErrorCode,
      message,
      HttpStatus.BAD_REQUEST,
      field,
      nextStep,
    );
  }
}

export class QuestionValidationError extends DomainError {
  constructor(code: ErrorCode, message: string, field?: string) {
    super(
      code,
      message,
      HttpStatus.BAD_REQUEST,
      field,
      'Correct the highlighted field and retry the request.',
    );
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string, field?: string) {
    super('NOT_FOUND' as ErrorCode, message, HttpStatus.NOT_FOUND, field);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, field?: string, nextStep?: string) {
    super(
      'CONFLICT' as ErrorCode,
      message,
      HttpStatus.CONFLICT,
      field,
      nextStep,
    );
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Authentication required') {
    super('UNAUTHORIZED' as ErrorCode, message, HttpStatus.UNAUTHORIZED);
  }
}

/**
 * The session cookie is present but the session has expired (idle or absolute
 * timeout). Distinct from `UnauthorizedError` (missing/malformed/revoked) so
 * clients can prompt a re-login. Both map to HTTP 401; the code is the only
 * differentiator. Message is generic and MUST NOT leak internal details.
 */
export class SessionExpiredError extends DomainError {
  constructor() {
    super(
      'AUTH_SESSION_EXPIRED' as ErrorCode,
      'Session expired',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export class InvalidCredentialsError extends DomainError {
  constructor() {
    super(
      'AUTH_INVALID_CREDENTIALS' as ErrorCode,
      'Invalid credentials',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

/**
 * Login rate limit exceeded (R-F7-7). Stable `RATE_LIMITED` code, HTTP 429.
 * `retryAfterSeconds` is surfaced to the envelope so the client can show a
 * retry hint. The message is generic and MUST NOT reveal account existence.
 */
export class RateLimitUnavailableError extends DomainError {
  constructor() {
    super(
      'AUTH_RATE_LIMIT_UNAVAILABLE' as ErrorCode,
      'Authentication is temporarily unavailable. Please try again later.',
      HttpStatus.SERVICE_UNAVAILABLE,
      undefined,
      undefined,
      null,
    );
  }
}

export class RateLimitedError extends DomainError {
  constructor(retryAfterSeconds: number) {
    super(
      'RATE_LIMITED' as ErrorCode,
      'Too many attempts. Please try again later.',
      HttpStatus.TOO_MANY_REQUESTS,
      undefined,
      undefined,
      retryAfterSeconds,
    );
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Forbidden') {
    super('FORBIDDEN' as ErrorCode, message, HttpStatus.FORBIDDEN);
  }
}

export class CsrfError extends DomainError {
  constructor() {
    super(
      'AUTH_CSRF_INVALID' as ErrorCode,
      'Invalid CSRF token or Origin',
      HttpStatus.FORBIDDEN,
    );
  }
}

export class StepUpRequiredError extends DomainError {
  constructor() {
    super(
      'AUTH_STEP_UP_REQUIRED' as ErrorCode,
      'Recent password verification required',
      HttpStatus.FORBIDDEN,
      undefined,
      'Complete step-up authentication and retry the operation.',
    );
  }
}

export class PasswordChangeRequiredError extends DomainError {
  constructor() {
    super(
      'AUTH_PASSWORD_CHANGE_REQUIRED' as ErrorCode,
      'Password change required',
      HttpStatus.FORBIDDEN,
      undefined,
      'Change the account password before continuing.',
    );
  }
}
