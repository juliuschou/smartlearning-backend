import { Injectable } from '@nestjs/common';
import { newId } from '../../../common/crypto';
import { errorType } from '../../../common/observability';
import { realtimeRuntimeIdentity } from './realtime-runtime-identity';
import {
  REALTIME_TRACE_SCHEMA_VERSION,
  type RealtimeTraceFilter,
  type RealtimeTraceGuard,
  type RealtimeTraceRecord,
  type RealtimeTraceSnapshot,
  type RealtimeTraceStats,
  type RealtimeTraceTransition,
  type RealtimeTimingRecord,
} from './realtime-trace.types';

const DEFAULT_BUFFER_SIZE = 5_000;
const MAX_BUFFER_SIZE = 200_000;
const KEY_SEP = '\u0000';

/**
 * W3 realtime delivery diagnostic sink.
 *
 * Diagnostic-only and OFF by default. When disabled every `record*` method is one
 * short-circuited property check: no allocation, no I/O, no log, and no change to
 * the caller's control flow. Even when enabled, no method throws — a diagnostics
 * failure must never alter delivery behaviour (mirrors `MetricsService.tryRecord`).
 *
 * Records live in a fixed-size ring buffer and are never persisted. Retrieval is
 * filtered by `runId` only, so one run can never read another run's trace.
 *
 * Keying: one record per (eventId, scope) where scope is `publisher`, a room name,
 * or a socket id. A socket-scoped record is advanced in place as the leg
 * progresses (emit → delivery), so a single fetch returns one row per recipient.
 */
@Injectable()
export class RealtimeTraceService {
  /** Gateway/publisher instance identity (one per process). */
  readonly instanceId: string;
  /** Enabled only when the diagnostic env flag is exactly `'1'`. */
  readonly enabled: boolean;
  /** Run scope stamped on every record; echoed back so a caller can assert it. */
  readonly runId: string;
  /** Secondary forensic Pino echo — left off during measured runs. */
  readonly logEnabled: boolean;
  readonly backendInstanceId = realtimeRuntimeIdentity.backendInstanceId;
  readonly processId = realtimeRuntimeIdentity.processId;
  readonly processStartIso = realtimeRuntimeIdentity.processStartIso;
  readonly hostname = realtimeRuntimeIdentity.hostname;

  private readonly lifecycleRecords: RealtimeTraceStats['lifecycle'] = [];
  private readonly bufferSize: number;
  private readonly records: RealtimeTraceRecord[] = [];
  private readonly timingRecords = new Map<string, RealtimeTimingRecord>();
  /**
   * F5 hardening: correlationId → timingRecords whose `eventId` matches, so
   * `updateTimingByEvent` is O(1) per index lookup instead of a full scan of
   * every timing record. Entries are removed together with their timing record
   * (via `snapshot` filtering and `dropTiming`), keeping the index bounded by
   * the same set of keys as `timingRecords` itself.
   */
  private readonly timingByEvent = new Map<string, Set<string>>();
  private readonly recordByKey = new Map<string, RealtimeTraceRecord>();
  private droppedCount = 0;
  private readonly dispatchedEventIds = new Set<string>();

  constructor() {
    // Plain-env idiom (matches `W1_DIAGNOSTICS === '1'`): a field absent from
    // `EnvConfig` is never coerced, so `ConfigService.get<boolean>()` would treat
    // the strings `'0'`/`'false'` as truthy. Read once, at construction.
    this.enabled = process.env.REALTIME_TRACE_ENABLED === '1';
    this.logEnabled = process.env.REALTIME_TRACE_LOG === '1';
    this.instanceId = newId();
    this.runId = this.enabled
      ? process.env.REALTIME_TRACE_RUN_ID?.trim() || this.instanceId
      : '';
    this.bufferSize = clampBufferSize(process.env.REALTIME_TRACE_BUFFER_SIZE);
    this.recordLifecycle('traceService', this.instanceId);
  }

  recordLifecycle(
    component:
      | 'traceService'
      | 'publisher'
      | 'publisher-stop'
      | 'gateway'
      | 'coalescedAggregate',
    instanceId: string,
  ): void {
    if (!this.enabled) return;
    this.safe(() => {
      this.lifecycleRecords.push({
        component,
        instanceId,
        constructedAtIso: new Date().toISOString(),
      });
    });
  }

  // --- publisher leg ------------------------------------------------------

  /**
   * Attribution-only record at claim time, before any dispatch attempt. Fills
   * the "claimed but never reached dispatchTraced" evidence gap: without this,
   * a row claimed by a process that then failed before dispatch shows no
   * publisher-phase record at all and becomes unattributable.
   */
  recordClaimed(input: {
    eventId: string;
    eventSeq: string;
    eventType: string;
    liveSessionId: string;
    sessionQuestionId?: string;
    claimedAtIso: string;
    leaseExpiresAtIso?: string;
    attemptNumber: number;
    publisherInstanceId: string;
    publisherClaimToken: string;
    aggregateVersion: number;
    visibility: string;
    targetParticipantId?: string | null;
  }): void {
    if (!this.enabled) return;
    this.safe(() => {
      const { record, created } = this.upsert(
        publisherKey(input.eventId),
        'publisher',
        {
          eventId: input.eventId,
          eventSeq: input.eventSeq,
          eventType: input.eventType,
          liveSessionId: input.liveSessionId,
          sessionQuestionId: input.sessionQuestionId,
          aggregateVersion: input.aggregateVersion,
          visibility: input.visibility,
        },
      );
      record.claimedAtIso = input.claimedAtIso;
      if (input.leaseExpiresAtIso !== undefined)
        record.leaseExpiresAtIso = input.leaseExpiresAtIso;
      record.attemptNumber = input.attemptNumber;
      record.publisherInstanceId = input.publisherInstanceId;
      record.publisherClaimToken = input.publisherClaimToken;
      record.claimOnly = true;
      if (created) this.maybeLog(record);
    });
  }

  recordClaim(input: {
    eventId: string;
    eventSeq: string;
    eventType: string;
    liveSessionId: string;
    sessionQuestionId?: string;
    claimedAtIso: string;
    leaseExpiresAtIso?: string;
    attemptNumber: number;
    publisherInstanceId?: string;
    publisherClaimToken?: string;
    aggregateVersion: number;
    visibility: string;
  }): void {
    if (!this.enabled) return;
    this.safe(() => {
      this.dispatchedEventIds.add(input.eventId);
      const { record, created } = this.upsert(
        publisherKey(input.eventId),
        'publisher',
        {
          eventId: input.eventId,
          eventSeq: input.eventSeq,
          eventType: input.eventType,
          liveSessionId: input.liveSessionId,
          sessionQuestionId: input.sessionQuestionId,
          aggregateVersion: input.aggregateVersion,
          visibility: input.visibility,
        },
      );
      record.claimedAtIso = input.claimedAtIso;
      if (input.leaseExpiresAtIso !== undefined)
        record.leaseExpiresAtIso = input.leaseExpiresAtIso;
      record.attemptNumber = input.attemptNumber;
      if (input.publisherInstanceId !== undefined)
        record.publisherInstanceId = input.publisherInstanceId;
      if (input.publisherClaimToken !== undefined)
        record.publisherClaimToken = input.publisherClaimToken;
      if (created) this.maybeLog(record);
    });
  }

  recordDispatchStart(eventId: string, monoMs: number): void {
    if (!this.enabled) return;
    this.safe(() => {
      const record = this.recordByKey.get(publisherKey(eventId));
      if (!record) return;
      record.dispatchStartMonoMs = monoMs;
      record.gatewayDispatchCalled = true;
    });
  }

  recordDispatchReturned(eventId: string, monoMs: number): void {
    if (!this.enabled) return;
    this.safe(() => {
      const record = this.recordByKey.get(publisherKey(eventId));
      if (record) record.gatewayDispatchReturnedMonoMs = monoMs;
    });
  }

  recordDispatchThrew(eventId: string, error: unknown): void {
    if (!this.enabled) return;
    this.safe(() => {
      const record = this.recordByKey.get(publisherKey(eventId));
      if (record) record.dispatchThrew = { errorType: errorType(error) };
    });
  }

  recordCoalesced(input: {
    eventId: string;
    eventSeq: string;
    eventType: string;
    liveSessionId: string;
    sessionQuestionId: string;
    aggregateVersion: number;
    visibility: string;
    coalescedAtIso: string;
    supersedingEventId: string;
    supersedingEventSeq: string;
    supersedingAggregateVersion: number;
    comparisons: NonNullable<RealtimeTraceRecord['coalescingComparisons']>;
  }): void {
    if (!this.enabled) return;
    this.safe(() => {
      const { record, created } = this.upsert(
        publisherKey(input.eventId),
        'publisher',
        {
          eventId: input.eventId,
          eventSeq: input.eventSeq,
          eventType: input.eventType,
          liveSessionId: input.liveSessionId,
          sessionQuestionId: input.sessionQuestionId,
          aggregateVersion: input.aggregateVersion,
          visibility: input.visibility,
        },
      );
      record.transitionTo = 'coalesced';
      record.transitionWallIso = input.coalescedAtIso;
      record.coalescedByEventId = input.supersedingEventId;
      record.coalescedByEventSeq = input.supersedingEventSeq;
      record.coalescedByAggregateVersion = input.supersedingAggregateVersion;
      record.coalescingReason = 'newer_same_aggregate';
      record.coalescingComparisons = { ...input.comparisons };
      if (created) this.maybeLog(record);
    });
  }

  recordTransition(
    eventId: string,
    transition: RealtimeTraceTransition,
    wallIso: string,
  ): void {
    if (!this.enabled) return;
    this.safe(() => {
      const record = this.recordByKey.get(publisherKey(eventId));
      if (!record) return;
      record.transitionTo = transition;
      record.transitionWallIso = wallIso;
    });
  }

  // --- room fan-out evidence ---------------------------------------------

  recordRoom(input: {
    eventId: string;
    eventSeq: string;
    eventType: string;
    liveSessionId: string;
    sessionQuestionId?: string;
    room: string;
    memberSocketIds: string[];
    recipientCount: number;
    adapterRoomSize?: number;
    aggregateVersion: number;
    visibility: string;
  }): void {
    if (!this.enabled) return;
    this.safe(() => {
      const { record, created } = this.upsert(
        roomKey(input.eventId, input.room),
        'room',
        {
          eventId: input.eventId,
          eventSeq: input.eventSeq,
          eventType: input.eventType,
          liveSessionId: input.liveSessionId,
          sessionQuestionId: input.sessionQuestionId,
          room: input.room,
          aggregateVersion: input.aggregateVersion,
          visibility: input.visibility,
        },
      );
      record.roomMembersAtEmit = input.memberSocketIds;
      record.roomMemberCount = input.memberSocketIds.length;
      record.recipientCount = input.recipientCount;
      if (input.adapterRoomSize !== undefined)
        record.adapterRoomSize = input.adapterRoomSize;
      if (created) this.maybeLog(record);
    });
  }

  // --- guards -------------------------------------------------------------

  recordGuard(input: {
    eventId: string;
    eventSeq: string;
    eventType: string;
    liveSessionId: string;
    sessionQuestionId?: string;
    guard: RealtimeTraceGuard;
    socketId?: string;
    connectedState?: boolean;
    clientKind?: 'teacher' | 'participant';
    participantId?: string;
    aggregateVersion: number;
    visibility: string;
  }): void {
    if (!this.enabled || input.socketId === undefined) return;
    this.safe(() => {
      const { record, created } = this.upsert(
        socketKey(input.eventId, input.eventType, input.socketId as string),
        'guard',
        {
          eventId: input.eventId,
          eventSeq: input.eventSeq,
          eventType: input.eventType,
          liveSessionId: input.liveSessionId,
          sessionQuestionId: input.sessionQuestionId,
          socketId: input.socketId,
          connectedState: input.connectedState,
          clientKind: input.clientKind,
          participantId: input.participantId,
          aggregateVersion: input.aggregateVersion,
          visibility: input.visibility,
        },
      );
      record.guard = input.guard;
      if (created) this.maybeLog(record);
    });
  }

  // --- emit ---------------------------------------------------------------

  recordEmit(input: {
    eventId: string;
    eventSeq: string;
    eventType: string;
    liveSessionId: string;
    sessionQuestionId?: string;
    socketId: string;
    connectedState?: boolean;
    clientKind?: 'teacher' | 'participant';
    participantId?: string;
    aggregateVersion: number;
    visibility: string;
    emitMonoMs: number;
  }): void {
    if (!this.enabled) return;
    this.safe(() => {
      const { record, created } = this.upsert(
        socketKey(input.eventId, input.eventType, input.socketId),
        'emit',
        {
          eventId: input.eventId,
          eventSeq: input.eventSeq,
          eventType: input.eventType,
          liveSessionId: input.liveSessionId,
          sessionQuestionId: input.sessionQuestionId,
          socketId: input.socketId,
          connectedState: input.connectedState,
          clientKind: input.clientKind,
          participantId: input.participantId,
          aggregateVersion: input.aggregateVersion,
          visibility: input.visibility,
        },
      );
      record.emitMonoMs = input.emitMonoMs;
      record.emitWallIso = new Date().toISOString();
      if (created) this.maybeLog(record);
    });
  }

  recordEmitReturned(
    eventId: string,
    eventName: string,
    socketId: string,
    returned: boolean,
  ): void {
    if (!this.enabled) return;
    this.safe(() => {
      const record = this.recordByKey.get(
        socketKey(eventId, eventName, socketId),
      );
      if (record) record.emitReturned = returned;
    });
  }

  recordEmitThrew(
    eventId: string,
    eventName: string,
    socketId: string,
    error: unknown,
  ): void {
    if (!this.enabled) return;
    this.safe(() => {
      const record = this.recordByKey.get(
        socketKey(eventId, eventName, socketId),
      );
      if (record) {
        record.emitReturned = false;
        record.deliveryErrorType = errorType(error);
      }
    });
  }

  // --- per-socket delivery queue -----------------------------------------

  recordDelivery(input: {
    eventId: string;
    eventName: string;
    socketId: string;
    outcome: 'fulfilled' | 'rejected';
    errorType?: string;
    queuedBehind: number;
  }): void {
    if (!this.enabled) return;
    this.safe(() => {
      const record = this.recordByKey.get(
        socketKey(input.eventId, input.eventName, input.socketId),
      );
      if (!record) return;
      record.deliveryOutcome = input.outcome;
      record.queuedBehind = input.queuedBehind;
      if (input.errorType !== undefined)
        record.deliveryErrorType = input.errorType;
    });
  }

  recordMarkDelivered(
    eventId: string,
    input: {
      eventSeq: string;
      claimToken: string;
      updatedCount: number;
      success: boolean;
    },
  ): void {
    if (!this.enabled) return;
    this.safe(() => {
      const record = this.recordByKey.get(publisherKey(eventId));
      if (!record) return;
      record.markDeliveredClaimToken = input.claimToken;
      record.markDeliveredUpdatedCount = input.updatedCount;
      record.markDeliveredSuccess = input.success;
    });
  }

  recordLeaseTransition(input: {
    eventId: string;
    eventSeq: string;
    transition: 'expired' | 'reclaimed' | 'released' | 'retry';
    oldClaimToken?: string;
    newClaimToken?: string;
    oldPublisherInstanceId?: string;
    newPublisherInstanceId?: string;
    attemptNumber: number;
    leaseExpiresAtIso?: string;
  }): void {
    if (!this.enabled) return;
    this.safe(() => {
      const { record } = this.upsert(publisherKey(input.eventId), 'publisher', {
        eventId: input.eventId,
        eventSeq: input.eventSeq,
        eventType: 'diagnostic.lease',
        liveSessionId: '',
        aggregateVersion: 0,
        visibility: 'diagnostic',
      });
      record.leaseTransition = input.transition;
      record.oldPublisherClaimToken = input.oldClaimToken;
      record.newPublisherClaimToken = input.newClaimToken;
      record.oldPublisherInstanceId = input.oldPublisherInstanceId;
      record.newPublisherInstanceId = input.newPublisherInstanceId;
      record.oldClaimOwnerEvidenceGap =
        input.transition === 'reclaimed' &&
        input.oldClaimToken === undefined &&
        input.oldPublisherInstanceId === undefined;
      record.attemptNumber = input.attemptNumber;
      record.leaseExpiresAtIso = input.leaseExpiresAtIso;
    });
  }

  recordCoalescedAggregate(coalescedCount: number): void {
    if (!this.enabled || coalescedCount <= 0) return;
    this.safe(() => {
      this.lifecycleRecords.push({
        component: 'coalescedAggregate',
        instanceId: this.instanceId,
        constructedAtIso: new Date().toISOString(),
        coalescedCount,
      });
    });
  }

  recordTiming(input: RealtimeTimingRecord): void {
    if (!this.enabled) return;
    this.safe(() => {
      const existing = this.timingRecords.get(input.correlationId);
      if (
        existing &&
        input.eventId !== undefined &&
        existing.eventId !== input.eventId
      )
        this.removeTimingIndex(existing.correlationId, existing.eventId);
      this.timingRecords.set(input.correlationId, {
        ...(existing ?? {}),
        ...input,
      });
      if (input.eventId !== undefined) {
        let ids = this.timingByEvent.get(input.eventId);
        if (!ids) {
          ids = new Set<string>();
          this.timingByEvent.set(input.eventId, ids);
        }
        ids.add(input.correlationId);
      }
    });
  }

  updateTimingByEvent(
    eventId: string,
    fields: Partial<RealtimeTimingRecord>,
  ): void {
    if (!this.enabled) return;
    this.safe(() => {
      // O(1) index lookup per event instead of scanning every timing record.
      const correlationIds = this.timingByEvent.get(eventId);
      if (!correlationIds) return;
      for (const correlationId of correlationIds) {
        const timing = this.timingRecords.get(correlationId);
        if (timing)
          this.timingRecords.set(correlationId, { ...timing, ...fields });
      }
    });
  }

  /** Drop one event-index entry (kept in sync with the timing record's event). */
  private removeTimingIndex(
    correlationId: string,
    eventId: string | undefined,
  ): void {
    if (eventId === undefined) return;
    const ids = this.timingByEvent.get(eventId);
    if (!ids) return;
    ids.delete(correlationId);
    if (ids.size === 0) this.timingByEvent.delete(eventId);
  }

  // --- retrieval ----------------------------------------------------------

  stats(): RealtimeTraceStats {
    return {
      schemaVersion: REALTIME_TRACE_SCHEMA_VERSION,
      enabled: this.enabled,
      instanceId: this.instanceId,
      backendInstanceId: this.backendInstanceId,
      processId: this.processId,
      processStartIso: this.processStartIso,
      hostname: this.hostname,
      lifecycle: this.lifecycleRecords.map((record) => ({ ...record })),
      runId: this.runId,
      bufferSize: this.bufferSize,
      recordedCount: this.records.length,
      droppedCount: this.droppedCount,
      dispatchedEventCount: this.dispatchedEventIds.size,
    };
  }

  snapshot(
    runId: string,
    filter: RealtimeTraceFilter = {},
  ): RealtimeTraceSnapshot {
    const records = this.records.filter(
      (record) =>
        record.runId === runId &&
        (filter.eventId === undefined || record.eventId === filter.eventId) &&
        (filter.eventSeq === undefined ||
          record.eventSeq === filter.eventSeq) &&
        (filter.eventType === undefined ||
          record.eventType === filter.eventType) &&
        (filter.liveSessionId === undefined ||
          record.liveSessionId === filter.liveSessionId) &&
        (filter.phase === undefined || record.phase === filter.phase),
    );
    return {
      stats: this.stats(),
      records: records.map(cloneRecord),
      timings: [...this.timingRecords.values()].filter(
        (timing) => timing.runId === runId,
      ),
    };
  }

  // --- internals ----------------------------------------------------------

  private safe(operation: () => void): void {
    try {
      operation();
    } catch {
      // Diagnostics are best-effort and never part of delivery control flow.
    }
  }

  private upsert(
    key: string,
    phase: RealtimeTraceRecord['phase'],
    base: TraceSeed,
  ): { record: RealtimeTraceRecord; created: boolean } {
    const existing = this.recordByKey.get(key);
    if (existing) {
      existing.phase = phase;
      assignDefined(existing, base);
      return { record: existing, created: false };
    }
    const record: RealtimeTraceRecord = {
      schemaVersion: REALTIME_TRACE_SCHEMA_VERSION,
      runId: this.runId,
      instanceId: this.instanceId,
      backendInstanceId: this.backendInstanceId,
      processId: this.processId,
      processStartIso: this.processStartIso,
      hostname: this.hostname,
      phase,
      eventId: base.eventId,
      eventSeq: base.eventSeq,
      eventType: base.eventType,
      liveSessionId: base.liveSessionId,
      targetType: phase === 'room' ? 'room' : 'socket',
      targetId: base.room ?? base.socketId ?? '',
      payloadCorrelation: {
        eventSeq: base.eventSeq,
        aggregateVersion: base.aggregateVersion,
        visibility: base.visibility,
      },
    };
    assignDefined(record, base);
    this.push(record, key);
    return { record, created: true };
  }

  private push(record: RealtimeTraceRecord, key: string): void {
    this.records.push(record);
    this.recordByKey.set(key, record);
    if (this.records.length <= this.bufferSize) return;
    const evicted = this.records.shift();
    if (!evicted) return;
    this.droppedCount += 1;
    for (const [evictedKey, value] of this.recordByKey) {
      if (value === evicted) {
        this.recordByKey.delete(evictedKey);
        break;
      }
    }
  }

  private maybeLog(record: RealtimeTraceRecord): void {
    if (!this.logEnabled) return;
    try {
      console.debug(JSON.stringify({ msg: 'realtime.trace', ...record }));
    } catch {
      // A log failure must not affect delivery.
    }
  }
}

/** Fields lifted from the call site onto a record (never a payload). */
interface TraceSeed {
  eventId: string;
  eventSeq: string;
  eventType: string;
  liveSessionId: string;
  sessionQuestionId?: string;
  room?: string;
  socketId?: string;
  connectedState?: boolean;
  clientKind?: 'teacher' | 'participant';
  participantId?: string;
  aggregateVersion: number;
  visibility: string;
}

function assignDefined(target: RealtimeTraceRecord, source: TraceSeed): void {
  if (source.sessionQuestionId !== undefined)
    target.sessionQuestionId = source.sessionQuestionId;
  if (source.socketId !== undefined) target.socketId = source.socketId;
  if (source.connectedState !== undefined)
    target.connectedState = source.connectedState;
  if (source.clientKind !== undefined) target.clientKind = source.clientKind;
  if (source.participantId !== undefined)
    target.participantId = source.participantId;
  target.payloadCorrelation = {
    eventSeq: source.eventSeq,
    aggregateVersion: source.aggregateVersion,
    visibility: source.visibility,
  };
}

function publisherKey(eventId: string): string {
  return `${eventId}${KEY_SEP}publisher`;
}
function roomKey(eventId: string, room: string): string {
  return `${eventId}${KEY_SEP}room${KEY_SEP}${room}`;
}
function socketKey(
  eventId: string,
  eventName: string,
  socketId: string,
): string {
  // The event name is part of the key: one durable event can reach the same
  // teacher socket twice under different emit names (e.g. RESULT_UPDATED via
  // the session room plus counts.updated via the teacher room). Without it the
  // second upsert overwrites the first and the trace loses one emit.
  return `${eventId}${KEY_SEP}${eventName}${KEY_SEP}socket${KEY_SEP}${socketId}`;
}

function cloneRecord(record: RealtimeTraceRecord): RealtimeTraceRecord {
  return {
    ...record,
    payloadCorrelation: { ...record.payloadCorrelation },
    ...(record.roomMembersAtEmit
      ? { roomMembersAtEmit: [...record.roomMembersAtEmit] }
      : {}),
    ...(record.dispatchThrew
      ? { dispatchThrew: { ...record.dispatchThrew } }
      : {}),
    ...(record.coalescingComparisons
      ? { coalescingComparisons: { ...record.coalescingComparisons } }
      : {}),
  };
}

function clampBufferSize(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_BUFFER_SIZE;
  return Math.min(Math.floor(parsed), MAX_BUFFER_SIZE);
}
