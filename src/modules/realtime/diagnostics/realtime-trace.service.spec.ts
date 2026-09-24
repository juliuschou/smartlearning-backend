import { RealtimeTraceService } from './realtime-trace.service';

/**
 * W3 diagnostic trace sink. These tests pin the two properties that make the
 * trace trustworthy: (1) disabled-by-default with zero behavioural effect, and
 * (2) run-scoped retrieval that can never leak another run's records.
 */
describe('RealtimeTraceService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function enable(runId = 'run-a', bufferSize?: number): RealtimeTraceService {
    process.env.REALTIME_TRACE_ENABLED = '1';
    process.env.REALTIME_TRACE_RUN_ID = runId;
    if (bufferSize !== undefined) {
      process.env.REALTIME_TRACE_BUFFER_SIZE = String(bufferSize);
    }
    return new RealtimeTraceService();
  }

  function seedClaim(
    service: RealtimeTraceService,
    eventId: string,
    eventSeq: string,
  ): void {
    service.recordClaim({
      eventId,
      eventSeq,
      eventType: 'result.updated',
      liveSessionId: 'session-1',
      claimedAtIso: '2026-09-20T00:00:00.000Z',
      attemptNumber: 1,
      aggregateVersion: 3,
      visibility: 'participant',
    });
  }

  describe('disabled by default', () => {
    it('is disabled when the flag is absent', () => {
      delete process.env.REALTIME_TRACE_ENABLED;
      const service = new RealtimeTraceService();
      expect(service.enabled).toBe(false);
      expect(service.runId).toBe('');
    });

    it('treats any value other than the exact string "1" as disabled', () => {
      for (const value of ['0', 'false', 'true', 'yes', 'TRUE', '']) {
        process.env.REALTIME_TRACE_ENABLED = value;
        expect(new RealtimeTraceService().enabled).toBe(false);
      }
    });

    it('records nothing while disabled', () => {
      delete process.env.REALTIME_TRACE_ENABLED;
      const service = new RealtimeTraceService();
      seedClaim(service, 'e1', '1');
      service.recordDispatchStart('e1', 10);
      service.recordEmit({
        eventId: 'e1',
        eventSeq: '1',
        eventType: 'result.updated',
        liveSessionId: 'session-1',
        socketId: 's1',
        aggregateVersion: 1,
        visibility: 'participant',
        emitMonoMs: 20,
      });
      const snapshot = service.snapshot(service.instanceId);
      expect(snapshot.records).toHaveLength(0);
      expect(service.stats().recordedCount).toBe(0);
      expect(service.snapshot(service.instanceId).timings).toHaveLength(0);
    });

    it('does not overwrite the request boundary when timing fields merge', () => {
      const service = enable('run-timing');
      service.recordTiming({
        schemaVersion: 1,
        runId: 'run-timing',
        correlationId: 'corr-1',
        liveSessionId: 'session-1',
        sessionQuestionId: 'question-1',
        participantId: 'participant-1',
        requestReceivedAt: '2026-09-20T00:00:00.000Z',
      });
      service.recordTiming({
        schemaVersion: 1,
        runId: 'run-timing',
        correlationId: 'corr-1',
        liveSessionId: 'session-1',
        sessionQuestionId: 'question-1',
        participantId: 'participant-1',
        transactionResolvedAt: '2026-09-20T00:00:00.010Z',
      });
      const [timing] = service.snapshot('run-timing').timings;
      expect(timing?.requestReceivedAt).toBe('2026-09-20T00:00:00.000Z');
      expect(timing?.transactionResolvedAt).toBe('2026-09-20T00:00:00.010Z');
    });
  });

  describe('coalescing', () => {
    it('records suppression separately from dispatched delivery', () => {
      const service = enable('run-coalesce');
      service.recordCoalesced({
        eventId: 'older',
        eventSeq: '24',
        eventType: 'result.updated',
        liveSessionId: 'session-1',
        sessionQuestionId: 'question-1',
        aggregateVersion: 3,
        visibility: 'participant',
        coalescedAtIso: '2026-09-20T00:00:01.000Z',
        supersedingEventId: 'newer',
        supersedingEventSeq: '25',
        supersedingAggregateVersion: 4,
        comparisons: {
          sameLiveSessionId: true,
          sameSessionQuestionId: true,
          sameVisibility: true,
          newerEventSeq: true,
          nonDecreasingAggregateVersion: true,
        },
      });
      const [record] = service.snapshot('run-coalesce').records;
      expect(record?.transitionTo).toBe('coalesced');
      expect(record?.gatewayDispatchCalled).toBeUndefined();
      expect(record?.coalescedByEventId).toBe('newer');
      expect(record?.coalescedByEventSeq).toBe('25');
      expect(record?.coalescingComparisons?.newerEventSeq).toBe(true);
      expect(service.stats().dispatchedEventCount).toBe(0);
    });
  });

  describe('run scoping', () => {
    it('falls back to the instance id when no run id is provided', () => {
      process.env.REALTIME_TRACE_ENABLED = '1';
      delete process.env.REALTIME_TRACE_RUN_ID;
      const service = new RealtimeTraceService();
      expect(service.runId).toBe(service.instanceId);
    });

    it('returns only the requested run and never another run', () => {
      const service = enable('run-a');
      seedClaim(service, 'e1', '1');
      const runA = service.snapshot('run-a');
      const runB = service.snapshot('run-b');

      expect(runA.stats.enabled).toBe(true);
      expect(runA.stats.runId).toBe('run-a');
      expect(runA.records.map((r) => r.eventId)).toEqual(['e1']);

      // A valid mismatched runId is an isolation probe, not a rejected request:
      // the active instance stats remain visible, but no active-run records do.
      expect(runB.stats.enabled).toBe(true);
      expect(runB.stats.runId).toBe('run-a');
      expect(runB.records).toEqual([]);
    });

    it('stamps the run id and instance id on every record', () => {
      const service = enable('run-a');
      seedClaim(service, 'e1', '1');
      const [record] = service.snapshot('run-a').records;
      expect(record?.runId).toBe('run-a');
      expect(record?.instanceId).toBe(service.instanceId);
      expect(record?.schemaVersion).toBe(1);
    });
  });

  describe('emit and delivery observation', () => {
    it('records a per-socket emit with correlation fields', () => {
      const service = enable();
      seedClaim(service, 'e1', '7');
      service.recordEmit({
        eventId: 'e1',
        eventSeq: '7',
        eventType: 'result.updated',
        liveSessionId: 'session-1',
        sessionQuestionId: 'q1',
        socketId: 's1',
        connectedState: true,
        clientKind: 'participant',
        participantId: 'p1',
        aggregateVersion: 3,
        visibility: 'participant_after_submit',
        emitMonoMs: 42,
      });
      const record = service
        .snapshot('run-a', { eventId: 'e1' })
        .records.find((r) => r.socketId === 's1');
      expect(record?.socketId).toBe('s1');
      expect(record?.emitMonoMs).toBe(42);
      expect(record?.connectedState).toBe(true);
      expect(record?.payloadCorrelation).toEqual({
        eventSeq: '7',
        aggregateVersion: 3,
        visibility: 'participant_after_submit',
      });
    });

    it('advances one socket record in place through emit, return and delivery', () => {
      const service = enable();
      seedClaim(service, 'e1', '1');
      service.recordEmit({
        eventId: 'e1',
        eventSeq: '1',
        eventType: 'result.updated',
        liveSessionId: 'session-1',
        socketId: 's1',
        aggregateVersion: 1,
        visibility: 'participant',
        emitMonoMs: 5,
      });
      service.recordEmitReturned('e1', 'result.updated', 's1', true);
      service.recordDelivery({
        eventId: 'e1',
        eventName: 'result.updated',
        socketId: 's1',
        outcome: 'fulfilled',
        queuedBehind: 2,
      });
      const records = service.snapshot('run-a', { eventId: 'e1' }).records;
      const socketRecords = records.filter((r) => r.socketId === 's1');
      expect(socketRecords).toHaveLength(1);
      expect(socketRecords[0]?.emitReturned).toBe(true);
      expect(socketRecords[0]?.deliveryOutcome).toBe('fulfilled');
      expect(socketRecords[0]?.queuedBehind).toBe(2);
    });

    it('records a rejected delivery with a non-sensitive error classifier', () => {
      const service = enable();
      seedClaim(service, 'e1', '1');
      service.recordEmit({
        eventId: 'e1',
        eventSeq: '1',
        eventType: 'result.updated',
        liveSessionId: 'session-1',
        socketId: 's1',
        aggregateVersion: 1,
        visibility: 'participant',
        emitMonoMs: 5,
      });
      service.recordDelivery({
        eventId: 'e1',
        eventName: 'result.updated',
        socketId: 's1',
        outcome: 'rejected',
        errorType: 'Error',
        queuedBehind: 0,
      });
      const [record] = service
        .snapshot('run-a', { eventId: 'e1' })
        .records.filter((r) => r.socketId === 's1');
      expect(record?.deliveryOutcome).toBe('rejected');
      expect(record?.deliveryErrorType).toBe('Error');
    });
  });

  describe('room and guard evidence', () => {
    it('records both room membership and the narrowed recipient count', () => {
      const service = enable();
      seedClaim(service, 'e1', '1');
      service.recordRoom({
        eventId: 'e1',
        eventSeq: '1',
        eventType: 'result.updated',
        liveSessionId: 'session-1',
        room: 'session:session-1',
        memberSocketIds: ['s1', 's2', 's3'],
        recipientCount: 1,
        adapterRoomSize: 3,
        aggregateVersion: 1,
        visibility: 'participant_after_submit',
      });
      const room = service
        .snapshot('run-a', { eventId: 'e1' })
        .records.find((r) => r.phase === 'room');
      expect(room?.roomMemberCount).toBe(3);
      expect(room?.recipientCount).toBe(1);
      expect(room?.adapterRoomSize).toBe(3);
    });

    it('reports an unavailable adapter as undefined, never zero', () => {
      const service = enable();
      seedClaim(service, 'e1', '1');
      service.recordRoom({
        eventId: 'e1',
        eventSeq: '1',
        eventType: 'result.updated',
        liveSessionId: 'session-1',
        room: 'session:session-1',
        memberSocketIds: [],
        recipientCount: 0,
        aggregateVersion: 1,
        visibility: 'teacher',
      });
      const room = service
        .snapshot('run-a', { eventId: 'e1' })
        .records.find((r) => r.phase === 'room');
      expect(room?.adapterRoomSize).toBeUndefined();
    });

    it('records a named guard skip for one socket', () => {
      const service = enable();
      seedClaim(service, 'e1', '1');
      service.recordGuard({
        eventId: 'e1',
        eventSeq: '1',
        eventType: 'result.updated',
        liveSessionId: 'session-1',
        guard: 'reveal_gate',
        socketId: 's1',
        clientKind: 'participant',
        participantId: 'p1',
        aggregateVersion: 1,
        visibility: 'participant_after_submit',
      });
      const guard = service
        .snapshot('run-a', { eventId: 'e1' })
        .records.find((r) => r.phase === 'guard');
      expect(guard?.guard).toBe('reveal_gate');
      expect(guard?.targetType).toBe('socket');
    });
  });

  describe('publisher leg', () => {
    it('records claim, dispatch entry and dispatch return on one record', () => {
      const service = enable();
      seedClaim(service, 'e1', '1');
      service.recordDispatchStart('e1', 100);
      service.recordDispatchReturned('e1', 150);
      service.recordTransition('e1', 'delivered', '2026-09-20T00:00:01.000Z');
      const [record] = service.snapshot('run-a', { eventId: 'e1' }).records;
      expect(record?.gatewayDispatchCalled).toBe(true);
      expect(record?.dispatchStartMonoMs).toBe(100);
      expect(record?.gatewayDispatchReturnedMonoMs).toBe(150);
      expect(record?.transitionTo).toBe('delivered');
    });

    it('records a dispatch throw without disturbing other fields', () => {
      const service = enable();
      seedClaim(service, 'e1', '1');
      service.recordDispatchStart('e1', 100);
      service.recordDispatchThrew('e1', new TypeError('bad'));
      const [record] = service.snapshot('run-a', { eventId: 'e1' }).records;
      expect(record?.dispatchThrew).toEqual({ errorType: 'TypeError' });
    });

    it('creates a claim-only record at claim time before any dispatch', () => {
      const service = enable();
      service.recordClaimed({
        eventId: 'e9',
        eventSeq: '24',
        eventType: 'result.updated',
        liveSessionId: 'session-1',
        claimedAtIso: '2026-09-22T00:00:00.000Z',
        attemptNumber: 1,
        publisherInstanceId: 'pub-1',
        publisherClaimToken: 'claim-1',
        aggregateVersion: 1,
        visibility: 'participant',
      });
      // A claimed record must exist even though dispatch was never entered —
      // this is exactly the attribution gap the instrumentation closes.
      const [record] = service.snapshot('run-a', { eventId: 'e9' }).records;
      expect(record?.claimOnly).toBe(true);
      expect(record?.gatewayDispatchCalled).toBeUndefined();
      expect(record?.publisherInstanceId).toBe('pub-1');
      expect(record?.publisherClaimToken).toBe('claim-1');
    });

    it('merges later dispatch evidence onto the claim-only record', () => {
      const service = enable();
      service.recordClaimed({
        eventId: 'e9',
        eventSeq: '24',
        eventType: 'result.updated',
        liveSessionId: 'session-1',
        claimedAtIso: '2026-09-22T00:00:00.000Z',
        attemptNumber: 1,
        publisherInstanceId: 'pub-1',
        publisherClaimToken: 'claim-1',
        aggregateVersion: 1,
        visibility: 'participant',
      });
      service.recordClaim({
        eventId: 'e9',
        eventSeq: '24',
        eventType: 'result.updated',
        liveSessionId: 'session-1',
        claimedAtIso: '2026-09-22T00:00:00.000Z',
        attemptNumber: 1,
        publisherInstanceId: 'pub-1',
        publisherClaimToken: 'claim-1',
        aggregateVersion: 1,
        visibility: 'participant',
      });
      service.recordDispatchStart('e9', 50);
      const [record] = service.snapshot('run-a', { eventId: 'e9' }).records;
      expect(record?.gatewayDispatchCalled).toBe(true);
      expect(record?.claimOnly).toBe(true);
    });

    it('records a publisher-stop lifecycle record on shutdown', () => {
      const service = enable();
      const lifecycleBefore = service.stats().lifecycle.length;
      service.recordLifecycle('publisher-stop', 'pub-1');
      const lifecycle = service.stats().lifecycle;
      expect(lifecycle.length).toBe(lifecycleBefore + 1);
      expect(lifecycle.at(-1)?.component).toBe('publisher-stop');
      expect(lifecycle.at(-1)?.instanceId).toBe('pub-1');
    });
  });

  describe('completeness reporting', () => {
    it('reports dropped count once the bounded buffer wraps', () => {
      const service = enable('run-a', 2);
      seedClaim(service, 'e1', '1');
      seedClaim(service, 'e2', '2');
      seedClaim(service, 'e3', '3');
      const stats = service.stats();
      expect(stats.recordedCount).toBe(2);
      expect(stats.droppedCount).toBe(1);
      expect(stats.bufferSize).toBe(2);
      expect(stats.dispatchedEventCount).toBe(3);
      expect(stats.enabled).toBe(true);
    });

    it('clamps an invalid buffer size to the default', () => {
      const service = enable('run-a');
      process.env.REALTIME_TRACE_BUFFER_SIZE = 'nonsense';
      const invalid = new RealtimeTraceService();
      expect(invalid.stats().bufferSize).toBe(5000);
      expect(service.stats().bufferSize).toBe(5000);
    });
  });

  describe('redaction posture', () => {
    it('never carries a payload, token or account identity field', () => {
      const service = enable();
      seedClaim(service, 'e1', '1');
      service.recordEmit({
        eventId: 'e1',
        eventSeq: '1',
        eventType: 'result.updated',
        liveSessionId: 'session-1',
        socketId: 's1',
        clientKind: 'participant',
        participantId: 'p1',
        aggregateVersion: 1,
        visibility: 'participant',
        emitMonoMs: 9,
      });
      const record = service.snapshot('run-a').records[0] as unknown as Record<
        string,
        unknown
      >;
      const keys = Object.keys(record);
      for (const forbidden of [
        'data',
        'results',
        'answers',
        'selectedOptionRefs',
        'textAnswer',
        'participantToken',
        'sessionCode',
        'token',
        'cookie',
        'password',
        'accountId',
        'displayName',
      ]) {
        expect(keys).not.toContain(forbidden);
      }
      expect(JSON.stringify(record)).not.toMatch(/token|cookie|password/i);
    });

    it('returns defensive copies so a caller cannot mutate recorded state', () => {
      const service = enable();
      seedClaim(service, 'e1', '1');
      service.recordRoom({
        eventId: 'e1',
        eventSeq: '1',
        eventType: 'result.updated',
        liveSessionId: 'session-1',
        room: 'session:session-1',
        memberSocketIds: ['s1'],
        recipientCount: 1,
        aggregateVersion: 1,
        visibility: 'teacher',
      });
      const first = service.snapshot('run-a').records;
      const roomFirst = first.find((r) => r.phase === 'room');
      roomFirst?.roomMembersAtEmit?.push('injected');
      const second = service.snapshot('run-a').records;
      expect(second.find((r) => r.phase === 'room')?.roomMembersAtEmit).toEqual(
        ['s1'],
      );
    });
  });

  // --- F2: socket trace key collision ---------------------------------------

  describe('socket key collision hardening', () => {
    it('keeps two distinct emits to the same event + socket with different event names', () => {
      const service = enable();
      seedClaim(service, 'e1', '1');
      service.recordEmit({
        eventId: 'e1',
        eventSeq: '1',
        eventType: 'result.updated',
        liveSessionId: 'session-1',
        socketId: 's1',
        aggregateVersion: 1,
        visibility: 'teacher',
        emitMonoMs: 1,
      });
      service.recordEmit({
        eventId: 'e1',
        eventSeq: '1',
        eventType: 'counts.updated',
        liveSessionId: 'session-1',
        socketId: 's1',
        aggregateVersion: 1,
        visibility: 'teacher',
        emitMonoMs: 2,
      });
      const records = service.snapshot('run-a', { eventId: 'e1' }).records;
      const socketRecords = records.filter(
        (r) => r.phase === 'emit' && r.socketId === 's1',
      );
      expect(socketRecords).toHaveLength(2);
      const eventTypes = socketRecords.map((r) => r.eventType).sort();
      expect(eventTypes).toEqual(['counts.updated', 'result.updated']);
    });

    it('routes emit-returned/threw and delivery updates to the named emit record only', () => {
      const service = enable();
      seedClaim(service, 'e1', '1');
      service.recordEmit({
        eventId: 'e1',
        eventSeq: '1',
        eventType: 'result.updated',
        liveSessionId: 'session-1',
        socketId: 's1',
        aggregateVersion: 1,
        visibility: 'teacher',
        emitMonoMs: 1,
      });
      service.recordEmit({
        eventId: 'e1',
        eventSeq: '1',
        eventType: 'counts.updated',
        liveSessionId: 'session-1',
        socketId: 's1',
        aggregateVersion: 1,
        visibility: 'teacher',
        emitMonoMs: 2,
      });
      service.recordEmitReturned('e1', 'result.updated', 's1', false);
      service.recordDelivery({
        eventId: 'e1',
        eventName: 'counts.updated',
        socketId: 's1',
        outcome: 'fulfilled',
        queuedBehind: 0,
      });
      const records = service.snapshot('run-a', { eventId: 'e1' }).records;
      const resultRecord = records.find(
        (r) => r.phase === 'emit' && r.eventType === 'result.updated',
      );
      const countsRecord = records.find(
        (r) => r.phase === 'emit' && r.eventType === 'counts.updated',
      );
      expect(resultRecord?.emitReturned).toBe(false);
      expect(resultRecord?.deliveryOutcome).toBeUndefined();
      expect(countsRecord?.deliveryOutcome).toBe('fulfilled');
      expect(countsRecord?.emitReturned).toBeUndefined();
    });
  });

  // --- F5: timing index -------------------------------------------------------

  describe('timing record index (O(1) update by event)', () => {
    it('creates one record, updates it by event repeatedly without duplication', () => {
      const service = enable();
      service.recordTiming({
        schemaVersion: 1,
        runId: 'run-a',
        correlationId: 'corr-1',
        liveSessionId: 'session-1',
        sessionQuestionId: 'sq-1',
        participantId: 'p1',
        eventId: 'e1',
        requestReceivedAt: '2026-09-24T00:00:00.000Z',
      });
      for (let i = 0; i < 5; i++) {
        service.updateTimingByEvent('e1', { dispatchStartAt: `t${i}` });
      }
      const timings = service.snapshot('run-a').timings;
      expect(timings).toHaveLength(1);
      expect(timings[0]?.dispatchStartAt).toBe('t4');
    });

    it('updates only the records of the requested event', () => {
      const service = enable();
      service.recordTiming({
        schemaVersion: 1,
        runId: 'run-a',
        correlationId: 'corr-1',
        liveSessionId: 'session-1',
        sessionQuestionId: 'sq-1',
        participantId: 'p1',
        eventId: 'e1',
      });
      service.recordTiming({
        schemaVersion: 1,
        runId: 'run-a',
        correlationId: 'corr-2',
        liveSessionId: 'session-1',
        sessionQuestionId: 'sq-1',
        participantId: 'p1',
        eventId: 'e2',
      });
      service.updateTimingByEvent('e1', { claimedAt: 't1' });
      const timings = service.snapshot('run-a').timings;
      const e1 = timings.find((t) => t.correlationId === 'corr-1');
      const e2 = timings.find((t) => t.correlationId === 'corr-2');
      expect(e1?.claimedAt).toBe('t1');
      expect(e2?.claimedAt).toBeUndefined();
    });

    it('keeps the index consistent when a timing record is re-keyed to another event', () => {
      const service = enable();
      service.recordTiming({
        schemaVersion: 1,
        runId: 'run-a',
        correlationId: 'corr-1',
        liveSessionId: 'session-1',
        sessionQuestionId: 'sq-1',
        participantId: 'p1',
        eventId: 'e1',
      });
      // Re-record the same correlation under a different event: the old index
      // entry must be dropped so updateTimingByEvent('e1') no longer touches it.
      service.recordTiming({
        schemaVersion: 1,
        runId: 'run-a',
        correlationId: 'corr-1',
        liveSessionId: 'session-1',
        sessionQuestionId: 'sq-1',
        participantId: 'p1',
        eventId: 'e2',
      });
      service.updateTimingByEvent('e1', { claimedAt: 't1' });
      const timings = service.snapshot('run-a').timings;
      expect(timings).toHaveLength(1);
      expect(timings[0]?.eventId).toBe('e2');
      expect(timings[0]?.claimedAt).toBeUndefined();
    });
  });

  describe('coalesced aggregate lifecycle record', () => {
    it('records an aggregate coalescedCount when enabled and nonzero', () => {
      const service = enable();
      service.recordCoalescedAggregate(7);
      const lifecycle = service.stats().lifecycle;
      expect(lifecycle.at(-1)?.component).toBe('coalescedAggregate');
      expect(lifecycle.at(-1)?.coalescedCount).toBe(7);
    });

    it('records nothing for zero rows or while disabled', () => {
      delete process.env.REALTIME_TRACE_ENABLED;
      const disabled = new RealtimeTraceService();
      disabled.recordCoalescedAggregate(5);
      expect(disabled.stats().lifecycle).toHaveLength(0);
      const enabled = enable();
      enabled.recordCoalescedAggregate(0);
      expect(enabled.stats().lifecycle.at(-1)?.component).toBe('traceService');
    });
  });
});
