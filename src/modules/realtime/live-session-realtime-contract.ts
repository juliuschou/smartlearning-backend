import { isUuid, normalizeUuid } from '../../common/crypto';
import {
  LiveSessionStatus,
  SessionQuestionStatus,
} from '../live-sessions/domain';

export const REALTIME_SCHEMA_VERSION = 1 as const;

export const RealtimeEvent = {
  SESSION_SNAPSHOT: 'session.snapshot',
  SESSION_STATE_CHANGED: 'session.state_changed',
  QUESTION_OPENED: 'question.opened',
  QUESTION_CLOSED: 'question.closed',
  RESULT_UPDATED: 'result.updated',
  SESSION_CLOSED: 'session.closed',
  SYNC_REQUIRED: 'sync.required',
} as const;

export type RealtimeEventName =
  (typeof RealtimeEvent)[keyof typeof RealtimeEvent];

export const REALTIME_EVENT_NAMES: readonly RealtimeEventName[] = [
  RealtimeEvent.SESSION_SNAPSHOT,
  RealtimeEvent.SESSION_STATE_CHANGED,
  RealtimeEvent.QUESTION_OPENED,
  RealtimeEvent.QUESTION_CLOSED,
  RealtimeEvent.RESULT_UPDATED,
  RealtimeEvent.SESSION_CLOSED,
  RealtimeEvent.SYNC_REQUIRED,
];

/** Legacy notifications remain a compatibility boundary, not durable events. */
export const REALTIME_LEGACY_EVENT_NAMES = [
  'participant.joined',
  'submission.committed',
  'counts.updated',
] as const;

export const RealtimeVisibility = {
  SESSION: 'session',
  TEACHER: 'teacher',
  PARTICIPANT: 'participant',
  PARTICIPANT_AFTER_SUBMIT: 'participant_after_submit',
} as const;

export type RealtimeVisibility =
  (typeof RealtimeVisibility)[keyof typeof RealtimeVisibility];

export const REALTIME_VISIBILITIES: readonly RealtimeVisibility[] = [
  RealtimeVisibility.SESSION,
  RealtimeVisibility.TEACHER,
  RealtimeVisibility.PARTICIPANT,
  RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT,
];

/** `all` was used by R-1-lite and remains a compatibility-only value. */
export const REALTIME_LEGACY_VISIBILITIES = ['all'] as const;

export const RealtimeDeliveryState = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  RETRY: 'retry',
  DELIVERED: 'delivered',
  DEAD: 'dead',
} as const;

export type RealtimeDeliveryState =
  (typeof RealtimeDeliveryState)[keyof typeof RealtimeDeliveryState];

export const REALTIME_DELIVERY_STATES: readonly RealtimeDeliveryState[] = [
  RealtimeDeliveryState.PENDING,
  RealtimeDeliveryState.PROCESSING,
  RealtimeDeliveryState.RETRY,
  RealtimeDeliveryState.DELIVERED,
  RealtimeDeliveryState.DEAD,
];

export const RealtimeSyncReason = {
  INVALID_CURSOR: 'invalid_cursor',
  OVER_CURRENT: 'over_current',
  STALE: 'stale',
  EXPIRED: 'expired',
  GAP: 'gap',
  COALESCED: 'coalesced',
  DEAD: 'dead',
  PERMISSION_INVALID: 'permission_invalid',
  SESSION_BOUNDARY: 'session_boundary',
} as const;

export type RealtimeSyncReason =
  (typeof RealtimeSyncReason)[keyof typeof RealtimeSyncReason];

export const RealtimeCheckpointReason = {
  INITIAL: 'initial',
  PARTICIPANT_JOINED: 'participant_joined',
  RECOVERY: 'recovery',
} as const;

export type RealtimeCheckpointReason =
  (typeof RealtimeCheckpointReason)[keyof typeof RealtimeCheckpointReason];

export type RealtimeOutboxReason =
  RealtimeSyncReason | RealtimeCheckpointReason;

export const REALTIME_STATUSES = [
  LiveSessionStatus.WAITING,
  LiveSessionStatus.ACTIVE,
  LiveSessionStatus.CLOSED,
  LiveSessionStatus.CANCELLED,
  SessionQuestionStatus.NOT_OPEN,
  SessionQuestionStatus.OPEN,
  SessionQuestionStatus.CLOSED,
] as const;

export type RealtimeStatus = (typeof REALTIME_STATUSES)[number];

export interface RealtimeEventEnvelope<T = Record<string, unknown>> {
  event: RealtimeEventName;
  schemaVersion: typeof REALTIME_SCHEMA_VERSION;
  /** Decimal string to avoid JavaScript precision loss for PostgreSQL BIGINT. */
  eventSeq: string;
  aggregateVersion: number;
  serverTimestamp: string;
  liveSessionId: string;
  visibility: RealtimeVisibility;
  data: T;
}

export interface RealtimeWatermark {
  /** Decimal string to avoid JavaScript precision loss for PostgreSQL BIGINT. */
  eventSeq: string;
  aggregateVersions: Readonly<Record<string, number>>;
}

export interface SafeRealtimeOutboxInput {
  readonly reason?: RealtimeOutboxReason;
  readonly status?: RealtimeStatus;
  readonly sessionQuestionId?: string;
  readonly aggregateVersion?: number;
  readonly visibility?: RealtimeVisibility;
}

const SAFE_OUTBOX_KEYS = [
  'reason',
  'status',
  'sessionQuestionId',
  'aggregateVersion',
  'visibility',
] as const;

const REALTIME_OUTBOX_REASONS: readonly RealtimeOutboxReason[] = [
  ...Object.values(RealtimeSyncReason),
  ...Object.values(RealtimeCheckpointReason),
];

export function isRealtimeEventName(value: string): value is RealtimeEventName {
  return (REALTIME_EVENT_NAMES as readonly string[]).includes(value);
}

export function isRealtimeVisibility(
  value: string,
): value is RealtimeVisibility {
  return (REALTIME_VISIBILITIES as readonly string[]).includes(value);
}

export function isRealtimeDeliveryState(
  value: string,
): value is RealtimeDeliveryState {
  return (REALTIME_DELIVERY_STATES as readonly string[]).includes(value);
}

export function isRealtimeStatus(value: string): value is RealtimeStatus {
  return (REALTIME_STATUSES as readonly string[]).includes(value);
}

/**
 * Validate the small immutable input persisted with an outbox event. The
 * allowlist deliberately excludes participant/account identifiers, tokens and
 * answer-bearing content; those projections are materialized at delivery time.
 */
export function parseSafeRealtimeOutboxInput(
  value: unknown,
): SafeRealtimeOutboxInput {
  if (!isRecord(value)) throw new TypeError('Outbox input must be an object.');

  const unknownKey = Object.keys(value).find(
    (key) => !(SAFE_OUTBOX_KEYS as readonly string[]).includes(key),
  );
  if (unknownKey) {
    throw new TypeError(`Outbox input field is not safe: ${unknownKey}`);
  }

  const output: {
    reason?: RealtimeOutboxReason;
    status?: RealtimeStatus;
    sessionQuestionId?: string;
    aggregateVersion?: number;
    visibility?: RealtimeVisibility;
  } = {};
  if (value.reason !== undefined) {
    if (
      typeof value.reason !== 'string' ||
      !(REALTIME_OUTBOX_REASONS as readonly string[]).includes(value.reason)
    ) {
      throw new TypeError('Outbox input reason is invalid.');
    }
    output.reason = value.reason as RealtimeOutboxReason;
  }
  if (value.status !== undefined) {
    if (typeof value.status !== 'string' || !isRealtimeStatus(value.status)) {
      throw new TypeError('Outbox input status is invalid.');
    }
    output.status = value.status;
  }
  if (value.sessionQuestionId !== undefined) {
    if (
      typeof value.sessionQuestionId !== 'string' ||
      !isUuid(value.sessionQuestionId)
    ) {
      throw new TypeError('Outbox input sessionQuestionId is invalid.');
    }
    output.sessionQuestionId = normalizeUuid(value.sessionQuestionId);
  }
  if (value.aggregateVersion !== undefined) {
    assertAggregateVersion(value.aggregateVersion);
    output.aggregateVersion = value.aggregateVersion;
  }
  if (value.visibility !== undefined) {
    if (
      typeof value.visibility !== 'string' ||
      !isRealtimeVisibility(value.visibility)
    ) {
      throw new TypeError('Outbox input visibility is invalid.');
    }
    output.visibility = value.visibility;
  }
  return output;
}

export type EventSeqInput = bigint | number | string;

const DECIMAL_SEQUENCE = /^(?:0|[1-9][0-9]*)$/u;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const MAX_POSTGRES_BIGINT_WIRE = MAX_POSTGRES_BIGINT.toString();

/** Parse the optional Socket.IO cursor without accepting lossy number forms. */
export function parseLastEventSeq(
  value: unknown,
):
  | { kind: 'absent' }
  | { kind: 'valid'; value: bigint; wire: string }
  | { kind: 'invalid'; reason: 'malformed' | 'negative' } {
  if (value === undefined || value === null) return { kind: 'absent' };
  if (typeof value !== 'string') {
    return { kind: 'invalid', reason: 'malformed' };
  }
  if (value.startsWith('-')) {
    return { kind: 'invalid', reason: 'negative' };
  }
  if (!DECIMAL_SEQUENCE.test(value)) {
    return { kind: 'invalid', reason: 'malformed' };
  }
  if (
    value.length > MAX_POSTGRES_BIGINT_WIRE.length ||
    (value.length === MAX_POSTGRES_BIGINT_WIRE.length &&
      value > MAX_POSTGRES_BIGINT_WIRE)
  ) {
    return { kind: 'invalid', reason: 'malformed' };
  }
  const parsed = BigInt(value);
  return { kind: 'valid', value: parsed, wire: parsed.toString() };
}

/** Convert a PostgreSQL sequence value to its lossless JSON representation. */
export function toEventSeqWire(value: EventSeqInput): string {
  if (typeof value === 'bigint') {
    assertNonNegativeSequence(value);
    return value.toString();
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        'Event sequence number must be a safe non-negative integer.',
      );
    }
    return String(value);
  }
  const parsed = parseLastEventSeq(value);
  if (parsed.kind !== 'valid') {
    throw new TypeError(
      'Event sequence must be a canonical non-negative decimal.',
    );
  }
  return parsed.wire;
}

export function nextEventSeq(value: EventSeqInput): bigint {
  const next = toEventSeqBigInt(value) + 1n;
  assertNonNegativeSequence(next);
  return next;
}

export const RealtimeAggregateTrigger = {
  SUBMISSION_ACCEPTED: 'submission.accepted',
  QUESTION_CLOSED: 'question.closed',
  OTHER: 'other',
} as const;

export type RealtimeAggregateTrigger =
  (typeof RealtimeAggregateTrigger)[keyof typeof RealtimeAggregateTrigger];

/**
 * Submission acceptance and question close are the only aggregate mutations.
 * Lifecycle-only events carry the current/neutral version and do not increment.
 */
export function nextAggregateVersion(
  current: number,
  trigger: RealtimeAggregateTrigger,
): number {
  assertAggregateVersion(current);
  if (
    trigger !== RealtimeAggregateTrigger.SUBMISSION_ACCEPTED &&
    trigger !== RealtimeAggregateTrigger.QUESTION_CLOSED
  ) {
    return current;
  }
  if (current >= 2_147_483_647) {
    throw new RangeError('Aggregate version exceeds PostgreSQL Int range.');
  }
  return current + 1;
}

export function isAggregateVersionedEvent(event: RealtimeEventName): boolean {
  return (
    event === RealtimeEvent.RESULT_UPDATED ||
    event === RealtimeEvent.QUESTION_CLOSED
  );
}

export function toWatermark(
  eventSeq: EventSeqInput,
  aggregateVersions: Readonly<Record<string, number>>,
): RealtimeWatermark {
  if (!isRecord(aggregateVersions)) {
    throw new TypeError('Aggregate versions must be an object.');
  }
  const normalized: Record<string, number> = {};
  for (const [questionId, version] of Object.entries(aggregateVersions)) {
    if (!isUuid(questionId)) {
      throw new TypeError('Aggregate version key must be a UUID.');
    }
    assertAggregateVersion(version);
    normalized[normalizeUuid(questionId)] = version;
  }
  return {
    eventSeq: toEventSeqWire(eventSeq),
    aggregateVersions: sortRecord(normalized),
  };
}

export type WatermarkComparison = 'older' | 'equal' | 'newer';

/** Compare a candidate snapshot/event watermark without applying stale state. */
export function compareWatermarks(
  current: RealtimeWatermark,
  incoming: RealtimeWatermark,
): WatermarkComparison {
  const currentSeq = toEventSeqBigInt(current.eventSeq);
  const incomingSeq = toEventSeqBigInt(incoming.eventSeq);
  if (incomingSeq < currentSeq) return 'older';
  if (incomingSeq > currentSeq) return 'newer';

  let hasNewerVersion = false;
  for (const [questionId, currentVersion] of Object.entries(
    current.aggregateVersions,
  )) {
    const incomingVersion = incoming.aggregateVersions[questionId];
    // Actor-scoped snapshots may legitimately stop exposing a question after
    // it closes or permissions change. A missing key is therefore not proof of
    // older state; only an observed lower version is stale.
    if (incomingVersion === undefined) continue;
    if (incomingVersion < currentVersion) return 'older';
    if (incomingVersion > currentVersion) hasNewerVersion = true;
  }
  for (const [questionId, incomingVersion] of Object.entries(
    incoming.aggregateVersions,
  )) {
    if (!(questionId in current.aggregateVersions) && incomingVersion > 0) {
      hasNewerVersion = true;
    }
  }
  return hasNewerVersion ? 'newer' : 'equal';
}

export function shouldApplyWatermark(
  current: RealtimeWatermark | null,
  incoming: RealtimeWatermark,
): boolean {
  return current === null || compareWatermarks(current, incoming) === 'newer';
}

export interface RealtimeReplayRow {
  eventSeq: EventSeqInput;
  event: RealtimeEventName;
  visibility: RealtimeVisibility;
  deliveryState: RealtimeDeliveryState;
  /** Hidden rows still establish sequence continuity but return no data. */
  visible: boolean;
  coalesced?: boolean;
  expired?: boolean;
}

export type ReplayCursorState =
  'valid' | 'stale' | 'expired' | 'permission_invalid';

export type ReplayDecision =
  | { kind: 'snapshot'; reason: 'initial' }
  | {
      kind: 'replay';
      events: readonly RealtimeReplayRow[];
      terminal: boolean;
    }
  | { kind: 'sync_required'; reason: RealtimeSyncReason };

export interface ReplayAssessmentInput {
  cursor: EventSeqInput | null;
  currentEventSeq: EventSeqInput;
  oldestRetainedEventSeq?: EventSeqInput | null;
  rows: readonly RealtimeReplayRow[];
  cursorState?: ReplayCursorState;
}

/**
 * Decide whether a cursor can be replayed from retained sequence evidence.
 * Hidden rows count toward continuity but never expose their projection. A
 * visible coalesced/dead/expired row cannot prove the missing client state, so
 * recovery uses sync.required plus a fresh actor-safe snapshot.
 */
export function assessReplay(input: ReplayAssessmentInput): ReplayDecision {
  if (input.cursor === null) return { kind: 'snapshot', reason: 'initial' };
  if (input.cursorState && input.cursorState !== 'valid') {
    return {
      kind: 'sync_required',
      reason: input.cursorState,
    };
  }

  const cursor = toEventSeqBigInt(input.cursor);
  const current = toEventSeqBigInt(input.currentEventSeq);
  if (cursor < 0n) {
    return { kind: 'sync_required', reason: RealtimeSyncReason.INVALID_CURSOR };
  }
  if (cursor > current) {
    return { kind: 'sync_required', reason: RealtimeSyncReason.OVER_CURRENT };
  }
  if (cursor === current) {
    return { kind: 'replay', events: [], terminal: false };
  }

  const oldest =
    input.oldestRetainedEventSeq === undefined ||
    input.oldestRetainedEventSeq === null
      ? null
      : toEventSeqBigInt(input.oldestRetainedEventSeq);
  if (oldest === null) {
    return { kind: 'sync_required', reason: RealtimeSyncReason.GAP };
  }
  if (cursor + 1n < oldest) {
    return { kind: 'sync_required', reason: RealtimeSyncReason.EXPIRED };
  }

  let expected = cursor + 1n;
  let terminal = false;
  const events: RealtimeReplayRow[] = [];
  for (const row of input.rows) {
    const sequence = toEventSeqBigInt(row.eventSeq);
    if (sequence < expected) {
      return { kind: 'sync_required', reason: RealtimeSyncReason.STALE };
    }
    if (sequence > expected) {
      return { kind: 'sync_required', reason: RealtimeSyncReason.GAP };
    }
    if (sequence > current) {
      return { kind: 'sync_required', reason: RealtimeSyncReason.OVER_CURRENT };
    }

    if (row.visible) {
      if (row.expired) {
        return { kind: 'sync_required', reason: RealtimeSyncReason.EXPIRED };
      }
      if (row.deliveryState === RealtimeDeliveryState.DEAD) {
        return { kind: 'sync_required', reason: RealtimeSyncReason.DEAD };
      }
      if (row.coalesced) {
        return { kind: 'sync_required', reason: RealtimeSyncReason.COALESCED };
      }
      events.push(row);
      if (row.event === RealtimeEvent.SESSION_CLOSED) terminal = true;
    }
    expected += 1n;
  }

  if (expected <= current) {
    return { kind: 'sync_required', reason: RealtimeSyncReason.GAP };
  }
  return { kind: 'replay', events, terminal };
}

export interface CoalescingCandidate {
  event: RealtimeEventName;
  deliveryState: RealtimeDeliveryState;
  liveSessionId: string;
  sessionQuestionId?: string;
  visibility: RealtimeVisibility;
}

/** Only pending/retry result display notifications may be coalesced. */
export function isEligibleForCoalescing(
  candidate: CoalescingCandidate,
): boolean {
  return (
    candidate.event === RealtimeEvent.RESULT_UPDATED &&
    (candidate.deliveryState === RealtimeDeliveryState.PENDING ||
      candidate.deliveryState === RealtimeDeliveryState.RETRY) &&
    candidate.sessionQuestionId !== undefined &&
    isUuid(candidate.liveSessionId) &&
    isUuid(candidate.sessionQuestionId) &&
    (candidate.visibility === RealtimeVisibility.TEACHER ||
      candidate.visibility === RealtimeVisibility.PARTICIPANT)
  );
}

export function coalescingKey(candidate: CoalescingCandidate): string {
  if (!isEligibleForCoalescing(candidate)) {
    throw new Error('Realtime event is not eligible for coalescing.');
  }
  return [
    normalizeUuid(candidate.liveSessionId),
    normalizeUuid(candidate.sessionQuestionId!),
    candidate.visibility,
  ].join('|');
}

/** Canonical lock protocol shared by submit/close and lifecycle transitions. */
export const REALTIME_LOCK_ORDER = ['liveSession', 'sessionQuestion'] as const;

/** Account-bound paths extend the shared order with authorization rows. */
export const ACCOUNT_BOUND_REALTIME_LOCK_ORDER = [
  'liveSession',
  'course',
  'account',
] as const;

export function hasLockOrder(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((resource, index) => resource === expected[index])
  );
}

export const RealtimeRedisMode = {
  OFF: 'off',
  OPTIONAL: 'optional',
  REQUIRED: 'required',
} as const;

export type RealtimeRedisMode =
  (typeof RealtimeRedisMode)[keyof typeof RealtimeRedisMode];

export const REALTIME_REDIS_MODES: readonly RealtimeRedisMode[] = [
  RealtimeRedisMode.OFF,
  RealtimeRedisMode.OPTIONAL,
  RealtimeRedisMode.REQUIRED,
];

export function parseRealtimeRedisMode(value: unknown): RealtimeRedisMode {
  if (
    typeof value === 'string' &&
    (REALTIME_REDIS_MODES as readonly string[]).includes(value)
  ) {
    return value as RealtimeRedisMode;
  }
  if (value === undefined || value === null || value === '') {
    return RealtimeRedisMode.OFF;
  }
  throw new TypeError(
    'REALTIME_REDIS_MODE must be off, optional, or required.',
  );
}

export type RedisAvailability = 'available' | 'unavailable';

export interface RealtimeRedisPolicy {
  adapter: 'local' | 'redis';
  readiness: 'healthy' | 'degraded' | 'unready';
  acceptsTraffic: boolean;
}

export function resolveRealtimeRedisPolicy(
  mode: RealtimeRedisMode,
  availability: RedisAvailability,
): RealtimeRedisPolicy {
  if (mode === RealtimeRedisMode.OFF) {
    return { adapter: 'local', readiness: 'healthy', acceptsTraffic: true };
  }
  if (availability === 'available') {
    return { adapter: 'redis', readiness: 'healthy', acceptsTraffic: true };
  }
  if (mode === RealtimeRedisMode.OPTIONAL) {
    return { adapter: 'local', readiness: 'degraded', acceptsTraffic: true };
  }
  return { adapter: 'local', readiness: 'unready', acceptsTraffic: false };
}

function assertNonNegativeSequence(value: bigint): void {
  if (value < 0n) throw new RangeError('Event sequence must be non-negative.');
  if (value > MAX_POSTGRES_BIGINT) {
    throw new RangeError('Event sequence exceeds PostgreSQL BIGINT range.');
  }
}

function toEventSeqBigInt(value: EventSeqInput): bigint {
  if (typeof value === 'bigint') {
    assertNonNegativeSequence(value);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        'Event sequence number must be a safe non-negative integer.',
      );
    }
    return BigInt(value);
  }
  const parsed = parseLastEventSeq(value);
  if (parsed.kind !== 'valid') {
    throw new TypeError(
      'Event sequence must be a canonical non-negative decimal.',
    );
  }
  return parsed.value;
}

function assertAggregateVersion(value: unknown): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 2_147_483_647
  ) {
    throw new RangeError(
      'Aggregate version must be a non-negative PostgreSQL Int.',
    );
  }
}

function sortRecord<T>(record: Record<string, T>): Readonly<Record<string, T>> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
