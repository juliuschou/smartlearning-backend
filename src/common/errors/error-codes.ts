/**
 * Stable, language-neutral error codes used across HTTP, Socket.IO, and CLI/Agent.
 * Codes are uppercase snake_case and never renamed once published (wire contract).
 * Add new codes append-only; do not reuse retired numbers.
 */
export const ErrorCode = {
  // Generic
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',

  // Auth (Phase 2)
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_SESSION_EXPIRED: 'AUTH_SESSION_EXPIRED',
  AUTH_STEP_UP_REQUIRED: 'AUTH_STEP_UP_REQUIRED',
  AUTH_PASSWORD_CHANGE_REQUIRED: 'AUTH_PASSWORD_CHANGE_REQUIRED',
  AUTH_CSRF_INVALID: 'AUTH_CSRF_INVALID',

  // Domain (placeholders; finalized per feature phase)
  COURSE_ARCHIVED: 'COURSE_ARCHIVED',
  SESSION_NOT_JOINABLE: 'SESSION_NOT_JOINABLE',
  SUBMISSION_CONFLICT: 'SUBMISSION_CONFLICT',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
