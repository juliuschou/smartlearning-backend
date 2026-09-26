import type { TraceSnapshot } from './trace-client';

export const W3_TRACE_BUFFER_MINIMUM = 20_000;

export type TracePreflightFailure =
  | 'TRACE_DISABLED'
  | 'TRACE_RUN_ID_MISMATCH'
  | 'TRACE_BUFFER_TOO_SMALL'
  | 'TRACE_ALREADY_DROPPED_RECORDS';

export type TracePreflightResult =
  | { ok: true; runId: string; bufferSize: number; droppedCount: number }
  | { ok: false; reason: TracePreflightFailure; detail: string };

export function validateTracePreflight(
  snapshot: TraceSnapshot,
  expectedRunId: string,
  minimumBufferSize = W3_TRACE_BUFFER_MINIMUM,
): TracePreflightResult {
  if (!snapshot.enabled || !snapshot.stats) {
    return {
      ok: false,
      reason: 'TRACE_DISABLED',
      detail:
        snapshot.unavailableReason ?? 'Trace diagnostics are unavailable.',
    };
  }
  if (snapshot.stats.runId !== expectedRunId) {
    return {
      ok: false,
      reason: 'TRACE_RUN_ID_MISMATCH',
      detail: `${snapshot.stats.runId} != ${expectedRunId}`,
    };
  }
  if (snapshot.stats.bufferSize < minimumBufferSize) {
    return {
      ok: false,
      reason: 'TRACE_BUFFER_TOO_SMALL',
      detail: `${snapshot.stats.bufferSize} < ${minimumBufferSize}`,
    };
  }
  if (snapshot.stats.droppedCount !== 0) {
    return {
      ok: false,
      reason: 'TRACE_ALREADY_DROPPED_RECORDS',
      detail: `droppedCount=${snapshot.stats.droppedCount}`,
    };
  }
  return {
    ok: true,
    runId: snapshot.stats.runId,
    bufferSize: snapshot.stats.bufferSize,
    droppedCount: snapshot.stats.droppedCount,
  };
}
