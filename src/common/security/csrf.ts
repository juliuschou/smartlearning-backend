import type { Request } from 'express';
import { generateToken, safeEqual } from '../crypto';
import { CSRF_COOKIE_NAME, CSRF_HEADER } from './cookies';

/** Generate the browser-visible half of the double-submit CSRF pair. */
export function generateCsrfToken(): string {
  return generateToken();
}

/**
 * Compare the cookie and header halves without exposing token equality through
 * an ordinary short-circuit string comparison.
 */
export function csrfTokensMatch(
  cookieToken: unknown,
  headerToken: string | undefined,
): boolean {
  if (typeof cookieToken !== 'string' || typeof headerToken !== 'string') {
    return false;
  }
  return safeEqual(cookieToken, headerToken);
}

/** Read the CSRF cookie/header pair from an Express request. */
export function requestCsrfTokens(req: Request): {
  cookieToken: unknown;
  headerToken: string | undefined;
} {
  return {
    cookieToken: req.cookies?.[CSRF_COOKIE_NAME],
    headerToken: req.get(CSRF_HEADER),
  };
}
