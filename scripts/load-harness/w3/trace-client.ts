/**
 * W3 diagnostic trace client — fetches the server-side emit trace from the
 * flag-gated endpoint `GET /api/v1/diagnostics/realtime-trace?runId=<id>`.
 *
 * This is the authoritative machine-readable source for "did the gateway actually
 * emit, to which target, and was the recipient set correct" in a W3 diagnostic
 * run. It is deliberately NOT a log parser: log absence is not evidence (see
 * tasks/lessons.md), so the endpoint returns its own completeness counters.
 *
 * Safety rules enforced here:
 *   - a disabled/absent endpoint (404) must NEVER be silently treated as "the
 *     server did not emit" — `enabled=false` is surfaced and callers must refuse
 *     to draw conclusions;
 *   - the response `runId` must equal the fixture run id, so traces from another
 *     run can never be joined into this run's evidence;
 *   - correlation is by deterministic keys (runId + eventSeq + eventType +
 *     socketId/participantId), never by timestamp proximity.
 *
 * Read-only with respect to the application.
 */
import { performance } from 'node:perf_hooks';

export interface TraceLifecycleRecord {
  component:
    | 'traceService'
    | 'publisher'
    | 'publisher-stop'
    | 'gateway'
    | 'coalescedAggregate';
  instanceId: string;
  constructedAtIso: string;
  coalescedCount?: number;
}

export interface TraceRecord {
  schemaVersion: number;
  runId: string;
  instanceId: string;
  backendInstanceId: string;
  processId: number;
  processStartIso: string;
  hostname: string;
  phase: 'publisher' | 'room' | 'guard' | 'emit' | 'delivery';
  eventId: string;
  eventSeq: string;
  eventType: string;
  liveSessionId: string;
  sessionQuestionId?: string;
  claimedAtIso?: string;
  attemptNumber?: number;
  /** True when the publisher record was created at claim time, pre-dispatch. */
  claimOnly?: boolean;
  publisherInstanceId?: string;
  publisherClaimToken?: string;
  dispatchStartMonoMs?: number;
  gatewayDispatchCalled?: boolean;
  gatewayDispatchReturnedMonoMs?: number;
  dispatchThrew?: {
    errorType: string;
    prismaCode?: string;
    databaseCode?: string;
  };
  transitionTo?: string;
  transitionWallIso?: string;
  coalescedByEventId?: string;
  coalescedByEventSeq?: string;
  coalescedByAggregateVersion?: number;
  coalescingReason?: string;
  coalescingComparisons?: {
    sameLiveSessionId: boolean;
    sameSessionQuestionId: boolean;
    sameVisibility: boolean;
    newerEventSeq: boolean;
    nonDecreasingAggregateVersion: boolean;
  };
  targetType: 'room' | 'socket' | 'broadcast';
  targetId: string;
  emitMonoMs?: number;
  emitWallIso?: string;
  payloadCorrelation: {
    eventSeq: string;
    aggregateVersion: number;
    visibility: string;
  };
  roomMembersAtEmit?: string[];
  roomMemberCount?: number;
  recipientCount?: number;
  adapterRoomSize?: number;
  socketId?: string;
  connectedState?: boolean;
  clientKind?: 'teacher' | 'participant';
  participantId?: string;
  guard?: string;
  emitReturned?: boolean;
  deliveryOutcome?: 'fulfilled' | 'rejected';
  deliveryErrorType?: string;
  queuedBehind?: number;
}

export interface TraceStats {
  schemaVersion: number;
  enabled: boolean;
  instanceId: string;
  backendInstanceId: string;
  processId: number;
  processStartIso: string;
  hostname: string;
  lifecycle: TraceLifecycleRecord[];
  runId: string;
  bufferSize: number;
  recordedCount: number;
  droppedCount: number;
  dispatchedEventCount: number;
}

export interface TimingRecord {
  schemaVersion: number;
  runId: string;
  correlationId: string;
  liveSessionId: string;
  sessionQuestionId: string;
  participantId: string;
  eventId?: string;
  eventSeq?: string;
  eventType?: string;
  [key: string]: string | number | undefined;
}

export interface TraceSnapshot {
  /** False when the endpoint is disabled or unreachable — evidence is NOT usable. */
  enabled: boolean;
  /** Present when retrieval failed entirely (e.g. HTTP 404 / network error). */
  unavailableReason?: string;
  runId?: string;
  stats?: TraceStats;
  records: TraceRecord[];
  timings: TimingRecord[];
  /** Run-relative ms when the fetch completed. */
  fetchedAtMs: number;
}

export class TraceClient {
  constructor(
    private readonly baseUrl: string,
    private readonly runId: string,
    private readonly runStartMs: number,
    private readonly timeoutMs: number,
  ) {}

  async fetch(): Promise<TraceSnapshot> {
    return this.fetchSnapshot(false);
  }

  /**
   * Isolation-only fetch: preserves a successful response queried with another
   * run ID so preflight can prove it exposes no records or timings. The active
   * service identity remains in stats and must not be joined to workload data.
   */
  async fetchIsolation(): Promise<TraceSnapshot> {
    return this.fetchSnapshot(true);
  }

  private async fetchSnapshot(
    allowRunIdMismatch: boolean,
  ): Promise<TraceSnapshot> {
    const url = `${this.baseUrl}/api/v1/diagnostics/realtime-trace?runId=${encodeURIComponent(this.runId)}`;
    const fetchedAtMs = (): number => performance.now() - this.runStartMs;
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === 404) {
        return {
          enabled: false,
          unavailableReason: 'DIAGNOSTICS_DISABLED (HTTP 404)',
          records: [],
          timings: [],
          fetchedAtMs: fetchedAtMs(),
        };
      }
      if (!response.ok) {
        return {
          enabled: false,
          unavailableReason: `HTTP ${response.status}`,
          records: [],
          timings: [],
          fetchedAtMs: fetchedAtMs(),
        };
      }
      const body = (await response.json()) as {
        data?: {
          stats?: TraceStats;
          records?: TraceRecord[];
          timings?: TimingRecord[];
        } | null;
      };
      const data = body.data;
      if (
        !data?.stats ||
        !Array.isArray(data.records) ||
        !Array.isArray(data.timings)
      ) {
        return {
          enabled: false,
          unavailableReason: 'MALFORMED_RESPONSE',
          records: [],
          timings: [],
          fetchedAtMs: fetchedAtMs(),
        };
      }
      if (data.stats.runId !== this.runId && !allowRunIdMismatch) {
        // Never join another run's records into normal workload evidence.
        return {
          enabled: false,
          unavailableReason: `RUN_ID_MISMATCH (${data.stats.runId} != ${this.runId})`,
          records: [],
          timings: [],
          fetchedAtMs: fetchedAtMs(),
        };
      }
      return {
        enabled: data.stats.enabled,
        runId: data.stats.runId,
        stats: data.stats,
        records: data.records,
        timings: data.timings,
        fetchedAtMs: fetchedAtMs(),
      };
    } catch (error) {
      return {
        enabled: false,
        unavailableReason:
          error instanceof Error ? `FETCH_ERROR ${error.name}` : 'FETCH_ERROR',
        records: [],
        timings: [],
        fetchedAtMs: fetchedAtMs(),
      };
    }
  }
}

/** Per-`eventSeq` rollup of the server-side trace, for report correlation. */
export interface EventTraceRollup {
  eventSeq: string;
  eventId: string;
  eventType: string;
  visibility?: string;
  gatewayDispatchCalled: boolean;
  dispatchThrew?: string;
  transitionTo?: string;
  /** True when the publisher record exists only at claim level (no dispatch). */
  claimOnly: boolean;
  publisherInstanceId?: string;
  publisherClaimToken?: string;
  coalesced: boolean;
  coalescedByEventId?: string;
  coalescedByEventSeq?: string;
  coalescedByAggregateVersion?: number;
  coalescingComparisons?: TraceRecord['coalescingComparisons'];
  rooms: Array<{
    room: string;
    memberCount?: number;
    recipientCount?: number;
    adapterRoomSize?: number;
    memberSocketIds?: string[];
  }>;
  emittedSocketIds: string[];
  guardSkips: Array<{ socketId: string; guard: string }>;
  deliveryRejected: Array<{ socketId: string; errorType?: string }>;
}

/** Roll up a trace snapshot by `eventSeq` on deterministic keys only. */
export function rollupByEventSeq(records: TraceRecord[]): EventTraceRollup[] {
  const bySeq = new Map<string, EventTraceRollup>();
  for (const record of records) {
    let entry = bySeq.get(record.eventSeq);
    if (!entry) {
      entry = {
        eventSeq: record.eventSeq,
        eventId: record.eventId,
        eventType: record.eventType,
        gatewayDispatchCalled: false,
        claimOnly: false,
        coalesced: false,
        rooms: [],
        emittedSocketIds: [],
        guardSkips: [],
        deliveryRejected: [],
      };
      bySeq.set(record.eventSeq, entry);
    }
    if (record.payloadCorrelation?.visibility) {
      entry.visibility = record.payloadCorrelation.visibility;
    }
    if (record.phase === 'publisher') {
      if (record.gatewayDispatchCalled) entry.gatewayDispatchCalled = true;
      if (record.claimOnly) entry.claimOnly = true;
      if (record.publisherClaimToken) {
        entry.publisherClaimToken = record.publisherClaimToken;
        entry.publisherInstanceId = record.publisherInstanceId;
      }
      if (record.dispatchThrew)
        entry.dispatchThrew = record.dispatchThrew.errorType;
      if (record.transitionTo) entry.transitionTo = record.transitionTo;
      if (record.transitionTo === 'coalesced') {
        entry.coalesced = true;
        entry.coalescedByEventId = record.coalescedByEventId;
        entry.coalescedByEventSeq = record.coalescedByEventSeq;
        entry.coalescedByAggregateVersion = record.coalescedByAggregateVersion;
        entry.coalescingComparisons = record.coalescingComparisons;
      }
    }
    if (record.phase === 'room') {
      entry.rooms.push({
        room: record.targetId,
        memberCount: record.roomMemberCount,
        recipientCount: record.recipientCount,
        adapterRoomSize: record.adapterRoomSize,
        memberSocketIds: record.roomMembersAtEmit,
      });
    }
    if (record.socketId && record.emitMonoMs !== undefined) {
      entry.emittedSocketIds.push(record.socketId);
    }
    if (record.guard && record.socketId) {
      entry.guardSkips.push({ socketId: record.socketId, guard: record.guard });
    }
    if (record.deliveryOutcome === 'rejected' && record.socketId) {
      entry.deliveryRejected.push({
        socketId: record.socketId,
        errorType: record.deliveryErrorType,
      });
    }
  }
  return [...bySeq.values()];
}
