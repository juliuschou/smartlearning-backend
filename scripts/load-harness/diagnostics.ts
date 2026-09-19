import { performance } from 'node:perf_hooks';
import { summarize, type TimingSummary } from './metrics';

export const w1DiagnosticsEnabled = process.env.W1_DIAGNOSTICS === '1';

export type DiagnosticPhase =
  | 'findByCode'
  | 'transaction'
  | 'liveSessionLockRead'
  | 'participantInsert'
  | 'sequenceIncrement'
  | 'outboxAppend'
  | 'commit'
  | 'postCommitSnapshot'
  | 'publisher';

export interface ClientDiagnosticRecord {
  requestId: string;
  durationMs: number;
}

export interface W1DiagnosticsReport {
  enabled: true;
  clientRequests: ClientDiagnosticRecord[];
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
  private inFlight = 0;
  private peak = 0;
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
      !/^[A-Za-z0-9-]{1,128}$/.test(requestId) ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    )
      return;
    this.clientRequests.push({ requestId, durationMs });
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
    return {
      enabled: true,
      clientRequests: [...this.clientRequests],
      effectiveClientConcurrency: { peak: this.peak, measured: true },
      phases,
      pool: {
        totalCount: null,
        idleCount: null,
        waitingCount: null,
        status: 'unavailable',
        reason:
          'Prisma adapter pool is not exposed by the current application.',
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
          ...Object.keys(phases),
        ],
        inferred: [
          'shared LiveSession row lock remains architectural constraint',
        ],
        unavailable: [
          'pool totalCount/idleCount/waitingCount',
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
