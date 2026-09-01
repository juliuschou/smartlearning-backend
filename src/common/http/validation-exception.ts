import { BadRequestException } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

export interface ValidationIssue {
  field: string;
  message: string;
}

/** Convert class-validator errors into a deterministic, transport-safe shape. */
export function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const error of errors) {
    const field = appendPath(parentPath, error.property);

    for (const [, message] of Object.entries(error.constraints ?? {}).sort(
      ([left], [right]) => compareDeterministically(left, right),
    )) {
      issues.push({
        field,
        message: `${field}: ${safeConstraintMessage(message, error.value)}`,
      });
    }

    issues.push(...flattenValidationErrors(error.children ?? [], field));
  }

  return issues.sort(
    (left, right) =>
      compareDeterministically(left.field, right.field) ||
      compareDeterministically(left.message, right.message),
  );
}

/** Exception factory used by the global ValidationPipe. */
export function validationExceptionFactory(
  errors: ValidationError[],
): BadRequestException {
  const issues = flattenValidationErrors(errors);
  const exception = new BadRequestException({
    message: issues.map((issue) => issue.message),
    validationIssues: issues,
  });

  Object.defineProperty(exception, VALIDATION_EXCEPTION_MARKER, {
    value: true,
    enumerable: false,
  });
  return exception;
}

/** Identify validation exceptions created by the shared ValidationPipe factory. */
export function isValidationException(
  exception: unknown,
): exception is BadRequestException {
  return (
    typeof exception === 'object' &&
    exception !== null &&
    VALIDATION_EXCEPTION_MARKER in exception
  );
}

/**
 * Constraint messages are normally fixed library text. If a custom validator
 * interpolates the rejected value, replace the whole message rather than
 * attempting to redact a guessed secret format.
 */
function safeConstraintMessage(message: string, value: unknown): string {
  const rejectedValue = typeof value === 'string' ? value : undefined;
  if (
    message.includes('$value') ||
    (rejectedValue !== undefined &&
      rejectedValue.length > 0 &&
      message.includes(rejectedValue))
  ) {
    return 'Invalid value.';
  }
  return message;
}

/** Use bracket notation for array indexes and dots for object properties. */
function appendPath(parentPath: string, property: string): string {
  if (/^\d+$/.test(property)) {
    return parentPath ? `${parentPath}[${property}]` : property;
  }
  return parentPath ? `${parentPath}.${property}` : property;
}

/** Compare strings independently of the process locale or ICU data. */
export function compareDeterministically(left: string, right: string): number {
  if (left === right) return 0;

  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);

  for (let index = 0; index < length; index += 1) {
    const leftCodePoint = leftPoints[index].codePointAt(0)!;
    const rightCodePoint = rightPoints[index].codePointAt(0)!;
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint - rightCodePoint;
    }
  }

  return leftPoints.length - rightPoints.length;
}

const VALIDATION_EXCEPTION_MARKER = Symbol('validationException');
