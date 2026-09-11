import { Prisma } from '../../../../generated/prisma/client';

/**
 * Stable, low-cardinality failure classification for the durable retention purge.
 *
 * Only stable codes are persisted to `ArchivedResult.lastPurgeFailureCode` — never
 * raw exception messages, which could contain governed data (BE-5.2 invariant).
 * The code set mirrors the migration CHECK (`ck_archived_result_purge_failure_code`).
 */
export const PURGE_FAILURE_CODES = [
  'invariant_conflict',
  'fk_blocker',
  'lease_lost',
  'transient_db',
  'unavailable_db',
  'unknown',
] as const;
export type PurgeFailureCode = (typeof PURGE_FAILURE_CODES)[number];

/**
 * Codes treated as permanent: retrying them cannot succeed, so the row quarantines
 * immediately rather than consuming backoff attempts.
 */
const PERMANENT_CODES: ReadonlySet<PurgeFailureCode> = new Set([
  'invariant_conflict',
  'fk_blocker',
  'lease_lost',
]);

export type Quarantine = {
  quarantined: true;
  reason: 'permanent' | 'exhausted';
};
export type RetryDecision = { quarantined: false; delayMs: number };
export type FailureDecision = Quarantine | RetryDecision;

/**
 * Thrown by the lease-verified purge executor when the current process no longer
 * owns the archive's lease (another worker reclaimed it after a crash/expiry).
 * Carries an ErrorCode so the failure transition can persist `lease_lost`.
 */
export class LeaseLostError extends Error {
  constructor() {
    super('Purge lease was lost before execution');
    this.name = 'LeaseLostError';
  }
}

function isPrismaKnownError(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError;
}

const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'P1001', // cannot reach the database server
  'P1002', // server timed out
  'P1009', // database already exists (connect-time error family)
  'P1012', // validation / connection-level failure
]);

/**
 * Map an execution error to a stable failure class.
 *
 * `isDbUnavailable` lets the caller assert a transport-level outage (e.g. a timed-out
 * claim) that Prisma surfaces as a generic error, so we do not mislabel an
 * unavailable database as `unknown`/transient and spin.
 */
export function classifyPurgeFailure(
  error: unknown,
  isDbUnavailable = false,
): PurgeFailureCode {
  if (isDbUnavailable) return 'unavailable_db';
  if (error instanceof LeaseLostError) return 'lease_lost';
  if (isPrismaKnownError(error)) {
    const code = error.code;
    if (UNREACHABLE_CODES.has(code)) return 'unavailable_db';
    // P2xxx are database engine errors. Foreign-key violations are P2003;
    // constraint/check violations are P2002/P2011/P2004/P2005 and are permanent
    // for the governed deletion because they indicate an un-skipped referential
    // blocker (a permanent invariant problem), not a transient hiccup.
    if (code === 'P2003') return 'fk_blocker';
    if (typeof code === 'string' && code.startsWith('P2'))
      return 'transient_db';
  }
  return 'unknown';
}

/** Bounded exponential backoff. Deterministic, monotonic within an attempt count, capped. */
export function retryDelayMs(
  code: PurgeFailureCode,
  attempts: number,
  baseMs = 250,
  capMs = 30_000,
): number {
  const delay = baseMs * 2 ** Math.max(0, attempts - 1);
  return Math.min(capMs, Math.max(0, Math.floor(delay)));
}

/**
 * Decide the post-failure transition for one archive row.
 *
 * Permanent codes and exhausted attempt budgets quarantine. Everything else retries
 * with bounded exponential backoff. Never alters `purgeAt` — the caller owns that.
 */
export function decidePurgeFailure(
  code: PurgeFailureCode,
  attempts: number,
  maxAttempts = 5,
): FailureDecision {
  if (PERMANENT_CODES.has(code) || attempts >= maxAttempts) {
    return {
      quarantined: true,
      reason: PERMANENT_CODES.has(code) ? 'permanent' : 'exhausted',
    };
  }
  return {
    quarantined: false,
    delayMs: retryDelayMs(code, attempts),
  };
}
