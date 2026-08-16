import type { Request } from 'express';

/**
 * Origin/CSRF validation skeleton (full implementation in Phase 2).
 * Cookie-authenticated mutations require both a matching Origin and a CSRF
 * token. See M2 關鍵技術決策 §4.
 */

export function isOriginAllowed(
  origin: string | undefined,
  allowed: string[],
): boolean {
  if (!origin) return false;
  return allowed.includes(origin);
}

/**
 * True when the request is a state-changing method that must be CSRF-guarded.
 */
export function isMutation(req: Request): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
}
