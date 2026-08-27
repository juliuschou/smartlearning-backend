/**
 * Password rules (P0-03 密碼規則與復原, US-F7). Enforces:
 *  - length: 12–128 Unicode characters, passphrases allowed (no forced
 *    composition rules, no periodic rotation).
 *  - common/breached rejection (R-F7-3): rejects passwords in the static
 *    common-password blocklist (see `common-passwords.ts`). The real
 *    breached-password source (HIBP / downloaded corpus) is an undecided
 *    M2 red card and is deferred; this static list is the MVP floor.
 *
 * First-login forced change is handled separately via `mustChangePassword`.
 */
import { COMMON_PASSWORDS_SET } from './common-passwords';

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

/**
 * Normalize a password for blocklist comparison: trim leading/trailing
 * whitespace, NFKC compatibility-compose, then lowercase. This collapses
 * trivial evasion (padding, full-width digits, mixed case) so the blocklist
 * matches without enumerating every variant.
 */
export function normalizeForCompare(plaintext: string): string {
  return plaintext.normalize('NFKC').toLowerCase().trim();
}

/**
 * Reject platform-known common/breached passwords (R-F7-3). Throws
 * PasswordPolicyError when the normalized password is in the static
 * common-password blocklist. Call this **after** `validatePassword` so the
 * length floor is enforced first (the blocklist only contains ≥12-char
 * entries; shorter weak passwords are already rejected by length).
 *
 * The check is in-memory and deterministic; it never makes a network call and
 * never logs the raw password. The application caller supplies the field when
 * it wraps this error as a field-scoped `ValidationError`.
 */
export function rejectCommonPassword(plaintext: string): void {
  const normalized = normalizeForCompare(plaintext);
  if (COMMON_PASSWORDS_SET.has(normalized)) {
    throw new PasswordPolicyError('此密碼太常見，請改用其他密碼');
  }
}
