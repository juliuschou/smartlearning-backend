import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Registry } from 'prom-client';
import { MetricsService } from '../src/modules/metrics/metrics.service';

function selectedMetricLines(output: string): string[] {
  return output
    .split('\n')
    .filter(
      (line) =>
        line.startsWith('smartlearning_') &&
        !line.startsWith('#') &&
        !line.includes('bucket'),
    )
    .slice(0, 20);
}

describe('BE-8.7 CP7 metrics manual verifier', () => {
  it('prints safe metric, readiness, and alert evidence for inspection', async () => {
    const sentinel = 'CP7-SENTINEL-DO-NOT-RETAIN';
    const service = new MetricsService(new Registry());
    service.recordHttpRequest('GET', '/api/v1/courses/:id', 200, 0.02);
    service.recordHttpRequest('POST', '/api/v1/submissions', 500, 0.15);
    service.recordLoginRateLimitHit();
    service.recordRealtimePublishFailure('retry');
    service.recordRealtimePublishFailure('dead');
    service.recordJobItem('live_session_auto_close', 'closed', 3);
    service.recordJobItem('live_session_auto_close', 'failed');
    service.recordJobItem('retention_purge', 'selected', 2);
    service.recordJobItem('retention_purge', 'deleted');
    service.recordJobRun('live_session_auto_close', 'success', 0.1);
    service.recordJobRun('retention_purge', 'failure', 0.3);
    service.recordReadiness('database', true);
    service.recordReadiness('realtime_redis', false);
    service.recordReadiness('login_rate_limit', true);

    const output = await service.getRegistry().metrics();
    const alerts = readFileSync(
      resolve(__dirname, '../ops/observability/prometheus-alerts.yml'),
      'utf8',
    );
    const lines = selectedMetricLines(output);

    expect(output).toContain('smartlearning_http_requests_total');
    expect(output).toContain('route="/api/v1/courses/:id"');
    expect(output).toContain('status_class="5xx"');
    expect(output).toContain('dependency="realtime_redis"');
    expect(alerts).toContain('SmartLearningDatabaseMetricsAbsent');
    expect(alerts).toContain('SmartLearningLoginRateLimitUnhealthy');
    expect(alerts).toContain('SmartLearningRealtimeRedisDegraded');
    expect(`${output}\n${alerts}`).not.toContain(sentinel);
    expect(`${output}\n${alerts}`).not.toMatch(
      /(?:account|request|session|participant)(?:Id|ID)|authorization|cookie|token|hash|query|question|answer/i,
    );

    console.log(`node=${process.version}`);
    console.log(
      'readiness_policy=database:healthy,realtime_redis:degraded,login_rate_limit:healthy',
    );
    console.log(`metric_lines=${JSON.stringify(lines)}`);
    console.log(
      'alert_inventory=database_unhealthy,database_signal_loss,login_rate_limit,realtime_retry,realtime_dead,auto_close,retention,realtime_redis_degraded',
    );
  });
});
