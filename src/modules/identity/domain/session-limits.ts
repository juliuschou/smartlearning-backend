/**
 * Web Session lifetime limits (M2 關鍵技術決策 §4).
 * Idle timeout and absolute lifetime are read from config; this module holds
 * the pure helpers that compute validity so tests can fake the clock.
 */
import type { Clock } from '../../../common/clock';

export interface SessionValidity {
  /** True when the session is still within both idle and absolute windows. */
  valid: boolean;
  /** 'expired' if absolute window passed, 'idle' if idle window passed, null if valid. */
  reason: 'expired' | 'idle' | null;
}

/**
 * Decide whether a session is still valid given its lastSeenAt (idle) and
 * expiresAt (absolute), against the current time.
 */
export function sessionValidity(
  lastSeenAt: Date,
  expiresAt: Date,
  clock: Clock,
  idleMs: number,
): SessionValidity {
  const now = clock.nowMs();
  if (expiresAt.getTime() <= now) {
    return { valid: false, reason: 'expired' };
  }
  if (lastSeenAt.getTime() + idleMs <= now) {
    return { valid: false, reason: 'idle' };
  }
  return { valid: true, reason: null };
}

/** Absolute expiry timestamp for a session created now. */
export function absoluteExpiry(clock: Clock, absoluteMs: number): Date {
  return new Date(clock.nowMs() + absoluteMs);
}
