import { performance } from 'node:perf_hooks';
import { summarize, type TimingSummary } from './metrics';

export const w1DiagnosticsEnabled = process.env.W1_DIAGNOSTICS === '1';

export type DiagnosticPhase =
  | 'findByCode'
  | 'transaction'
  | 'liveSessionLockRead'
  | 'participantInsert'
  | 'outboxAppend'
  | 'postCommitSnapshot'
  | 'publisher';

export interface ClientDiagnosticRecord {
  requestId: string;
  durationMs: number;
}

export interface BackendDiagnosticRecord {
  schemaVersion: 2;
  runId: string | null;
  requestId: string | null;
  phases: Record<string, number>;
  phaseSemantics: {
    liveSessionLockRead: 'joinabilityGuardSharedLockAndConditionalParticipantInsert';
    outboxAppend: 'transactionalSequenceAllocationAndOutboxInsert';
  };
  architecture: {
    joinabilitySynchronization: 'live_session_for_share_vs_lifecycle_for_update';
    sequenceAllocation: 'live_session_event_sequence_row';
  };
  publisher: 'fire-and-forget; not measured on response path';
  snapshotOnResponsePath: false;
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value);
}

export function parseBackendDiagnosticHeader(
  value: string | null,
): BackendDiagnosticRecord | undefined {
  if (!value || value.length > 8192) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.schemaVersion !== 2 ||
      !validRequestId(parsed.requestId) ||
      (parsed.runId !== null && !validRequestId(parsed.runId)) ||
      parsed.publisher !== 'fire-and-forget; not measured on response path' ||
      parsed.snapshotOnResponsePath !== false ||
      parsed.phaseSemantics?.liveSessionLockRead !==
        'joinabilityGuardSharedLockAndConditionalParticipantInsert' ||
      parsed.phaseSemantics?.outboxAppend !==
        'transactionalSequenceAllocationAndOutboxInsert' ||
      parsed.architecture?.joinabilitySynchronization !==
        'live_session_for_share_vs_lifecycle_for_update' ||
      parsed.architecture?.sequenceAllocation !==
        'live_session_event_sequence_row' ||
      !parsed.phases ||
      typeof parsed.phases !== 'object'
    )
      return undefined;
    const phases: Record<string, number> = {};
    for (const [key, raw] of Object.entries(parsed.phases)) {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)
        return undefined;
      phases[key] = raw;
    }
    return {
      schemaVersion: 2,
      runId: parsed.runId,
      requestId: parsed.requestId,
      phases,
      phaseSemantics: parsed.phaseSemantics,
      architecture: parsed.architecture,
      publisher: parsed.publisher,
      snapshotOnResponsePath: false,
    };
  } catch {
    return undefined;
  }
}

export interface W1DiagnosticsReport {
  enabled: true;
  clientRequests: ClientDiagnosticRecord[];
  backendRequests: BackendDiagnosticRecord[];
  correlation: {
    received: number;
    matched: number;
    missingBackend: number;
    malformedBackend: number;
    mismatchedRunId: number;
  };
  effectiveClientConcurrency: { peak: number; measured: true };
  phases: Partial<Record<DiagnosticPhase, TimingSummary>>;
  pool: {
    totalCount: number | null;
    idleCount: number | null;
    waitingCount: number | null;
    status: 'unavailable';
    reason: string;
  };
  runtime: {
    client: {
      rssBytes: number;
      cpuUserMicros: number;
      cpuSystemMicros: number;
      eventLoopDelayMs: number | null;
    };
    backend: 'unavailable';
    postgres: 'unavailable';
  };
  attribution: {
    directlyMeasured: string[];
    inferred: string[];
    unavailable: string[];
  };
}

export class W1DiagnosticsCollector {
  private readonly phaseValues = new Map<DiagnosticPhase, number[]>();
  private readonly clientRequests: ClientDiagnosticRecord[] = [];
  private readonly backendRequests: BackendDiagnosticRecord[] = [];
  private readonly clientRequestIds = new Set<string>();
  private inFlight = 0;
  private peak = 0;
  private malformedBackend = 0;
  private mismatchedRunId = 0;
  private readonly startedAt = performance.now();
  private readonly cpuStart = process.cpuUsage();
  private readonly rssStart = process.memoryUsage().rss;

  startRequest(): () => void {
    if (!w1DiagnosticsEnabled) return () => undefined;
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    return () => {
      this.inFlight = Math.max(0, this.inFlight - 1);
    };
  }

  recordClient(requestId: string, durationMs: number): void {
    if (
      !w1DiagnosticsEnabled ||
      !validRequestId(requestId) ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    )
      return;
    this.clientRequests.push({ requestId, durationMs });
    this.clientRequestIds.add(requestId);
  }

  recordBackend(requestId: string, runId: string, header: string | null): void {
    if (!w1DiagnosticsEnabled) return;
    if (!header) {
      this.malformedBackend += 1;
      return;
    }
    const record = parseBackendDiagnosticHeader(header);
    if (!record || record.requestId !== requestId) {
      this.malformedBackend += 1;
      return;
    }
    if (record.runId !== runId) {
      this.mismatchedRunId += 1;
      return;
    }
    this.backendRequests.push(record);
    for (const [phase, durationMs] of Object.entries(record.phases))
      this.record(phase as DiagnosticPhase, durationMs);
  }

  record(phase: DiagnosticPhase, durationMs: number): void {
    if (!w1DiagnosticsEnabled || !Number.isFinite(durationMs) || durationMs < 0)
      return;
    const values = this.phaseValues.get(phase) ?? [];
    values.push(durationMs);
    this.phaseValues.set(phase, values);
  }

  report(): W1DiagnosticsReport | undefined {
    if (!w1DiagnosticsEnabled) return undefined;
    const phases: Partial<Record<DiagnosticPhase, TimingSummary>> = {};
    for (const [phase, values] of this.phaseValues)
      phases[phase] = summarize(values);
    const cpu = process.cpuUsage(this.cpuStart);
    const missingBackend = Math.max(
      0,
      this.clientRequestIds.size - this.backendRequests.length,
    );
    return {
      enabled: true,
      clientRequests: [...this.clientRequests],
      backendRequests: [...this.backendRequests],
      correlation: {
        received: this.backendRequests.length + this.malformedBackend,
        matched: this.backendRequests.length,
        missingBackend,
        malformedBackend: this.malformedBackend,
        mismatchedRunId: this.mismatchedRunId,
      },
      effectiveClientConcurrency: { peak: this.peak, measured: true },
      phases,
      pool: {
        totalCount: null,
        idleCount: null,
        waitingCount: null,
        status: 'unavailable',
        reason:
          'POOL ACQUISITION EVIDENCE GAP: Prisma adapter pool is not exposed by the current application.',
      },
      runtime: {
        client: {
          rssBytes: process.memoryUsage().rss,
          cpuUserMicros: cpu.user,
          cpuSystemMicros: cpu.system,
          eventLoopDelayMs: null,
        },
        backend: 'unavailable',
        postgres: 'unavailable',
      },
      attribution: {
        directlyMeasured: [
          'effective client concurrency',
          'client process RSS and CPU',
          'correlated backend Join phases',
          ...Object.keys(phases),
        ],
        inferred: [
          'Join lifecycle synchronization uses a shared live_session guard that conflicts with lifecycle FOR UPDATE',
          'per-session event ordering remains serialized on live_session_event_sequence',
        ],
        unavailable: [
          'Prisma pool acquisition duration and waitingCount',
          'isolated PostgreSQL lock-wait duration',
          'backend CPU/RSS and PostgreSQL CPU/memory/active connections',
          'event-loop delay',
          'publisher timing before HTTP response',
        ],
      },
    };
  }

  get elapsedMs(): number {
    return performance.now() - this.startedAt;
  }

  get initialRssBytes(): number {
    return this.rssStart;
  }
}
