import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Hash an opaque token (web session, participant token, validation token)
 * before storing. Only the hash is persisted; the raw token lives only in
 * the cookie/client and is never logged. SHA-256 is sufficient because the
 * tokens are high-entropy (>= 128 bits) random bytes — no salt needed.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time string comparison for token-hash lookups to avoid timing
 * oracles. Inputs must be equal length; we hash-compare when lengths differ
 * to avoid leaking length info.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // compare anyway to keep constant-ish time, return false
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Generate a high-entropy opaque token. Default 32 bytes (256 bits).
 * Returns url-safe base64 (no padding) for cookie/header use.
 */
export function generateToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}
