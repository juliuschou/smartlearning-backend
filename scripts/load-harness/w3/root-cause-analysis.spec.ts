/**
 * Targeted specs for the W3 root-cause analysis helpers.
 *
 * These pin the report-quality contract (§6 hardening): a missing observation
 * must surface as NOT_OBSERVED (never interpolated, never a crash), percentiles
 * must be computed over the observed sample only, and the canonical summary
 * aliases (§11) must reconcile exactly with the nested values they project —
 * a drift here would silently mislabel a W3 backlog/latency verdict.
 *
 * Run with `npm run load:w3:unit` (tsx), matching the other w3 specs.
 */
import assert from 'node:assert/strict';
import {
  cadence,
  canonicalSummary,
  classifyClaimCycles,
  latencyAccounting,
  queueTimeline,
  summarize,
  type LatencyAccounting,
  type OutboxRow,
} from './root-cause-analysis';
import type {
  EventTraceRollup,
  TimingRecord,
  TraceRecord,
} from './trace-client';

// ---- summarize -------------------------------------------------------------

assert.deepEqual(summarize([]).count, 0);
assert.ok(Number.isNaN(summarize([]).p50), 'empty p50 is NaN, not 0');
assert.deepEqual(
  { count: summarize([4, 1, 3, 2]).count, p50: summarize([1, 2, 3, 4]).p50 },
  { count: 4, p50: 2 },
);
// Non-finite samples are excluded from the sample, not treated as 0.
assert.equal(summarize([1, NaN, Infinity, 3]).count, 2);

// ---- classifyClaimCycles ---------------------------------------------------

assert.equal(classifyClaimCycles([]).totalCycles, 0);
assert.equal(classifyClaimCycles([]).percentageOne, 0, 'no divide-by-zero');

const cycle = (
  claimedCount: number,
  scanReason: 'periodic_poll' | 'wake' | 'continuation' | 'startup' | 'other',
) =>
  ({
    runId: 'r',
    publisherInstanceId: 'p',
    scanReason,
    claimedCount,
    claimedAtIso: '2026-01-01T00:00:00.000Z',
  }) as Parameters<typeof classifyClaimCycles>[0][number];

const dist = classifyClaimCycles([
  cycle(0, 'periodic_poll'),
  cycle(1, 'wake'),
  cycle(1, 'wake'),
  cycle(2, 'periodic_poll'),
  cycle(49, 'continuation'),
  cycle(50, 'startup'),
  cycle(120, 'other'),
]);
assert.deepEqual(
  {
    zero: dist.zero,
    one: dist.one,
    twoToFortyNine: dist.twoToFortyNine,
    fifty: dist.fifty,
    totalCycles: dist.totalCycles,
  },
  { zero: 1, one: 2, twoToFortyNine: 2, fifty: 2, totalCycles: 7 },
);
assert.equal(dist.percentageOne, (2 / 7) * 100);
assert.deepEqual(dist.byScanReason, {
  periodic_poll: 2,
  wake: 2,
  continuation: 1,
  startup: 1,
  other: 1,
});

// ---- cadence ---------------------------------------------------------------

const row = (claimed: string | null, seq = '1'): OutboxRow => ({
  event_id: `e${seq}`,
  event_seq: seq,
  event_name: 'result.updated',
  visibility: 'participant_after_submit',
  target_participant_id: null,
  delivery_state: 'delivered',
  coalesced: false,
  server_timestamp: null,
  claimed_at: claimed,
  delivered_at: null,
  created_at: null,
});
const pickClaim = (r: OutboxRow) => {
  const v = r.claimed_at;
  if (v === null) return undefined;
  return v instanceof Date ? v.getTime() : Date.parse(v);
};

const t0 = '2026-01-01T00:00:00.000Z';
const t1 = '2026-01-01T00:00:01.000Z';
const t2 = '2026-01-01T00:00:04.000Z';

// ordered timestamps → deltas
assert.deepEqual(cadence([row(t0), row(t1), row(t2)], pickClaim).count, 2);
assert.equal(cadence([row(t0), row(t1), row(t2)], pickClaim).p50, 1000);
// out-of-order input is sorted before differencing
assert.deepEqual(cadence([row(t2), row(t0), row(t1)], pickClaim).max, 3000);
// single row → no adjacent pair
assert.equal(cadence([row(t0)], pickClaim).count, 0);
assert.ok(Number.isNaN(cadence([row(t0)], pickClaim).p50));
// empty rows
assert.equal(cadence([], pickClaim).count, 0);
// missing timestamps are dropped, not defaulted
assert.equal(
  cadence([row(null), row(t0), row(null), row(t1)], pickClaim).count,
  1,
);

// ---- latencyAccounting -----------------------------------------------------

const outboxRow = (over: Partial<OutboxRow> = {}): OutboxRow => ({
  event_id: 'evt-1',
  event_seq: '25',
  event_name: 'result.updated',
  visibility: 'participant_after_submit',
  target_participant_id: null,
  delivery_state: 'delivered',
  coalesced: false,
  server_timestamp: null,
  claimed_at: null,
  delivered_at: null,
  created_at: null,
  ...over,
});

const emitRecord = (eventSeq: string, emitWallIso: string): TraceRecord =>
  ({ eventSeq, emitWallIso }) as TraceRecord;

const rollup = (eventSeq: string): EventTraceRollup =>
  ({
    eventSeq,
    eventId: 'evt-1',
    eventType: 'result.updated',
    gatewayDispatchCalled: true,
    claimOnly: false,
    coalesced: false,
    rooms: [],
    emittedSocketIds: [],
    guardSkips: [],
    deliveryRejected: [],
  }) as EventTraceRollup;

const timing = (over: Partial<TimingRecord> = {}): TimingRecord =>
  ({
    schemaVersion: 1,
    runId: 'r',
    correlationId: 'c',
    liveSessionId: 's',
    sessionQuestionId: 'q',
    participantId: 'p',
    eventId: 'evt-1',
    dispatchStartAt: t1,
    ...over,
  }) as TimingRecord;

// A complete observed event: append→claim→dispatch→emit→delivered all present.
{
  const rows = [
    outboxRow({ created_at: t0, claimed_at: t1, delivered_at: t2 }),
  ];
  const acc = latencyAccounting(
    rows,
    new Map([['25', rollup('25')]]),
    [emitRecord('25', t1)],
    [timing()],
  );
  const ev = acc.perEvent[0];
  assert.equal(ev.appendToClaim, 1000);
  assert.equal(ev.appendToDelivered, 4000);
  assert.equal(ev.dispatchEntered, true);
  assert.equal(acc.segments.appendToClaim.p50, 1000);
  assert.equal(acc.segments.appendToClaim.count, 1);
}

// Missing dispatch timing → claim→dispatch and dispatch→emit NOT_OBSERVED.
{
  const acc = latencyAccounting(
    [outboxRow({ created_at: t0, claimed_at: t1, delivered_at: t2 })],
    new Map(),
    [emitRecord('25', t1)],
    [],
  );
  const ev = acc.perEvent[0];
  assert.equal(ev.claimToDispatch, 'NOT_OBSERVED');
  assert.equal(ev.dispatchToFirstEmit, 'NOT_OBSERVED');
  assert.equal(ev.appendToClaim, 1000, 'still observed');
}

// Missing emit → dispatch→first emit / first→last / last→delivered NOT_OBSERVED.
{
  const acc = latencyAccounting(
    [outboxRow({ created_at: t0, claimed_at: t1, delivered_at: t2 })],
    new Map(),
    [],
    [timing()],
  );
  const ev = acc.perEvent[0];
  assert.equal(ev.dispatchToFirstEmit, 'NOT_OBSERVED');
  assert.equal(ev.firstToLastEmit, 'NOT_OBSERVED');
  assert.equal(ev.lastEmitToDelivered, 'NOT_OBSERVED');
}

// Missing delivered → lastEmitToDelivered and appendToDelivered NOT_OBSERVED.
{
  const acc = latencyAccounting(
    [outboxRow({ created_at: t0, claimed_at: t1 })],
    new Map(),
    [emitRecord('25', t1)],
    [timing()],
  );
  const ev = acc.perEvent[0];
  assert.equal(ev.lastEmitToDelivered, 'NOT_OBSERVED');
  assert.equal(ev.appendToDelivered, 'NOT_OBSERVED');
}

// Empty rows → no crash, empty summaries stay NaN, queueWaitShare null.
{
  const acc = latencyAccounting([], new Map(), [], []);
  assert.equal(acc.perEvent.length, 0);
  assert.equal(acc.segments.appendToDelivered.count, 0);
  assert.ok(Number.isNaN(acc.segments.appendToDelivered.p95));
  assert.equal(acc.queueWaitShare, null, 'no divide-by-zero');
}

// Multiple emits → first/last emit spans them; queueWaitShare is a real ratio.
{
  const emits = [
    emitRecord('25', t1),
    emitRecord('25', '2026-01-01T00:00:03.000Z'),
  ];
  const acc = latencyAccounting(
    [outboxRow({ created_at: t0, claimed_at: t1, delivered_at: t2 })],
    new Map(),
    emits,
    [timing()],
  );
  const ev = acc.perEvent[0];
  assert.equal(ev.firstToLastEmit, 2000);
  assert.equal(ev.lastEmitToDelivered, 1000);
  // append→claim = 1000 of append→delivered = 4000 → 0.25
  assert.equal(acc.queueWaitShare, 0.25);
}

// ---- queueTimeline ---------------------------------------------------------

const qRow = (over: Partial<OutboxRow> = {}): OutboxRow => ({
  event_id: 'evt-1',
  event_seq: '25',
  event_name: 'result.updated',
  visibility: 'participant_after_submit',
  target_participant_id: null,
  delivery_state: 'delivered',
  coalesced: false,
  server_timestamp: null,
  claimed_at: null,
  delivered_at: null,
  created_at: null,
  ...over,
});

// Full timing + firstEmit derived from the earliest emit record.
{
  const tl = queueTimeline(
    [qRow({ created_at: t0, claimed_at: t1, delivered_at: t2 })],
    [emitRecord('25', '2026-01-01T00:00:03.000Z'), emitRecord('25', t1)],
  );
  assert.deepEqual(tl[0], {
    eventSeq: '25',
    eventType: 'result.updated',
    visibility: 'participant_after_submit',
    append: t0,
    firstClaim: t1,
    dispatch: 'delivered',
    firstEmit: t1,
    delivered: t2,
  });
}

// Missing emit → NOT_OBSERVED (not null).
assert.equal(
  queueTimeline([qRow({ created_at: t0 })], [])[0].firstEmit,
  'NOT_OBSERVED',
);
// Missing claim/delivered → NOT_OBSERVED.
{
  const tl = queueTimeline(
    [qRow({ created_at: t0 })],
    [emitRecord('25', t1)],
  )[0];
  assert.equal(tl.firstClaim, 'NOT_OBSERVED');
  assert.equal(tl.delivered, 'NOT_OBSERVED');
  assert.equal(tl.append, t0);
}
// Empty input → empty output, no crash.
assert.deepEqual(queueTimeline([], [emitRecord('25', t1)]), []);
// Ordering follows the input rows (driver passes them ordered by event_seq).
{
  const tl = queueTimeline(
    [qRow({ event_seq: '1' }), qRow({ event_seq: '2' })],
    [],
  );
  assert.deepEqual(
    tl.map((r) => r.eventSeq),
    ['1', '2'],
  );
}

// ---- canonicalSummary ------------------------------------------------------

const sampleLatency: LatencyAccounting = latencyAccounting(
  [outboxRow({ created_at: t0, claimed_at: t1, delivered_at: t2 })],
  new Map(),
  [emitRecord('25', t1)],
  [timing()],
);

{
  const dist = classifyClaimCycles([cycle(1, 'wake'), cycle(0, 'wake')]);
  const voteInterClaim = cadence([row(t0), row(t1), row(t2)], pickClaim);
  const canonical = canonicalSummary({
    eventCardinality: { sessionSnapshot: 4, voteResult: 7 },
    claimCycleDistribution: dist,
    voteInterClaim,
    latencyAccounting: sampleLatency,
    claimCycleDroppedCount: 0,
  });
  assert.equal(canonical.SNAPSHOT_BACKLOG_ROWS, 4);
  assert.equal(canonical.VOTE_ROWS, 7);
  assert.equal(canonical.CLAIM_COUNT_1_PERCENT, dist.percentageOne);
  assert.equal(canonical.INTER_CLAIM_P50, voteInterClaim.p50);
  assert.equal(canonical.INTER_CLAIM_P95, voteInterClaim.p95);
  assert.equal(canonical.QUEUE_WAIT_SHARE, sampleLatency.queueWaitShare);
  assert.equal(canonical.CLAIM_CYCLE_DROPPED_COUNT, 0);
}

// Missing evidence never crashes and is marked, not guessed.
{
  const emptySummary = cadence([], pickClaim);
  const canonical = canonicalSummary({
    eventCardinality: { sessionSnapshot: 0, voteResult: 0 },
    claimCycleDistribution: classifyClaimCycles([]),
    voteInterClaim: emptySummary,
    latencyAccounting: latencyAccounting([], new Map(), [], []),
    claimCycleDroppedCount: undefined,
  });
  assert.equal(canonical.INTER_CLAIM_P50, 'NOT_OBSERVED');
  assert.equal(canonical.INTER_CLAIM_P95, 'NOT_OBSERVED');
  assert.equal(canonical.QUEUE_WAIT_SHARE, null);
  assert.equal(canonical.CLAIM_CYCLE_DROPPED_COUNT, 'NOT_OBSERVED');
  assert.equal(canonical.SNAPSHOT_BACKLOG_ROWS, 0);
  assert.doesNotThrow(() => JSON.stringify(canonical));
}

// Canonical values must reconcile with the nested sources they project.
{
  const dist = classifyClaimCycles([cycle(1, 'wake'), cycle(1, 'wake')]);
  const voteInterClaim = cadence([row(t0), row(t2)], pickClaim);
  const canonical = canonicalSummary({
    eventCardinality: { sessionSnapshot: 1, voteResult: 2 },
    claimCycleDistribution: dist,
    voteInterClaim,
    latencyAccounting: sampleLatency,
    claimCycleDroppedCount: 3,
  });
  assert.equal(canonical.CLAIM_COUNT_1_PERCENT, dist.percentageOne);
  assert.equal(canonical.INTER_CLAIM_P95, voteInterClaim.p95);
  assert.equal(canonical.CLAIM_CYCLE_DROPPED_COUNT, 3);
}

console.log('W3 root-cause-analysis tests passed.');
