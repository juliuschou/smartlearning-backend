import { ErrorCode } from './error-codes';
import {
  AccountDisabledError,
  EnrollmentRemovedError,
  EnrollmentRequiredError,
} from './domain-error';

describe('published error codes', () => {
  it('keeps codes unique and uppercase snake case', () => {
    const values = Object.values(ErrorCode);

    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual(
      expect.arrayContaining([
        'AUTH_ACCOUNT_DISABLED',
        'ENROLLMENT_REQUIRED',
        'ENROLLMENT_REMOVED',
      ]),
    );
    expect(values.every((value) => /^[A-Z][A-Z0-9_]*$/.test(value))).toBe(true);
  });

  it.each([
    [new AccountDisabledError(), 'AUTH_ACCOUNT_DISABLED', 401],
    [new EnrollmentRequiredError(), 'ENROLLMENT_REQUIRED', 403],
    [new EnrollmentRemovedError(), 'ENROLLMENT_REMOVED', 403],
  ])(
    '%s preserves its published code and HTTP status',
    (error, code, status) => {
      expect(error.code).toBe(code);
      expect(error.httpStatus).toBe(status);
      expect(error.toEnvelope().error.code).toBe(code);
    },
  );
});
