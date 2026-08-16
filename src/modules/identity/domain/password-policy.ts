/**
 * Password rules (P0-03 密碼規則與復原). Slice implements only the length
 * invariant: 12–128 Unicode characters, passphrases allowed. No forced
 * composition rules, no periodic rotation.
 *
 * Deferred from this slice: reject platform-known common/breached passwords
 * (source list undecided — M2 red card) and first-login forced change.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

/**
 * Validate a password against the length policy. Throws PasswordPolicyError
 * on violation. Counts Unicode code points (not UTF-16 units) so multibyte
 * passphrases are measured correctly.
 */
export function validatePassword(plaintext: string): void {
  // Array.from splits on Unicode code points; handle surrogate pairs safely.
  const length = Array.from(plaintext).length;
  if (length < PASSWORD_MIN_LENGTH) {
    throw new PasswordPolicyError(
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    );
  }
  if (length > PASSWORD_MAX_LENGTH) {
    throw new PasswordPolicyError(
      `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
    );
  }
}
