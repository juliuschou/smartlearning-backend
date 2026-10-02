/**
 * W3 root-cause timing analysis — derived from the frozen server trace + DB rows.
 *
 * Pure functions. Payload-free: only eventSeq/eventType/visibility/timestamps
 * are used. NOT_OBSERVED is used verbatim when a segment cannot be observed;
 * values are never interpolated.
 *
 * Wall-clock note: every timestamp used here is wall-clock ISO — DB columns
 * (created_at, claimed_at, delivered_at), publisher timing records
 * (dispatchStartAt/dispatchReturnAt, markDelivered*), emit records
 * (emitWallIso). The mono fields (dispatchStartMonoMs, emitMonoMs) are
 * process-relative and are never mixed with wall timestamps.
 */
import type {
  EventTraceRollup,
  TimingRecord,
  TraceSnapshot,
} from './trace-client';
import type { TraceRecord } from './trace-client';

export interface OutboxRow {
  event_id: string;
  event_seq: string;
  event_name: string;
  visibility: string;
  target_participant_id: string | null;
  delivery_state: string;
  coalesced: boolean;
  server_timestamp: string | Date | null;
  claimed_at: string | Date | null;
  delivered_at: string | Date | null;
  created_at: string | Date | null;
}

export interface CadenceSummary {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface SegmentRow {
  appendToClaim: number | typeof NOT_OBSERVED;
  claimToDispatch: number | typeof NOT_OBSERVED;
  dispatchToFirstEmit: number | typeof NOT_OBSERVED;
  firstToLastEmit: number | typeof NOT_OBSERVED;
  lastEmitToDelivered: number | typeof NOT_OBSERVED;
  appendToDelivered: number | typeof NOT_OBSERVED;
  /** Gateway dispatch entered for this row (trace evidence). */
  dispatchEntered?: boolean;
}

export interface LatencyAccounting {
  segments: {
    appendToClaim: CadenceSummary;
    claimToDispatch: CadenceSummary;
    dispatchToFirstEmit: CadenceSummary;
    firstToLastEmit: CadenceSummary;
    lastEmitToDelivered: CadenceSummary;
    appendToDelivered: CadenceSummary;
  };
  /** Share of observed append→delivered time explained by append→claim. */
  queueWaitShare: number | null;
  perEvent: Array<
    SegmentRow & {
      eventSeq: string;
      eventType: string;
      visibility: string;
    }
  >;
}

export interface ClaimCycleDistribution {
  zero: number;
  one: number;
  twoToFortyNine: number;
  fifty: number;
  totalCycles: number;
  percentageOne: number;
  byScanReason: Record<string, number>;
}

export interface QueueTimelineRow {
  eventSeq: string;
  eventType: string;
  visibility: string;
  append: string;
  firstClaim: string;
  dispatch: string;
  firstEmit: string;
  delivered: string;
}

type TimelineTimestamp = string | typeof NOT_OBSERVED;

function isoOrNotObserved(
  value: string | Date | null | undefined,
): TimelineTimestamp {
  const parsed = ms(value);
  return parsed === undefined ? NOT_OBSERVED : new Date(parsed).toISOString();
}

const NOT_OBSERVED = 'NOT_OBSERVED';

function ms(value: string | Date | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function summarize(values: number[]): CadenceSummary {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const pct = (p: number) =>
    finite.length
      ? finite[
          Math.min(finite.length - 1, Math.ceil((p / 100) * finite.length) - 1)
        ]
      : NaN;
  return {
    count: finite.length,
    min: finite.length ? finite[0] : NaN,
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
    max: finite.length ? finite[finite.length - 1] : NaN,
    mean: finite.length
      ? finite.reduce((a, b) => a + b, 0) / finite.length
      : NaN,
  };
}

/** Claim cycle distribution over one run's claimCycles. */
export function classifyClaimCycles(
  claimCycles: TraceSnapshot['claimCycles'],
): ClaimCycleDistribution {
  const buckets = { zero: 0, one: 0, twoToFortyNine: 0, fifty: 0 };
  const byScanReason: Record<string, number> = {};
  for (const cycle of claimCycles) {
    if (cycle.claimedCount === 0) buckets.zero += 1;
    else if (cycle.claimedCount === 1) buckets.one += 1;
    else if (cycle.claimedCount >= 50) buckets.fifty += 1;
    else buckets.twoToFortyNine += 1;
    byScanReason[cycle.scanReason] = (byScanReason[cycle.scanReason] ?? 0) + 1;
  }
  const total = claimCycles.length;
  return {
    ...buckets,
    totalCycles: total,
    percentageOne: total > 0 ? (buckets.one / total) * 100 : 0,
    byScanReason,
  };
}

/** Adjacent-delta cadence over one event-type group, by a chosen timestamp. */
export function cadence(
  rows: OutboxRow[],
  pick: (row: OutboxRow) => number | undefined,
): CadenceSummary {
  const times = rows
    .map(pick)
    .filter((t): t is number => t !== undefined)
    .sort((a, b) => a - b);
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i += 1)
    deltas.push(times[i] - times[i - 1]);
  return summarize(deltas);
}

/**
 * Per-event latency accounting joining DB rows with trace rollups + timing
 * records. Trace wall fields used per event:
 *   claim:      claimed_at (DB; equals claimedAtIso the publisher recorded)
 *   dispatch:   dispatchStartAt / dispatchReturnAt (timing record, eventId)
 *   emit:       emitWallIso over socket records for the eventSeq
 *   delivered:  delivered_at (DB)
 *   append:     created_at (DB row insert; append start is only recorded for
 *               correlated submission rows, so created_at is the append-return
 *               proxy for every row — commit timestamps are NOT directly
 *               observed and are never claimed to be)
 */
export function latencyAccounting(
  rows: OutboxRow[],
  rollups: Map<string, EventTraceRollup>,
  records: TraceRecord[],
  timings: TimingRecord[],
): LatencyAccounting {
  const timingByEvent = new Map<string, TimingRecord>();
  for (const t of timings)
    if (t.eventId !== undefined) timingByEvent.set(t.eventId, t);

  const perEvent: LatencyAccounting['perEvent'] = [];
  const appendToClaim: number[] = [];
  const claimToDispatch: number[] = [];
  const dispatchToFirstEmit: number[] = [];
  const firstToLastEmit: number[] = [];
  const lastEmitToDelivered: number[] = [];
  const appendToDelivered: number[] = [];
  let queueWaitSum = 0;
  let totalSum = 0;

  for (const row of rows) {
    const rollup = rollups.get(row.event_seq);
    const timing = row.event_id ? timingByEvent.get(row.event_id) : undefined;
    // Rollup is used for dispatch-entered evidence in perEvent output below.
    const dispatchEntered = rollup?.gatewayDispatchCalled === true;
    const createdAt = ms(row.created_at);
    const claimedAt = ms(row.claimed_at);
    const deliveredAt = ms(row.delivered_at);
    const dispatchStart = ms(
      typeof timing?.dispatchStartAt === 'string'
        ? timing.dispatchStartAt
        : null,
    );

    const emitIsos = records
      .filter(
        (r) => r.eventSeq === row.event_seq && r.emitWallIso !== undefined,
      )
      .map((r) => ms(r.emitWallIso))
      .filter((t): t is number => t !== undefined)
      .sort((a, b) => a - b);
    const firstEmit = emitIsos[0];
    const lastEmit = emitIsos[emitIsos.length - 1];

    const segAppendClaim =
      createdAt !== undefined && claimedAt !== undefined
        ? claimedAt - createdAt
        : undefined;
    const segClaimDispatch =
      claimedAt !== undefined && dispatchStart !== undefined
        ? dispatchStart - claimedAt
        : undefined;
    const segDispatchEmit =
      dispatchStart !== undefined && firstEmit !== undefined
        ? firstEmit - dispatchStart
        : undefined;
    const segFirstLast =
      firstEmit !== undefined && lastEmit !== undefined
        ? lastEmit - firstEmit
        : undefined;
    const segLastDelivered =
      lastEmit !== undefined && deliveredAt !== undefined
        ? deliveredAt - lastEmit
        : undefined;
    const segAppendDelivered =
      createdAt !== undefined && deliveredAt !== undefined
        ? deliveredAt - createdAt
        : undefined;

    if (segAppendClaim !== undefined) {
      appendToClaim.push(segAppendClaim);
      queueWaitSum += segAppendClaim;
    }
    if (segClaimDispatch !== undefined) claimToDispatch.push(segClaimDispatch);
    if (segDispatchEmit !== undefined)
      dispatchToFirstEmit.push(segDispatchEmit);
    if (segFirstLast !== undefined) firstToLastEmit.push(segFirstLast);
    if (segLastDelivered !== undefined)
      lastEmitToDelivered.push(segLastDelivered);
    if (segAppendDelivered !== undefined) {
      appendToDelivered.push(segAppendDelivered);
      totalSum += segAppendDelivered;
    }

    perEvent.push({
      eventSeq: row.event_seq,
      eventType: row.event_name,
      visibility: row.visibility,
      appendToClaim: segAppendClaim ?? NOT_OBSERVED,
      claimToDispatch: segClaimDispatch ?? NOT_OBSERVED,
      dispatchToFirstEmit: segDispatchEmit ?? NOT_OBSERVED,
      firstToLastEmit: segFirstLast ?? NOT_OBSERVED,
      lastEmitToDelivered: segLastDelivered ?? NOT_OBSERVED,
      appendToDelivered: segAppendDelivered ?? NOT_OBSERVED,
      dispatchEntered,
    });
  }

  const queueWaitShare = totalSum > 0 ? queueWaitSum / totalSum : null;

  return {
    segments: {
      appendToClaim: summarize(appendToClaim),
      claimToDispatch: summarize(claimToDispatch),
      dispatchToFirstEmit: summarize(dispatchToFirstEmit),
      firstToLastEmit: summarize(firstToLastEmit),
      lastEmitToDelivered: summarize(lastEmitToDelivered),
      appendToDelivered: summarize(appendToDelivered),
    },
    queueWaitShare,
    perEvent,
  };
}

/**
 * Compact per-event queue timeline joining each durable outbox row with its
 * observed trace emit records: seq | type | visibility | append | claim |
 * dispatch | firstEmit | delivered.
 *
 * `firstEmit` is the earliest `emitWallIso` observed for the row's `event_seq`
 * in the frozen trace (wall-clock, same clock as the DB timestamps). Any
 * timestamp that cannot be observed is reported verbatim as `NOT_OBSERVED` —
 * never `null`, never interpolated. `dispatch` is the DB `delivery_state` (a
 * server-dispatch marker, not a client-receipt one). Ordering follows the input
 * rows; the driver passes them already ordered by `event_seq`.
 */
export function queueTimeline(
  rows: OutboxRow[],
  records: TraceRecord[] = [],
): QueueTimelineRow[] {
  const firstEmitBySeq = new Map<string, number>();
  for (const record of records) {
    if (record.emitWallIso === undefined) continue;
    const parsed = ms(record.emitWallIso);
    if (parsed === undefined) continue;
    const existing = firstEmitBySeq.get(record.eventSeq);
    if (existing === undefined || parsed < existing)
      firstEmitBySeq.set(record.eventSeq, parsed);
  }

  return rows.map((row) => {
    const firstEmitMs = firstEmitBySeq.get(row.event_seq);
    return {
      eventSeq: row.event_seq,
      eventType: row.event_name,
      visibility: row.visibility,
      append: isoOrNotObserved(row.created_at),
      firstClaim: isoOrNotObserved(row.claimed_at),
      dispatch: row.delivery_state,
      firstEmit:
        firstEmitMs === undefined
          ? NOT_OBSERVED
          : new Date(firstEmitMs).toISOString(),
      delivered: isoOrNotObserved(row.delivered_at),
    };
  });
}

/**
 * Additive canonical summary aliases (§11). Every value here is a projection of
 * a value already computed elsewhere in the report — this helper redefines no
 * formula. It only renames, or marks a field `NOT_OBSERVED` when the underlying
 * evidence is absent, so a consumer can read one canonical key set without
 * re-deriving anything.
 */
export interface CanonicalSummaryInput {
  eventCardinality: { sessionSnapshot: number; voteResult: number };
  claimCycleDistribution: ClaimCycleDistribution;
  voteInterClaim: CadenceSummary;
  latencyAccounting: LatencyAccounting;
  claimCycleDroppedCount: number | undefined;
}

export interface CanonicalSummary {
  SNAPSHOT_BACKLOG_ROWS: number;
  VOTE_ROWS: number;
  CLAIM_COUNT_1_PERCENT: number;
  INTER_CLAIM_P50: number | typeof NOT_OBSERVED;
  INTER_CLAIM_P95: number | typeof NOT_OBSERVED;
  QUEUE_WAIT_SHARE: number | null;
  CLAIM_CYCLE_DROPPED_COUNT: number | typeof NOT_OBSERVED;
}

/** A finite summary percentile, or NOT_OBSERVED when the sample was empty. */
function pct(
  summary: CadenceSummary,
  key: 'p50' | 'p95',
): number | typeof NOT_OBSERVED {
  return Number.isFinite(summary[key]) ? summary[key] : NOT_OBSERVED;
}

export function canonicalSummary(
  input: CanonicalSummaryInput,
): CanonicalSummary {
  return {
    SNAPSHOT_BACKLOG_ROWS: input.eventCardinality.sessionSnapshot,
    VOTE_ROWS: input.eventCardinality.voteResult,
    CLAIM_COUNT_1_PERCENT: input.claimCycleDistribution.percentageOne,
    INTER_CLAIM_P50: pct(input.voteInterClaim, 'p50'),
    INTER_CLAIM_P95: pct(input.voteInterClaim, 'p95'),
    QUEUE_WAIT_SHARE: input.latencyAccounting.queueWaitShare,
    CLAIM_CYCLE_DROPPED_COUNT:
      input.claimCycleDroppedCount === undefined
        ? NOT_OBSERVED
        : input.claimCycleDroppedCount,
  };
}
