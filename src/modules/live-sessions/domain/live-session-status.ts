export const LiveSessionStatus = {
  WAITING: 'waiting',
  ACTIVE: 'active',
  CLOSED: 'closed',
  CANCELLED: 'cancelled',
} as const;

export type LiveSessionStatus =
  (typeof LiveSessionStatus)[keyof typeof LiveSessionStatus];

export const LIVE_SESSION_STATUSES: readonly LiveSessionStatus[] = [
  LiveSessionStatus.WAITING,
  LiveSessionStatus.ACTIVE,
  LiveSessionStatus.CLOSED,
  LiveSessionStatus.CANCELLED,
];

export function isLiveSessionStatus(value: string): value is LiveSessionStatus {
  return (LIVE_SESSION_STATUSES as readonly string[]).includes(value);
}

export function isJoinableLiveSessionStatus(
  value: string,
): value is typeof LiveSessionStatus.WAITING | typeof LiveSessionStatus.ACTIVE {
  return (
    value === LiveSessionStatus.WAITING || value === LiveSessionStatus.ACTIVE
  );
}

export function canStartLiveSession(status: LiveSessionStatus): boolean {
  return status === LiveSessionStatus.WAITING;
}

export function canCloseLiveSession(status: LiveSessionStatus): boolean {
  return status === LiveSessionStatus.ACTIVE;
}

/** Cancel is the discard path for sessions not yet (or no longer) worth keeping.
 * Allowed from waiting (never started) or active (in progress); closed/cancelled
 * are terminal and cannot be cancelled. Per design §6.1, cancelled does not
 * create an ArchivedResult and does not record closedAt. */
export function canCancelLiveSession(status: LiveSessionStatus): boolean {
  return (
    status === LiveSessionStatus.WAITING || status === LiveSessionStatus.ACTIVE
  );
}
