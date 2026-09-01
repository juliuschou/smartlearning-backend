import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const alertsPath = resolve(
  __dirname,
  '../../../ops/observability/prometheus-alerts.yml',
);

describe('CP7 observability artifacts', () => {
  it('contains the required alert inventory and safe metric references', () => {
    const source = readFileSync(alertsPath, 'utf8');
    for (const alert of [
      'SmartLearningHttp5xxRatioHigh',
      'SmartLearningDatabaseReadinessUnhealthy',
      'SmartLearningDatabaseMetricsAbsent',
      'SmartLearningLoginRateLimitHitsHigh',
      'SmartLearningLoginRateLimitUnhealthy',
      'SmartLearningRealtimePublishRetries',
      'SmartLearningRealtimePublishDeadLetters',
      'SmartLearningRealtimeRedisDegraded',
      'SmartLearningAutoCloseJobFailing',
      'SmartLearningRetentionPurgeJobFailing',
    ]) {
      expect(source).toContain(`alert: ${alert}`);
    }
    for (const metric of [
      'smartlearning_http_requests_total',
      'smartlearning_login_rate_limit_hits_total',
      'smartlearning_realtime_publish_failures_total',
      'smartlearning_job_runs_total',
      'smartlearning_readiness_dependency_status',
    ]) {
      expect(source).toContain(metric);
    }
    expect(source.match(/\n\s+for:/g)?.length).toBeGreaterThanOrEqual(10);
    expect(source).toContain('severity: critical');
    expect(source).toContain('severity: warning');
    expect(source).toContain('summary:');
    expect(source).not.toMatch(
      /\b(accountId|requestId|sessionId|participantId|token|hash|query)\b/,
    );
  });

  it('documents the frozen endpoint and mode-specific readiness handoff', () => {
    const readme = readFileSync(
      resolve(__dirname, '../../../ops/observability/README.md'),
      'utf8',
    );
    const dashboard = readFileSync(
      resolve(__dirname, '../../../ops/observability/dashboard-inventory.md'),
      'utf8',
    );
    expect(readme).toContain('GET /metrics');
    expect(readme).toContain('external services');
    expect(readme).toContain('login_rate_limit');
    expect(readme).toContain('realtime_redis');
    expect(dashboard).toContain('p50');
    expect(dashboard).toContain('p95');
    expect(dashboard).toContain('p99');
    expect(dashboard).toContain('PromQL');
  });
});
