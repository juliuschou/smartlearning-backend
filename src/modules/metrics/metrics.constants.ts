import type { Registry } from 'prom-client';

export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY');

export const METRIC_NAMES = {
  httpRequests: 'smartlearning_http_requests_total',
  httpRequestDuration: 'smartlearning_http_request_duration_seconds',
  loginRateLimitHits: 'smartlearning_login_rate_limit_hits_total',
  realtimePublishFailures: 'smartlearning_realtime_publish_failures_total',
  jobRuns: 'smartlearning_job_runs_total',
  jobDuration: 'smartlearning_job_duration_seconds',
  jobItems: 'smartlearning_job_items_total',
  readinessDependencyStatus: 'smartlearning_readiness_dependency_status',
  readinessChecks: 'smartlearning_readiness_checks_total',
} as const;

export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'CONNECT',
  'TRACE',
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number] | 'OTHER';

export const STATUS_CLASSES = [
  '1xx',
  '2xx',
  '3xx',
  '4xx',
  '5xx',
  'unknown',
] as const;
export type StatusClass = (typeof STATUS_CLASSES)[number];

export const PUBLISH_OUTCOMES = ['retry', 'dead'] as const;
export type PublishOutcome = (typeof PUBLISH_OUTCOMES)[number];

export const JOB_NAMES = [
  'live_session_auto_close',
  'retention_purge',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

export const JOB_OUTCOMES = ['success', 'failure'] as const;
export type JobOutcome = (typeof JOB_OUTCOMES)[number];

export const JOB_ITEM_RESULTS = [
  'closed',
  'failed',
  'selected',
  'deleted',
] as const;
export type JobItemResult = (typeof JOB_ITEM_RESULTS)[number];

export const READINESS_DEPENDENCIES = [
  'database',
  'realtime_redis',
  'login_rate_limit',
] as const;
export type ReadinessDependency = (typeof READINESS_DEPENDENCIES)[number];

export const READINESS_OUTCOMES = ['healthy', 'unhealthy'] as const;
export type ReadinessOutcome = (typeof READINESS_OUTCOMES)[number];

export const HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

export const JOB_DURATION_BUCKETS = [
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
] as const;

export interface MetricsRegistryProvider {
  provide: typeof METRICS_REGISTRY;
  useFactory: () => Registry;
}
