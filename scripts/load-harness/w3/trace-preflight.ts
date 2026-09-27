import type { ProcfsAttribution } from './procfs-attribution';
import type { TraceSnapshot } from './trace-client';

export const W3_TRACE_BUFFER_MINIMUM = 20_000;
export const W3_PROCESS_START_TOLERANCE_MS = 2_000;

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

export type ExternalCompetitorObservation = {
  observedAtIso: string;
  externalPublisherExclusivity: 'observational';
  competingProcesses: string[];
  competingContainers: string[];
  competingDatabaseSessions: string[];
  activeOutboxClaims: string[];
  conflictingAdvisoryLocks: string[];
};

export type W3AttributionFailureCode =
  | TracePreflightFailure
  | 'BACKEND_PID_MISSING'
  | 'CHILD_LISTENER_PID_MISMATCH'
  | 'CHILD_TRACE_PID_MISMATCH'
  | 'COMMAND_MISMATCH'
  | 'CWD_MISMATCH'
  | 'EXECUTABLE_MISMATCH'
  | 'PROCESS_START_MISMATCH'
  | 'W3_RUN_ID_MISMATCH'
  | 'TRACE_SERVICE_NOT_SINGLETON'
  | 'GATEWAY_NOT_SINGLETON'
  | 'PUBLISHER_NOT_SINGLETON'
  | 'PUBLISHER_ALREADY_STOPPED'
  | 'COMPETING_RUNTIME_IDENTITY'
  | 'MISMATCHED_RUN_NOT_ISOLATED'
  | 'EXTERNAL_COMPETITOR_OBSERVED';

export type W3AttributionEvidence = {
  schemaVersion: 1;
  status: 'passed' | 'failed';
  failureCode?: W3AttributionFailureCode;
  observedAtIso: string;
  runId: string;
  externalPublisherExclusivity: 'observational';
  process: {
    childPid: number;
    listenerPids: number[];
    traceProcessId?: number;
    command: string[];
    cwd: string;
    executable: string;
    processStartIso: string;
    traceProcessStartIso?: string;
    startDeltaMs?: number;
  };
  runtime: {
    hostname?: string;
    backendInstanceId?: string;
    traceServiceInstanceId?: string;
    gatewayInstanceId?: string;
    publisherInstanceId?: string;
    bufferSize?: number;
    droppedCount?: number;
    mismatchRecordCount: number;
    mismatchTimingCount: number;
  };
  externalObservation: ExternalCompetitorObservation;
};

export type AttributionPreflightInput = {
  childPid: number;
  expectedRunId: string;
  expectedTraceRunId: string;
  expectedCwd: string;
  expectedExecutable: string;
  expectedScript: string;
  spawnStartedAtMs: number;
  spawnReadyAtMs: number;
  procfs: ProcfsAttribution;
  trace: TraceSnapshot;
  mismatchTrace: TraceSnapshot;
  externalObservation: ExternalCompetitorObservation;
};

function bounded(value: string, max = 240): string {
  return value.slice(0, max);
}

function uniqueLifecycle(
  snapshot: TraceSnapshot,
  component: 'traceService' | 'gateway' | 'publisher' | 'publisher-stop',
): string[] {
  return [
    ...new Set(
      (snapshot.stats?.lifecycle ?? [])
        .filter((entry) => entry.component === component)
        .map((entry) => entry.instanceId),
    ),
  ];
}

export function validateAttributionPreflight(
  input: AttributionPreflightInput,
): W3AttributionEvidence {
  const stats = input.trace.stats;
  const traceServices = uniqueLifecycle(input.trace, 'traceService');
  const gateways = uniqueLifecycle(input.trace, 'gateway');
  const publishers = uniqueLifecycle(input.trace, 'publisher');
  const publisherStops = uniqueLifecycle(input.trace, 'publisher-stop');
  const startDeltaMs = stats
    ? Math.abs(
        Date.parse(input.procfs.process.startIso) -
          Date.parse(stats.processStartIso),
      )
    : undefined;

  const evidence: W3AttributionEvidence = {
    schemaVersion: 1,
    status: 'passed',
    observedAtIso: input.externalObservation.observedAtIso,
    runId: input.expectedRunId,
    externalPublisherExclusivity: 'observational',
    process: {
      childPid: input.childPid,
      listenerPids: input.procfs.listenerPids.slice(0, 8),
      traceProcessId: stats?.processId,
      command: input.procfs.process.command.slice(0, 8).map((v) => bounded(v)),
      cwd: bounded(input.procfs.process.cwd),
      executable: bounded(input.procfs.process.executable),
      processStartIso: input.procfs.process.startIso,
      traceProcessStartIso: stats?.processStartIso,
      startDeltaMs,
    },
    runtime: {
      hostname: stats?.hostname ? bounded(stats.hostname, 120) : undefined,
      backendInstanceId: stats?.backendInstanceId,
      traceServiceInstanceId: traceServices[0],
      gatewayInstanceId: gateways[0],
      publisherInstanceId: publishers[0],
      bufferSize: stats?.bufferSize,
      droppedCount: stats?.droppedCount,
      mismatchRecordCount: input.mismatchTrace.records.length,
      mismatchTimingCount: input.mismatchTrace.timings.length,
    },
    externalObservation: {
      ...input.externalObservation,
      competingProcesses: input.externalObservation.competingProcesses
        .slice(0, 8)
        .map((v) => bounded(v)),
      competingContainers: input.externalObservation.competingContainers
        .slice(0, 8)
        .map((v) => bounded(v)),
      competingDatabaseSessions:
        input.externalObservation.competingDatabaseSessions
          .slice(0, 8)
          .map((v) => bounded(v)),
      activeOutboxClaims: input.externalObservation.activeOutboxClaims
        .slice(0, 8)
        .map((v) => bounded(v)),
      conflictingAdvisoryLocks:
        input.externalObservation.conflictingAdvisoryLocks
          .slice(0, 8)
          .map((v) => bounded(v)),
    },
  };

  const fail = (failureCode: W3AttributionFailureCode) => ({
    ...evidence,
    status: 'failed' as const,
    failureCode,
  });
  const traceCheck = validateTracePreflight(input.trace, input.expectedRunId);
  if (!traceCheck.ok) return fail(traceCheck.reason);
  if (!Number.isInteger(input.childPid) || input.childPid <= 0)
    return fail('BACKEND_PID_MISSING');
  if (
    input.procfs.listenerPids.length !== 1 ||
    input.procfs.listenerPids[0] !== input.childPid
  )
    return fail('CHILD_LISTENER_PID_MISMATCH');
  if (stats?.processId !== input.childPid)
    return fail('CHILD_TRACE_PID_MISMATCH');
  if (
    input.procfs.process.command.length !== 2 ||
    input.procfs.process.command[1] !== input.expectedScript
  )
    return fail('COMMAND_MISMATCH');
  if (input.procfs.process.cwd !== input.expectedCwd)
    return fail('CWD_MISMATCH');
  if (input.procfs.process.executable !== input.expectedExecutable)
    return fail('EXECUTABLE_MISMATCH');
  const procStart = Date.parse(input.procfs.process.startIso);
  if (
    !Number.isFinite(procStart) ||
    procStart < input.spawnStartedAtMs - W3_PROCESS_START_TOLERANCE_MS ||
    procStart > input.spawnReadyAtMs + W3_PROCESS_START_TOLERANCE_MS ||
    startDeltaMs === undefined ||
    !Number.isFinite(startDeltaMs) ||
    startDeltaMs > W3_PROCESS_START_TOLERANCE_MS
  )
    return fail('PROCESS_START_MISMATCH');
  if (
    input.expectedRunId !== input.expectedTraceRunId ||
    stats?.runId !== input.expectedRunId
  )
    return fail('W3_RUN_ID_MISMATCH');
  if (traceServices.length !== 1 || traceServices[0] !== stats?.instanceId)
    return fail('TRACE_SERVICE_NOT_SINGLETON');
  if (gateways.length !== 1) return fail('GATEWAY_NOT_SINGLETON');
  if (publishers.length !== 1) return fail('PUBLISHER_NOT_SINGLETON');
  if (publisherStops.length !== 0) return fail('PUBLISHER_ALREADY_STOPPED');
  if (
    input.trace.records.some(
      (record) =>
        record.processId !== stats?.processId ||
        record.backendInstanceId !== stats?.backendInstanceId ||
        record.instanceId !== stats?.instanceId ||
        (record.publisherInstanceId !== undefined &&
          record.publisherInstanceId !== publishers[0]),
    )
  )
    return fail('COMPETING_RUNTIME_IDENTITY');
  if (
    input.mismatchTrace.records.length !== 0 ||
    input.mismatchTrace.timings.length !== 0
  )
    return fail('MISMATCHED_RUN_NOT_ISOLATED');
  if (
    Object.values(input.externalObservation)
      .filter(Array.isArray)
      .some((values) => (values as unknown[]).length > 0)
  )
    return fail('EXTERNAL_COMPETITOR_OBSERVED');
  return evidence;
}
