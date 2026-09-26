import assert from 'node:assert/strict';
import { validateTracePreflight } from './trace-preflight';
import {
  createW3RunId,
  requireW3RunId,
  w3RunEnvironment,
} from './run-contract';
import type { TraceSnapshot } from './trace-client';

const failedReason = (result: ReturnType<typeof validateTracePreflight>) => {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected trace preflight failure');
  return result.reason;
};

const snapshot = (overrides: Partial<TraceSnapshot> = {}): TraceSnapshot => ({
  enabled: true,
  runId: 'run-123',
  stats: {
    schemaVersion: 1,
    enabled: true,
    instanceId: 'instance-1',
    runId: 'run-123',
    bufferSize: 20_000,
    recordedCount: 0,
    droppedCount: 0,
    dispatchedEventCount: 0,
  },
  records: [],
  timings: [],
  fetchedAtMs: 0,
  ...overrides,
});

assert.deepEqual(validateTracePreflight(snapshot(), 'run-123'), {
  ok: true,
  runId: 'run-123',
  bufferSize: 20_000,
  droppedCount: 0,
});
assert.equal(
  failedReason(validateTracePreflight(snapshot(), 'other')),
  'TRACE_RUN_ID_MISMATCH',
);
assert.equal(
  failedReason(validateTracePreflight(snapshot({ enabled: false }), 'run-123')),
  'TRACE_DISABLED',
);
assert.equal(
  failedReason(
    validateTracePreflight(
      snapshot({
        stats: { ...snapshot().stats!, bufferSize: 5_000 },
      }),
      'run-123',
    ),
  ),
  'TRACE_BUFFER_TOO_SMALL',
);
assert.equal(
  failedReason(
    validateTracePreflight(
      snapshot({
        stats: { ...snapshot().stats!, droppedCount: 1 },
      }),
      'run-123',
    ),
  ),
  'TRACE_ALREADY_DROPPED_RECORDS',
);

assert.equal(createW3RunId('run-123'), 'run-123');
assert.deepEqual(w3RunEnvironment('run-123', { NODE_ENV: 'test' }), {
  NODE_ENV: 'test',
  W3_RUN_ID: 'run-123',
  REALTIME_TRACE_RUN_ID: 'run-123',
  W3_TRACE_REQUIRED: '1',
});
assert.throws(() => createW3RunId('bad run id'));
assert.equal(requireW3RunId('run-123'), 'run-123');
assert.throws(() => requireW3RunId(undefined));

console.log('W3 trace preflight tests passed.');
