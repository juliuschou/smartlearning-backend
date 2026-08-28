import {
  ACCOUNT_BOUND_REALTIME_LOCK_ORDER,
  REALTIME_EVENT_NAMES,
  REALTIME_LOCK_ORDER,
  RealtimeAggregateTrigger,
  RealtimeDeliveryState,
  RealtimeEvent,
  RealtimeRedisMode,
  RealtimeSyncReason,
  RealtimeVisibility,
  assessReplay,
  coalescingKey,
  compareWatermarks,
  hasLockOrder,
  isAggregateVersionedEvent,
  isEligibleForCoalescing,
  nextAggregateVersion,
  nextEventSeq,
  parseLastEventSeq,
  parseRealtimeRedisMode,
  parseSafeRealtimeOutboxInput,
  resolveRealtimeRedisPolicy,
  shouldApplyWatermark,
  toEventSeqWire,
  toWatermark,
} from './live-session-realtime-contract';

const LIVE_SESSION_ID = '0190c6b8-0000-7000-8000-000000000001';
const SESSION_QUESTION_ID = '0190c6b8-0000-7000-8000-000000000002';
const SECOND_QUESTION_ID = '0190c6b8-0000-7000-8000-000000000003';

function replayRow(
  eventSeq: number,
  overrides: Partial<{
    event: RealtimeEventNameForTest;
    visibility: RealtimeVisibilityForTest;
    deliveryState: RealtimeDeliveryStateForTest;
    visible: boolean;
    coalesced: boolean;
    expired: boolean;
  }> = {},
) {
  return {
    eventSeq: BigInt(eventSeq),
    event: RealtimeEvent.RESULT_UPDATED,
    visibility: RealtimeVisibility.TEACHER,
    deliveryState: RealtimeDeliveryState.DELIVERED,
    visible: true,
    ...overrides,
  };
}

type RealtimeEventNameForTest =
  (typeof RealtimeEvent)[keyof typeof RealtimeEvent];
type RealtimeVisibilityForTest =
  (typeof RealtimeVisibility)[keyof typeof RealtimeVisibility];
type RealtimeDeliveryStateForTest =
  (typeof RealtimeDeliveryState)[keyof typeof RealtimeDeliveryState];

describe('durable realtime contract', () => {
  it('freezes the canonical event catalog and visibility values', () => {
    expect(REALTIME_EVENT_NAMES).toEqual([
      'session.snapshot',
      'session.state_changed',
      'question.opened',
      'question.closed',
      'result.updated',
      'session.closed',
      'sync.required',
    ]);
    expect(Object.values(RealtimeVisibility)).toEqual([
      'session',
      'teacher',
      'participant',
      'participant_after_submit',
    ]);
  });

  it('parses only canonical non-negative decimal cursors', () => {
    expect(parseLastEventSeq(undefined)).toEqual({ kind: 'absent' });
    expect(parseLastEventSeq(null)).toEqual({ kind: 'absent' });
    expect(parseLastEventSeq('0')).toEqual({
      kind: 'valid',
      value: 0n,
      wire: '0',
    });
    expect(parseLastEventSeq('9007199254740993')).toEqual({
      kind: 'valid',
      value: 9007199254740993n,
      wire: '9007199254740993',
    });
    expect(parseLastEventSeq('9223372036854775807')).toEqual({
      kind: 'valid',
      value: 9223372036854775807n,
      wire: '9223372036854775807',
    });
    expect(parseLastEventSeq('9223372036854775808')).toEqual({
      kind: 'invalid',
      reason: 'malformed',
    });
    expect(parseLastEventSeq('01')).toEqual({
      kind: 'invalid',
      reason: 'malformed',
    });
    expect(parseLastEventSeq('-1')).toEqual({
      kind: 'invalid',
      reason: 'negative',
    });
    expect(parseLastEventSeq(1)).toEqual({
      kind: 'invalid',
      reason: 'malformed',
    });
  });

  it('keeps PostgreSQL BIGINT sequences lossless on the wire', () => {
    expect(toEventSeqWire(9007199254740993n)).toBe('9007199254740993');
    expect(toEventSeqWire(12)).toBe('12');
    expect(nextEventSeq('9007199254740993')).toBe(9007199254740994n);
    expect(() => toEventSeqWire(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      RangeError,
    );
    expect(() => toEventSeqWire(-1n)).toThrow(RangeError);
    expect(() => toEventSeqWire('1e3')).toThrow(TypeError);
  });

  it('increments aggregate versions only for accepted submissions and close', () => {
    expect(
      nextAggregateVersion(0, RealtimeAggregateTrigger.SUBMISSION_ACCEPTED),
    ).toBe(1);
    expect(
      nextAggregateVersion(1, RealtimeAggregateTrigger.QUESTION_CLOSED),
    ).toBe(2);
    expect(nextAggregateVersion(2, RealtimeAggregateTrigger.OTHER)).toBe(2);
    expect(isAggregateVersionedEvent(RealtimeEvent.RESULT_UPDATED)).toBe(true);
    expect(isAggregateVersionedEvent(RealtimeEvent.QUESTION_CLOSED)).toBe(true);
    expect(isAggregateVersionedEvent(RealtimeEvent.SESSION_CLOSED)).toBe(false);
    expect(() =>
      nextAggregateVersion(-1, RealtimeAggregateTrigger.OTHER),
    ).toThrow(RangeError);
  });

  it('accepts only safe immutable outbox projection inputs', () => {
    expect(
      parseSafeRealtimeOutboxInput({
        reason: 'participant_joined',
        status: 'active',
        sessionQuestionId: SESSION_QUESTION_ID.toUpperCase(),
        aggregateVersion: 3,
        visibility: RealtimeVisibility.TEACHER,
      }),
    ).toEqual({
      reason: 'participant_joined',
      status: 'active',
      sessionQuestionId: SESSION_QUESTION_ID,
      aggregateVersion: 3,
      visibility: RealtimeVisibility.TEACHER,
    });
    expect(() =>
      parseSafeRealtimeOutboxInput({ participantId: LIVE_SESSION_ID }),
    ).toThrow('not safe');
    expect(() =>
      parseSafeRealtimeOutboxInput({ answer: 'secret answer' }),
    ).toThrow('not safe');
    expect(() => parseSafeRealtimeOutboxInput({ status: 'unknown' })).toThrow(
      'status is invalid',
    );
  });

  it('normalizes and compares watermarks without accepting stale state', () => {
    const current = toWatermark(4n, {
      [SESSION_QUESTION_ID.toUpperCase()]: 2,
    });
    const newer = toWatermark(5n, {
      [SESSION_QUESTION_ID]: 2,
      [SECOND_QUESTION_ID]: 1,
    });
    const older = toWatermark(3n, { [SESSION_QUESTION_ID]: 3 });
    const same = toWatermark(4n, { [SESSION_QUESTION_ID]: 2 });

    expect(current).toEqual({
      eventSeq: '4',
      aggregateVersions: { [SESSION_QUESTION_ID]: 2 },
    });
    expect(compareWatermarks(current, newer)).toBe('newer');
    expect(compareWatermarks(current, older)).toBe('older');
    expect(compareWatermarks(current, same)).toBe('equal');
    expect(compareWatermarks(current, toWatermark(4n, {}))).toBe('equal');
    expect(shouldApplyWatermark(null, current)).toBe(true);
    expect(shouldApplyWatermark(current, newer)).toBe(true);
    expect(shouldApplyWatermark(current, older)).toBe(false);
    expect(() => toWatermark(1n, { notAUuid: 1 })).toThrow('must be a UUID');
  });

  it('uses hidden rows for continuity without exposing their events', () => {
    const decision = assessReplay({
      cursor: 0n,
      currentEventSeq: 3n,
      oldestRetainedEventSeq: 1n,
      rows: [
        replayRow(1, {
          event: RealtimeEvent.SESSION_STATE_CHANGED,
          visibility: RealtimeVisibility.SESSION,
          visible: false,
        }),
        replayRow(2),
        replayRow(3, {
          event: RealtimeEvent.SESSION_CLOSED,
          visibility: RealtimeVisibility.SESSION,
        }),
      ],
    });

    expect(decision).toMatchObject({ kind: 'replay', terminal: true });
    expect(decision.kind === 'replay' ? decision.events : []).toHaveLength(2);
    expect(
      decision.kind === 'replay'
        ? decision.events.map((row) => row.eventSeq)
        : [],
    ).toEqual([2n, 3n]);
  });

  it('uses a fresh snapshot when no cursor was supplied', () => {
    expect(
      assessReplay({
        cursor: null,
        currentEventSeq: 4n,
        oldestRetainedEventSeq: 1n,
        rows: [],
      }),
    ).toEqual({ kind: 'snapshot', reason: 'initial' });
  });

  it('replays an equal cursor as an empty ordered window', () => {
    expect(
      assessReplay({
        cursor: 4n,
        currentEventSeq: 4n,
        oldestRetainedEventSeq: 1n,
        rows: [],
      }),
    ).toEqual({ kind: 'replay', events: [], terminal: false });
  });

  it.each([
    ['stale', RealtimeSyncReason.STALE],
    ['expired', RealtimeSyncReason.EXPIRED],
    ['permission_invalid', RealtimeSyncReason.PERMISSION_INVALID],
  ] as const)(
    'maps a rejected cursor state to sync.required (%s)',
    (state, reason) => {
      expect(
        assessReplay({
          cursor: 1n,
          currentEventSeq: 4n,
          oldestRetainedEventSeq: 1n,
          rows: [],
          cursorState: state,
        }),
      ).toEqual({ kind: 'sync_required', reason });
    },
  );

  it('recovers from over-current, expired, and missing sequence evidence', () => {
    expect(
      assessReplay({
        cursor: 5n,
        currentEventSeq: 4n,
        oldestRetainedEventSeq: 1n,
        rows: [],
      }),
    ).toEqual({
      kind: 'sync_required',
      reason: RealtimeSyncReason.OVER_CURRENT,
    });
    expect(
      assessReplay({
        cursor: 1n,
        currentEventSeq: 5n,
        oldestRetainedEventSeq: 4n,
        rows: [],
      }),
    ).toEqual({ kind: 'sync_required', reason: RealtimeSyncReason.EXPIRED });
    expect(
      assessReplay({
        cursor: 1n,
        currentEventSeq: 2n,
        oldestRetainedEventSeq: null,
        rows: [],
      }),
    ).toEqual({ kind: 'sync_required', reason: RealtimeSyncReason.GAP });
  });

  it('detects gaps, stale rows, and incomplete replay windows', () => {
    expect(
      assessReplay({
        cursor: 0n,
        currentEventSeq: 3n,
        oldestRetainedEventSeq: 1n,
        rows: [replayRow(1), replayRow(3)],
      }),
    ).toEqual({ kind: 'sync_required', reason: RealtimeSyncReason.GAP });
    expect(
      assessReplay({
        cursor: 1n,
        currentEventSeq: 3n,
        oldestRetainedEventSeq: 1n,
        rows: [replayRow(1)],
      }),
    ).toEqual({ kind: 'sync_required', reason: RealtimeSyncReason.STALE });
    expect(
      assessReplay({
        cursor: 0n,
        currentEventSeq: 3n,
        oldestRetainedEventSeq: 1n,
        rows: [replayRow(1), replayRow(2)],
      }),
    ).toEqual({ kind: 'sync_required', reason: RealtimeSyncReason.GAP });
  });

  it('forces recovery for visible expired, dead, or coalesced rows', () => {
    for (const overrides of [
      { expired: true },
      { deliveryState: RealtimeDeliveryState.DEAD },
      { coalesced: true },
    ]) {
      const decision = assessReplay({
        cursor: 0n,
        currentEventSeq: 1n,
        oldestRetainedEventSeq: 1n,
        rows: [replayRow(1, overrides)],
      });
      expect(decision).toEqual({
        kind: 'sync_required',
        reason: overrides.expired
          ? RealtimeSyncReason.EXPIRED
          : overrides.coalesced
            ? RealtimeSyncReason.COALESCED
            : RealtimeSyncReason.DEAD,
      });
    }
  });

  it('coalesces only pending/retry result display notifications', () => {
    const base = {
      event: RealtimeEvent.RESULT_UPDATED,
      liveSessionId: LIVE_SESSION_ID,
      sessionQuestionId: SESSION_QUESTION_ID,
      visibility: RealtimeVisibility.TEACHER,
    };
    expect(
      isEligibleForCoalescing({
        ...base,
        deliveryState: RealtimeDeliveryState.PENDING,
      }),
    ).toBe(true);
    expect(
      isEligibleForCoalescing({
        ...base,
        deliveryState: RealtimeDeliveryState.RETRY,
      }),
    ).toBe(true);
    expect(
      isEligibleForCoalescing({
        ...base,
        deliveryState: RealtimeDeliveryState.DELIVERED,
      }),
    ).toBe(false);
    expect(
      isEligibleForCoalescing({
        ...base,
        event: RealtimeEvent.QUESTION_CLOSED,
        deliveryState: RealtimeDeliveryState.PENDING,
      }),
    ).toBe(false);
    expect(
      isEligibleForCoalescing({
        ...base,
        visibility: RealtimeVisibility.SESSION,
        deliveryState: RealtimeDeliveryState.PENDING,
      }),
    ).toBe(false);
    expect(
      isEligibleForCoalescing({
        ...base,
        visibility: RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT,
        deliveryState: RealtimeDeliveryState.PENDING,
      }),
    ).toBe(false);
    expect(
      coalescingKey({
        ...base,
        deliveryState: RealtimeDeliveryState.RETRY,
      }),
    ).toBe(`${LIVE_SESSION_ID}|${SESSION_QUESTION_ID}|teacher`);
    expect(() =>
      coalescingKey({
        ...base,
        deliveryState: RealtimeDeliveryState.DELIVERED,
      }),
    ).toThrow('not eligible');
  });

  it('freezes the shared lifecycle and account-bound lock orders', () => {
    expect(REALTIME_LOCK_ORDER).toEqual(['liveSession', 'sessionQuestion']);
    expect(ACCOUNT_BOUND_REALTIME_LOCK_ORDER).toEqual([
      'liveSession',
      'course',
      'account',
    ]);
    expect(hasLockOrder(REALTIME_LOCK_ORDER, REALTIME_LOCK_ORDER)).toBe(true);
    expect(
      hasLockOrder(['sessionQuestion', 'liveSession'], REALTIME_LOCK_ORDER),
    ).toBe(false);
    expect(
      hasLockOrder(
        ACCOUNT_BOUND_REALTIME_LOCK_ORDER,
        ACCOUNT_BOUND_REALTIME_LOCK_ORDER,
      ),
    ).toBe(true);
  });

  it('maps Redis availability to safe adapter and readiness behavior', () => {
    expect(parseRealtimeRedisMode(undefined)).toBe(RealtimeRedisMode.OFF);
    expect(parseRealtimeRedisMode('optional')).toBe(RealtimeRedisMode.OPTIONAL);
    expect(() => parseRealtimeRedisMode('invalid')).toThrow(TypeError);
    expect(
      resolveRealtimeRedisPolicy(RealtimeRedisMode.OFF, 'unavailable'),
    ).toEqual({ adapter: 'local', readiness: 'healthy', acceptsTraffic: true });
    expect(
      resolveRealtimeRedisPolicy(RealtimeRedisMode.OPTIONAL, 'unavailable'),
    ).toEqual({
      adapter: 'local',
      readiness: 'degraded',
      acceptsTraffic: true,
    });
    expect(
      resolveRealtimeRedisPolicy(RealtimeRedisMode.REQUIRED, 'unavailable'),
    ).toEqual({
      adapter: 'local',
      readiness: 'unready',
      acceptsTraffic: false,
    });
    expect(
      resolveRealtimeRedisPolicy(RealtimeRedisMode.REQUIRED, 'available'),
    ).toEqual({ adapter: 'redis', readiness: 'healthy', acceptsTraffic: true });
  });
});
