import assert from 'node:assert/strict';
import {
  validateTracePreflight,
  validateAttributionPreflight,
  type AttributionPreflightInput,
  type ExternalCompetitorObservation,
  type W3AttributionEvidence,
} from './trace-preflight';
import {
  createW3RunId,
  requireW3RunId,
  w3RunEnvironment,
} from './run-contract';
import type { TraceSnapshot, TraceRecord } from './trace-client';
import type { ProcfsAttribution } from './procfs-attribution';

const failedReason = (result: ReturnType<typeof validateTracePreflight>) => {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected trace preflight failure');
  return result.reason;
};

const PROCESS_START = '2026-01-01T00:00:00.000Z';

const snapshot = (overrides: Partial<TraceSnapshot> = {}): TraceSnapshot => ({
  enabled: true,
  runId: 'run-123',
  stats: {
    schemaVersion: 1,
    enabled: true,
    instanceId: 'instance-1',
    backendInstanceId: 'backend-1',
    processId: 4242,
    processStartIso: PROCESS_START,
    hostname: 'wsl-host',
    lifecycle: [
      {
        component: 'traceService',
        instanceId: 'instance-1',
        constructedAtIso: PROCESS_START,
      },
      {
        component: 'gateway',
        instanceId: 'gateway-1',
        constructedAtIso: PROCESS_START,
      },
      {
        component: 'publisher',
        instanceId: 'publisher-1',
        constructedAtIso: PROCESS_START,
      },
    ],
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

const procfs = (
  overrides: Partial<ProcfsAttribution> = {},
): ProcfsAttribution => ({
  port: 3001,
  listenerPids: [4242],
  inaccessibleFdCount: 0,
  process: {
    pid: 4242,
    command: ['/usr/bin/node', 'dist/src/main.js'],
    cwd: '/repo',
    executable: '/usr/bin/node',
    startIso: PROCESS_START,
  },
  ...overrides,
});

const external = (
  overrides: Partial<ExternalCompetitorObservation> = {},
): ExternalCompetitorObservation => ({
  observedAtIso: PROCESS_START,
  externalPublisherExclusivity: 'observational',
  competingProcesses: [],
  competingContainers: [],
  competingDatabaseSessions: [],
  activeOutboxClaims: [],
  conflictingAdvisoryLocks: [],
  ...overrides,
});

const attributionInput = (
  overrides: Partial<AttributionPreflightInput> = {},
): AttributionPreflightInput => ({
  childPid: 4242,
  expectedRunId: 'run-123',
  expectedTraceRunId: 'run-123',
  expectedCwd: '/repo',
  expectedExecutable: '/usr/bin/node',
  expectedScript: 'dist/src/main.js',
  spawnStartedAtMs: Date.parse(PROCESS_START) - 1_000,
  spawnReadyAtMs: Date.parse(PROCESS_START) + 1_000,
  procfs: procfs(),
  trace: snapshot(),
  mismatchTrace: { ...snapshot(), records: [], timings: [] },
  externalObservation: external(),
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

// ---- Attribution validator: happy path -------------------------------------
{
  const result = validateAttributionPreflight(attributionInput());
  assert.equal(result.status, 'passed');
  assert.equal(result.failureCode, undefined);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.externalPublisherExclusivity, 'observational');
  assert.equal(result.process.childPid, 4242);
  assert.deepEqual(result.process.listenerPids, [4242]);
  assert.equal(result.process.traceProcessId, 4242);
  assert.equal(result.runtime.traceServiceInstanceId, 'instance-1');
  assert.equal(result.runtime.gatewayInstanceId, 'gateway-1');
  assert.equal(result.runtime.publisherInstanceId, 'publisher-1');
  assert.equal(result.runtime.mismatchRecordCount, 0);
  assert.equal(result.runtime.mismatchTimingCount, 0);
  // Bounded, secret-safe: no environment dump or URL-like material.
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('postgresql://'), false);
}

const attributionCases: Array<[string, AttributionPreflightInput, string]> = [
  [
    'missing child PID',
    attributionInput({ childPid: 0 }),
    'BACKEND_PID_MISSING',
  ],
  [
    'listener mismatch',
    attributionInput({ procfs: procfs({ listenerPids: [9999] }) }),
    'CHILD_LISTENER_PID_MISMATCH',
  ],
  [
    'multiple listeners',
    attributionInput({ procfs: procfs({ listenerPids: [1, 4242] }) }),
    'CHILD_LISTENER_PID_MISMATCH',
  ],
  [
    'trace PID mismatch',
    attributionInput({
      trace: snapshot({
        stats: { ...snapshot().stats!, processId: 5 },
      }),
    }),
    'CHILD_TRACE_PID_MISMATCH',
  ],
  [
    'command mismatch',
    attributionInput({
      procfs: procfs({
        process: {
          ...procfs().process,
          command: ['/usr/bin/node', 'other.js'],
        },
      }),
    }),
    'COMMAND_MISMATCH',
  ],
  [
    'cwd mismatch',
    attributionInput({
      procfs: procfs({
        process: { ...procfs().process, cwd: '/elsewhere' },
      }),
    }),
    'CWD_MISMATCH',
  ],
  [
    'executable mismatch',
    attributionInput({
      procfs: procfs({
        process: { ...procfs().process, executable: '/usr/bin/other' },
      }),
    }),
    'EXECUTABLE_MISMATCH',
  ],
  [
    'start outside window',
    attributionInput({
      procfs: procfs({
        process: {
          ...procfs().process,
          startIso: '2020-01-01T00:00:00.000Z',
        },
      }),
    }),
    'PROCESS_START_MISMATCH',
  ],
  [
    'trace start delta too large',
    attributionInput({
      trace: snapshot({
        stats: {
          ...snapshot().stats!,
          processStartIso: '2020-01-01T00:00:00.000Z',
        },
      }),
    }),
    'PROCESS_START_MISMATCH',
  ],
  [
    'trace run ID mismatch',
    attributionInput({ expectedTraceRunId: 'other' }),
    'W3_RUN_ID_MISMATCH',
  ],
  [
    'trace disabled',
    attributionInput({ trace: snapshot({ enabled: false }) }),
    'TRACE_DISABLED',
  ],
  [
    'buffer too small',
    attributionInput({
      trace: snapshot({ stats: { ...snapshot().stats!, bufferSize: 5_000 } }),
    }),
    'TRACE_BUFFER_TOO_SMALL',
  ],
  [
    'dropped records',
    attributionInput({
      trace: snapshot({ stats: { ...snapshot().stats!, droppedCount: 1 } }),
    }),
    'TRACE_ALREADY_DROPPED_RECORDS',
  ],
  [
    'no trace service lifecycle',
    attributionInput({
      trace: snapshot({
        stats: {
          ...snapshot().stats!,
          lifecycle: snapshot().stats!.lifecycle.filter(
            (entry) => entry.component !== 'traceService',
          ),
        },
      }),
    }),
    'TRACE_SERVICE_NOT_SINGLETON',
  ],
  [
    'duplicate gateways',
    attributionInput({
      trace: snapshot({
        stats: {
          ...snapshot().stats!,
          lifecycle: [
            ...snapshot().stats!.lifecycle,
            {
              component: 'gateway',
              instanceId: 'gateway-2',
              constructedAtIso: PROCESS_START,
            },
          ],
        },
      }),
    }),
    'GATEWAY_NOT_SINGLETON',
  ],
  [
    'no publisher',
    attributionInput({
      trace: snapshot({
        stats: {
          ...snapshot().stats!,
          lifecycle: snapshot().stats!.lifecycle.filter(
            (entry) => entry.component !== 'publisher',
          ),
        },
      }),
    }),
    'PUBLISHER_NOT_SINGLETON',
  ],
  [
    'publisher already stopped',
    attributionInput({
      trace: snapshot({
        stats: {
          ...snapshot().stats!,
          lifecycle: [
            ...snapshot().stats!.lifecycle,
            {
              component: 'publisher-stop',
              instanceId: 'publisher-1',
              constructedAtIso: PROCESS_START,
            },
          ],
        },
      }),
    }),
    'PUBLISHER_ALREADY_STOPPED',
  ],
  [
    'competing record publisher identity',
    attributionInput({
      trace: snapshot({
        records: [
          {
            schemaVersion: 1,
            runId: 'run-123',
            instanceId: 'instance-1',
            backendInstanceId: 'backend-1',
            processId: 4242,
            processStartIso: PROCESS_START,
            hostname: 'wsl-host',
            phase: 'publisher',
            eventId: 'event-1',
            eventSeq: '1',
            eventType: 'RESULT_UPDATED',
            liveSessionId: 'session-1',
            targetType: 'room',
            targetId: 'session:1',
            payloadCorrelation: {
              eventSeq: '1',
              aggregateVersion: 1,
              visibility: 'participant',
            },
            publisherInstanceId: 'publisher-2',
          } satisfies TraceRecord,
        ],
      }),
    }),
    'COMPETING_RUNTIME_IDENTITY',
  ],
  [
    'mismatched run exposes records',
    attributionInput({
      mismatchTrace: {
        ...snapshot(),
        records: [
          {
            schemaVersion: 1,
            runId: 'other-run',
            instanceId: 'instance-1',
            backendInstanceId: 'backend-1',
            processId: 4242,
            processStartIso: PROCESS_START,
            hostname: 'wsl-host',
            phase: 'room',
            eventId: 'event-1',
            eventSeq: '1',
            eventType: 'RESULT_UPDATED',
            liveSessionId: 'session-1',
            targetType: 'room',
            targetId: 'session:1',
            payloadCorrelation: {
              eventSeq: '1',
              aggregateVersion: 1,
              visibility: 'participant',
            },
          } satisfies TraceRecord,
        ],
      },
    }),
    'MISMATCHED_RUN_NOT_ISOLATED',
  ],
  [
    'mismatched run exposes timings',
    attributionInput({
      mismatchTrace: {
        ...snapshot(),
        timings: [
          {
            schemaVersion: 1,
            runId: 'other-run',
            correlationId: 'corr-1',
            liveSessionId: 'session-1',
            sessionQuestionId: 'sq-1',
            participantId: 'p-1',
          },
        ],
      },
    }),
    'MISMATCHED_RUN_NOT_ISOLATED',
  ],
  [
    'external competitor observed',
    attributionInput({
      externalObservation: external({
        competingDatabaseSessions: ['5551:app:10.0.0.9'],
      }),
    }),
    'EXTERNAL_COMPETITOR_OBSERVED',
  ],
  [
    'competing host process observed',
    attributionInput({
      externalObservation: external({
        competingProcesses: ['123:node dist/src/main.js'],
      }),
    }),
    'EXTERNAL_COMPETITOR_OBSERVED',
  ],
];

for (const [name, input, expected] of attributionCases) {
  const result = validateAttributionPreflight(input);
  assert.equal(result.status, 'failed', `expected failure: ${name}`);
  assert.equal(
    result.failureCode,
    expected,
    `unexpected failure code: ${name}`,
  );
  // Failed evidence remains bounded, secret-safe, and typed.
  const serialized = JSON.stringify(result as W3AttributionEvidence);
  assert.equal(serialized.includes('postgresql://'), false);
}

console.log('W3 trace preflight tests passed.');
