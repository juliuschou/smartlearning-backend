/**
 * W3 realtime delivery diagnostic trace — record shapes.
 *
 * Diagnostic-only. These records never participate in delivery control flow; they
 * exist so a W3 run can prove, per `event_seq`, which room/socket the gateway
 * actually emitted to and where a delivery stopped.
 *
 * Redaction posture: a record carries only allowlisted scalar routing/identity
 * fields extracted at the emit call site. It never receives an event payload, so
 * result data, answer text, selected option refs, participant tokens, session
 * codes, cookies, passwords, account ids and display names cannot enter it.
 */

import type { DiagnosticErrorProjection } from '../../../common/observability';

export const REALTIME_TRACE_SCHEMA_VERSION = 1 as const;

/** Which pipeline leg produced a record. */
export type RealtimeTracePhase =
  'publisher' | 'room' | 'guard' | 'emit' | 'delivery';

/** Server-side emit target. `broadcast` is reserved for a future room broadcast. */
export type RealtimeTraceTargetType = 'room' | 'socket' | 'broadcast';

/** Named per-recipient guards that can silently skip an emit. */
export type RealtimeTraceGuard =
  | 'identity_mismatch'
  | 'session_mismatch'
  | 'account_inactive'
  | 'reauthorize_failed'
  | 'reveal_gate'
  | 'no_target_participant'
  | 'no_session_question'
  | 'recipient_filtered'
  | 'fan_out_served'
  | 'unknown_event';

export type RealtimeTraceTransition =
  'delivered' | 'retry' | 'dead' | 'stale_claim_lost' | 'coalesced';

/**
 * One trace record. Publisher-leg fields (`claimedAtIso` .. `transitionWallIso`)
 * are merged onto the emit/room/guard records for the same `eventId` so a single
 * fetch reconstructs the whole leg for one `eventSeq`.
 */
export interface RealtimeTraceRecord {
  schemaVersion: typeof REALTIME_TRACE_SCHEMA_VERSION;
  runId: string;
  /** Trace-service instance identity; distinct from provider identities. */
  instanceId: string;
  backendInstanceId: string;
  processId: number;
  processStartIso: string;
  hostname: string;
  publisherInstanceId?: string;
  publisherClaimToken?: string;
  /** True when the record was created at claim time, before dispatch. */
  claimOnly?: boolean;
  leaseExpiresAtIso?: string;
  markDeliveredClaimToken?: string;
  markDeliveredUpdatedCount?: number;
  markDeliveredSuccess?: boolean;
  leaseTransition?: 'expired' | 'reclaimed' | 'released' | 'retry';
  oldPublisherClaimToken?: string;
  newPublisherClaimToken?: string;
  oldPublisherInstanceId?: string;
  newPublisherInstanceId?: string;
  oldClaimOwnerEvidenceGap?: boolean;
  phase: RealtimeTracePhase;
  /** `live_session_event.id` — joins every phase of one leg. */
  eventId: string;
  /** Wire-format event sequence string (see `toEventSeqWire`). */
  eventSeq: string;
  /** Event name, e.g. `result.updated`. */
  eventType: string;
  liveSessionId: string;
  sessionQuestionId?: string;

  // --- publisher leg ---
  claimedAtIso?: string;
  attemptNumber?: number;
  dispatchStartMonoMs?: number;
  /** True once `dispatchDurableEvent` was entered for this row. */
  gatewayDispatchCalled?: boolean;
  gatewayDispatchReturnedMonoMs?: number;
  dispatchThrew?: DiagnosticErrorProjection;
  transitionTo?: RealtimeTraceTransition;
  transitionWallIso?: string;
  coalescedByEventId?: string;
  coalescedByEventSeq?: string;
  coalescedByAggregateVersion?: number;
  coalescingReason?: 'newer_same_aggregate';
  coalescingComparisons?: {
    sameLiveSessionId: boolean;
    sameSessionQuestionId: boolean;
    sameVisibility: boolean;
    newerEventSeq: boolean;
    nonDecreasingAggregateVersion: boolean;
  };

  // --- gateway leg ---
  targetType: RealtimeTraceTargetType;
  /** Room name (`session:<id>` / `teacher:<id>`) or socket id. */
  targetId: string;
  /** Monotonic emit timestamp (performance.now(), process-relative). */
  emitMonoMs?: number;
  /** Wall-clock emit timestamp (ISO). */
  emitWallIso?: string;
  payloadCorrelation: {
    eventSeq: string;
    aggregateVersion: number;
    visibility: string;
  };

  // --- room evidence ---
  /** Socket ids resolved by the fan-out primitive's own `fetchSockets()`. */
  roomMembersAtEmit?: string[];
  roomMemberCount?: number;
  /** Recipients remaining after visibility/target filtering. */
  recipientCount?: number;
  /** Guarded `adapter.rooms` size; undefined when the adapter is unavailable. */
  adapterRoomSize?: number;

  // --- direct-socket evidence ---
  socketId?: string;
  /** Real Socket exposes `.connected`; a Redis RemoteSocket does not (undefined). */
  connectedState?: boolean;
  clientKind?: 'teacher' | 'participant';
  /** Routing identity only (never a credential). */
  participantId?: string;

  /** Set when the emit was skipped by a named guard instead of being attempted. */
  guard?: RealtimeTraceGuard;

  // --- per-socket delivery outcome ---
  /** Value returned by `socket.emit(...)`; false when it threw. */
  emitReturned?: boolean;
  deliveryOutcome?: 'fulfilled' | 'rejected';
  deliveryErrorType?: string;
  deliveryError?: DiagnosticErrorProjection;
  /** Deliveries already queued ahead of this one on the same socket. */
  queuedBehind?: number;
}

/** Self-reported completeness so a caller can never read loss as "no emit". */
export interface RealtimeTraceStats {
  schemaVersion: typeof REALTIME_TRACE_SCHEMA_VERSION;
  enabled: boolean;
  instanceId: string;
  backendInstanceId: string;
  processId: number;
  processStartIso: string;
  hostname: string;
  lifecycle: Array<{
    component:
      | 'traceService'
      | 'publisher'
      | 'publisher-stop'
      | 'gateway'
      | 'coalescedAggregate';
    instanceId: string;
    constructedAtIso: string;
    /** Only on `coalescedAggregate`: affected rows from one maintenance pass. */
    coalescedCount?: number;
  }>;
  runId: string;
  bufferSize: number;
  /** Records currently retained (bounded by `bufferSize`). */
  recordedCount: number;
  /** Records evicted by the bounded ring since start. */
  droppedCount: number;
  /** Distinct `eventId`s seen by the publisher leg. */
  dispatchedEventCount: number;
}

export interface RealtimeTraceFilter {
  eventId?: string;
  eventSeq?: string;
  eventType?: string;
  liveSessionId?: string;
  phase?: RealtimeTracePhase;
}

export interface RealtimeTimingRecord {
  schemaVersion: typeof REALTIME_TRACE_SCHEMA_VERSION;
  runId: string;
  correlationId: string;
  liveSessionId: string;
  sessionQuestionId: string;
  participantId: string;
  eventId?: string;
  eventSeq?: string;
  eventType?: string;
  requestReceivedAt?: string;
  transactionStartedAt?: string;
  transactionCallbackCompletedAt?: string;
  transactionResolvedAt?: string;
  transactionRolledBackAt?: string;
  outboxAppendStartAt?: string;
  outboxRowCreatedAt?: string;
  publisherWakeRequestedAt?: string;
  claimedAt?: string;
  claimTransactionStartedAt?: string;
  claimTransactionResolvedAt?: string;
  dispatchStartAt?: string;
  dispatchReturnAt?: string;
  markDeliveredStartedAt?: string;
  markDeliveredResolvedAt?: string;
  clientRequestStartAt?: string;
  clientResponseEndAt?: string;
  clientReceiptAt?: string;
}

export interface RealtimeTraceSnapshot {
  stats: RealtimeTraceStats;
  records: RealtimeTraceRecord[];
  timings: RealtimeTimingRecord[];
}
