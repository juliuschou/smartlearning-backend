import { Inject, Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import {
  HTTP_DURATION_BUCKETS,
  HTTP_METHODS,
  JOB_DURATION_BUCKETS,
  JOB_ITEM_RESULTS,
  JOB_NAMES,
  JOB_OUTCOMES,
  METRIC_NAMES,
  METRICS_REGISTRY,
  PUBLISH_OUTCOMES,
  READINESS_DEPENDENCIES,
  STATUS_CLASSES,
  type JobItemResult,
  type JobName,
  type JobOutcome,
  type PublishOutcome,
  type ReadinessDependency,
  type ReadinessOutcome,
} from './metrics.constants';

@Injectable()
export class MetricsService {
  private readonly httpRequests: Counter<string>;
  private readonly httpRequestDuration: Histogram<string>;
  private readonly loginRateLimitHits: Counter<string>;
  private readonly realtimePublishFailures: Counter<string>;
  private readonly jobRuns: Counter<string>;
  private readonly jobDuration: Histogram<string>;
  private readonly jobItems: Counter<string>;
  private readonly readinessDependencyStatus: Gauge<string>;
  private readonly readinessChecks: Counter<string>;
  private readonly retentionDueBacklog: Gauge<string>;
  private readonly retentionOldestDueAgeSeconds: Gauge<string>;
  private readonly retentionManifestLagSeconds: Gauge<string>;
  private readonly retentionManifestDeadRecords: Gauge<string>;
  private readonly retentionReconciliationFailures: Counter<string>;
  private readonly retentionPurgeLastSuccessSeconds: Gauge<string>;

  constructor(@Inject(METRICS_REGISTRY) private readonly registry: Registry) {
    this.httpRequests = new Counter({
      name: METRIC_NAMES.httpRequests,
      help: 'Completed HTTP requests by safe route template and status class.',
      labelNames: ['method', 'route', 'status_class'],
      registers: [registry],
    });
    this.httpRequestDuration = new Histogram({
      name: METRIC_NAMES.httpRequestDuration,
      help: 'HTTP request duration in seconds.',
      labelNames: ['method', 'route', 'status_class'],
      buckets: [...HTTP_DURATION_BUCKETS],
      registers: [registry],
    });
    this.loginRateLimitHits = new Counter({
      name: METRIC_NAMES.loginRateLimitHits,
      help: 'Login rate-limit decisions that rejected a request.',
      registers: [registry],
    });
    this.realtimePublishFailures = new Counter({
      name: METRIC_NAMES.realtimePublishFailures,
      help: 'Durable realtime publish failures persisted for retry or dead-letter.',
      labelNames: ['outcome'],
      registers: [registry],
    });
    this.jobRuns = new Counter({
      name: METRIC_NAMES.jobRuns,
      help: 'Background job runs by fixed job and outcome.',
      labelNames: ['job', 'outcome'],
      registers: [registry],
    });
    this.jobDuration = new Histogram({
      name: METRIC_NAMES.jobDuration,
      help: 'Background job duration in seconds.',
      labelNames: ['job', 'outcome'],
      buckets: [...JOB_DURATION_BUCKETS],
      registers: [registry],
    });
    this.jobItems = new Counter({
      name: METRIC_NAMES.jobItems,
      help: 'Background job items by fixed job and result.',
      labelNames: ['job', 'result'],
      registers: [registry],
    });
    this.readinessDependencyStatus = new Gauge({
      name: METRIC_NAMES.readinessDependencyStatus,
      help: 'Latest observed dependency readiness, one for healthy.',
      labelNames: ['dependency'],
      registers: [registry],
    });
    this.readinessChecks = new Counter({
      name: METRIC_NAMES.readinessChecks,
      help: 'Readiness checks by dependency and observed outcome.',
      labelNames: ['dependency', 'outcome'],
      registers: [registry],
    });
    this.retentionDueBacklog = new Gauge({
      name: METRIC_NAMES.retentionDueBacklog,
      help: 'Current count of active archives due for retention purge.',
      registers: [registry],
    });
    this.retentionOldestDueAgeSeconds = new Gauge({
      name: METRIC_NAMES.retentionOldestDueAgeSeconds,
      help: 'Age in seconds of the oldest archive due for retention purge.',
      registers: [registry],
    });
    this.retentionManifestLagSeconds = new Gauge({
      name: METRIC_NAMES.retentionManifestLagSeconds,
      help: 'Seconds since the oldest un-exported deletion manifest became due.',
      registers: [registry],
    });
    this.retentionManifestDeadRecords = new Gauge({
      name: METRIC_NAMES.retentionManifestDeadRecords,
      help: 'Deletion manifest outbox records in the dead state.',
      registers: [registry],
    });
    this.retentionReconciliationFailures = new Counter({
      name: METRIC_NAMES.retentionReconciliationFailures,
      help: 'Retention reconciliation runs that reported a failure outcome.',
      registers: [registry],
    });
    this.retentionPurgeLastSuccessSeconds = new Gauge({
      name: METRIC_NAMES.retentionPurgeLastSuccessSeconds,
      help: 'Unix epoch seconds of the last successful retention purge run; 0 until one succeeds.',
      registers: [registry],
    });
  }

  getRegistry(): Registry {
    return this.registry;
  }

  recordHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
  ): void {
    if (!isNonNegativeFinite(durationSeconds)) return;
    const labels = {
      method: normalizeMethod(method),
      route: normalizeRoute(route),
      status_class: normalizeStatusClass(statusCode),
    };
    this.tryRecord(() => {
      this.httpRequests.inc(labels);
      this.httpRequestDuration.observe(labels, durationSeconds);
    });
  }

  recordLoginRateLimitHit(): void {
    this.tryRecord(() => this.loginRateLimitHits.inc());
  }

  recordRealtimePublishFailure(outcome: PublishOutcome): void {
    if (!PUBLISH_OUTCOMES.includes(outcome)) return;
    this.tryRecord(() => this.realtimePublishFailures.inc({ outcome }));
  }

  recordJobRun(
    job: JobName,
    outcome: JobOutcome,
    durationSeconds: number,
  ): void {
    if (
      !JOB_NAMES.includes(job) ||
      !JOB_OUTCOMES.includes(outcome) ||
      !isNonNegativeFinite(durationSeconds)
    )
      return;
    this.tryRecord(() => {
      this.jobRuns.inc({ job, outcome });
      this.jobDuration.observe({ job, outcome }, durationSeconds);
    });
  }

  recordJobItem(job: JobName, result: JobItemResult, count = 1): void {
    if (
      !JOB_NAMES.includes(job) ||
      !JOB_ITEM_RESULTS.includes(result) ||
      !isPositiveFinite(count)
    )
      return;
    this.tryRecord(() => this.jobItems.inc({ job, result }, count));
  }

  recordRetentionDueBacklog(count: number, oldestDueAgeSeconds: number): void {
    if (
      !isNonNegativeFinite(count) ||
      !isNonNegativeFinite(oldestDueAgeSeconds)
    )
      return;
    this.tryRecord(() => {
      this.retentionDueBacklog.set(Math.floor(count));
      this.retentionOldestDueAgeSeconds.set(oldestDueAgeSeconds);
    });
  }

  recordRetentionManifestLag(lagSeconds: number): void {
    if (!isNonNegativeFinite(lagSeconds)) return;
    this.tryRecord(() =>
      this.retentionManifestLagSeconds.set(Math.floor(lagSeconds)),
    );
  }

  recordRetentionManifestDeadRecords(count: number): void {
    if (!isNonNegativeFinite(count)) return;
    this.tryRecord(() =>
      this.retentionManifestDeadRecords.set(Math.floor(count)),
    );
  }

  /** Stamp the epoch seconds of the last successful purge run for staleness alerts. */
  recordRetentionPurgeLastSuccess(epochSeconds: number): void {
    if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return;
    this.tryRecord(() =>
      this.retentionPurgeLastSuccessSeconds.set(Math.floor(epochSeconds)),
    );
  }

  recordRetentionReconciliationFailure(count = 1): void {
    if (!isNonNegativeFinite(count) || count <= 0) return;
    this.tryRecord(() => this.retentionReconciliationFailures.inc(count));
  }

  recordReadiness(dependency: ReadinessDependency, healthy: boolean): void {
    if (!READINESS_DEPENDENCIES.includes(dependency)) return;
    const outcome: ReadinessOutcome = healthy ? 'healthy' : 'unhealthy';
    this.tryRecord(() => {
      this.readinessDependencyStatus.set({ dependency }, healthy ? 1 : 0);
      this.readinessChecks.inc({ dependency, outcome });
    });
  }

  private tryRecord(operation: () => void): void {
    try {
      operation();
    } catch {
      // Metrics are deliberately best-effort and never part of domain control flow.
    }
  }
}

function normalizeMethod(method: string): string {
  const normalized = typeof method === 'string' ? method.toUpperCase() : '';
  return HTTP_METHODS.includes(normalized as (typeof HTTP_METHODS)[number])
    ? normalized
    : 'OTHER';
}

function normalizeRoute(route: string): string {
  if (
    typeof route !== 'string' ||
    route.length === 0 ||
    route.length > 256 ||
    !route.startsWith('/') ||
    route.includes('?') ||
    route.includes('#') ||
    route.includes('*') ||
    route.includes('{') ||
    route.includes('}') ||
    Array.from(route).some(
      (char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f,
    )
  )
    return '__unmatched__';
  return route;
}

function normalizeStatusClass(statusCode: number): string {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)
    return 'unknown';
  const statusClass = `${Math.floor(statusCode / 100)}xx`;
  return STATUS_CLASSES.includes(statusClass as (typeof STATUS_CLASSES)[number])
    ? statusClass
    : 'unknown';
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
