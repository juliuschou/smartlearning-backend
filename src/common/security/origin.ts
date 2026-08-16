import type { Request } from 'express';

/**
 * Exact Origin validation for cookie-authenticated mutations.
 * These requests also require a matching CSRF token/header pair. See M2
 * 關鍵技術決策 §4.
 */

export function isOriginAllowed(
  origin: string | undefined,
  allowed: string[],
): boolean {
  if (!origin || allowed.includes('*')) return false;
  return allowed.includes(origin);
}

/**
 * True when the request is a state-changing method that must be CSRF-guarded.
 */
export function isMutation(req: Request): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
}
