import type { CookieOptions } from 'express';

/**
 * Build cookie options for the opaque web session token.
 * See M2 關鍵技術決策 §4 — __Host- prefix, Secure, HttpOnly, SameSite=Lax.
 *
 * `__Host-` requires: Secure, no Domain, Path=/. Enforced here so callers
 * cannot misconfigure. The `secure` flag defaults to true (production-correct);
 * the test env may pass `secure: false` so supertest over plain HTTP can
 * still receive and resend the cookie. Production must never disable Secure.
 */
export function sessionCookieOptions(
  maxAgeMs: number,
  secure = true,
): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    // No domain → __Host- compliance.
    maxAge: maxAgeMs,
  } as CookieOptions;
}

/** Cookie name with __Host- prefix. */
export const SESSION_COOKIE_NAME = '__Host-session';

/** CSRF token cookie (non-HttpOnly so the client JS can read and echo it). */
export const CSRF_COOKIE_NAME = '__Host-csrf';

export function csrfCookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: false,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  } as CookieOptions;
}

/** Header the client must send for cookie-authenticated mutations. */
export const CSRF_HEADER = 'x-csrf-token';
