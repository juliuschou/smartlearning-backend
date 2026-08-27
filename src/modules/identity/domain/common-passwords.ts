/**
 * Static blocklist of well-known weak / commonly-breached passwords.
 *
 * This is the **MVP floor** for SPEC R-F7-3 ("不得使用平台列為常見或已知外洩的密碼").
 * The real breached-password source (e.g. HIBP k-anonymity API or a downloaded
 * breach corpus) is an undecided M2 red card and is intentionally deferred — it
 * implies a network dependency and a supply-chain decision not yet made. This
 * static list is deterministic, dependency-free, and never makes a network call.
 *
 * Comparison is normalized (trim + NFKC + casefold) in `password-policy.ts`, so
 * entries here are stored in their simplest lowercase ASCII form. The list is
 * small by design: it catches the most obvious weak choices that meet the
 * 12-character length floor (e.g. padded variants of classic bad passwords).
 * Longer/stronger passphrases are never falsely rejected.
 *
 * Never log raw passwords against this list — the redaction invariant covers
 * answer/password payloads, and the check compares a normalized copy in memory.
 */

/**
 * Lowercase ASCII entries. Each must be ≥ PASSWORD_MIN_LENGTH (12) to be
 * reachable after the length check — shorter classic bad passwords are already
 * rejected by length, so they are omitted here to keep the list focused.
 */
export const COMMON_PASSWORDS: readonly string[] = [
  'password12345',
  'password123456',
  '123456789012',
  '1234567890abc',
  'qwerty123456',
  'qwertyuiop12',
  'asdfghjkl123',
  'zxcvbnm12345',
  'iloveyou12345',
  'letmein123456',
  'admin12345678',
  'welcome123456',
  'monkey1234567',
  'dragon1234567',
  'football12345',
  'baseball12345',
  'passw0rd12345',
  'p@ssw0rd12345',
  'changeme12345',
  'aaaaaaaaaaaa',
  '111111111111',
  '000000000000',
  'abc123456789',
  'foobar123456',
];

/**
 * Normalized set for O(1) lookup. Normalization mirrors `normalizeForCompare`
 * in `password-policy.ts` (trim + NFKC + casefold) so lookup is consistent
 * regardless of how the caller's input is cased or spaced.
 */
export const COMMON_PASSWORDS_SET: ReadonlySet<string> = new Set(
  COMMON_PASSWORDS.map((p) => p.normalize('NFKC').toLowerCase().trim()),
);
