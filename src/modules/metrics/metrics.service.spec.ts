import { Registry } from 'prom-client';
import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('registers the fixed metric contract on an application-owned registry', async () => {
    const service = new MetricsService(new Registry());

    const metrics = await service.getRegistry().getMetricsAsJSON();
    expect(metrics.map((metric) => metric.name)).toEqual([
      'smartlearning_http_requests_total',
      'smartlearning_http_request_duration_seconds',
      'smartlearning_login_rate_limit_hits_total',
      'smartlearning_realtime_publish_failures_total',
      'smartlearning_job_runs_total',
      'smartlearning_job_duration_seconds',
      'smartlearning_job_items_total',
      'smartlearning_readiness_dependency_status',
      'smartlearning_readiness_checks_total',
    ]);
    expect(
      metrics.find(
        (metric) => metric.name === 'smartlearning_http_requests_total',
      ),
    ).toMatchObject({
      type: 'counter',
      help: expect.any(String),
    });
    expect(
      metrics.find(
        (metric) =>
          metric.name === 'smartlearning_http_request_duration_seconds',
      ),
    ).toMatchObject({ type: 'histogram' });
  });

  it('keeps registries isolated across application instances', async () => {
    const first = new MetricsService(new Registry());
    const second = new MetricsService(new Registry());

    first.recordLoginRateLimitHit();
    const firstMetric = await first
      .getRegistry()
      .getSingleMetricAsString('smartlearning_login_rate_limit_hits_total');
    const secondMetric = await second
      .getRegistry()
      .getSingleMetricAsString('smartlearning_login_rate_limit_hits_total');

    expect(firstMetric).toContain(
      'smartlearning_login_rate_limit_hits_total 1',
    );
    expect(secondMetric).toContain(
      'smartlearning_login_rate_limit_hits_total 0',
    );
  });

  it('records typed observations and normalizes unsafe HTTP labels', async () => {
    const service = new MetricsService(new Registry());

    service.recordHttpRequest('get', '/courses/:id', 201, 0.025);
    service.recordHttpRequest(
      'CUSTOM',
      '/secret?token=metric-sentinel',
      599,
      0.5,
    );
    service.recordRealtimePublishFailure('retry');
    service.recordRealtimePublishFailure('dead');
    service.recordJobItem('retention_purge', 'selected', 2);
    service.recordJobRun('retention_purge', 'success', 0.2);
    service.recordReadiness('database', true);

    const output = await service.getRegistry().metrics();
    expect(output).toContain('method="GET"');
    expect(output).toContain('route="/courses/:id"');
    expect(output).toContain('method="OTHER"');
    expect(output).toContain('route="__unmatched__"');
    expect(output).toContain('outcome="retry"');
    expect(output).toContain('outcome="dead"');
    expect(output).toContain('job="retention_purge"');
    expect(output).toContain('dependency="database"');
    expect(output).not.toContain('metric-sentinel');
  });

  it('ignores invalid numeric observations and invalid fixed values', async () => {
    const service = new MetricsService(new Registry());

    service.recordHttpRequest('GET', '/invalid', 200, -1);
    service.recordHttpRequest('GET', '/invalid', 200, Number.NaN);
    service.recordJobRun(
      'retention_purge',
      'success',
      Number.POSITIVE_INFINITY,
    );
    service.recordJobItem('retention_purge', 'deleted', 0);
    service.recordRealtimePublishFailure('invalid' as never);
    service.recordJobItem('retention_purge', 'invalid' as never);
    service.recordReadiness('invalid' as never, true);

    const output = await service.getRegistry().metrics();
    expect(output).not.toContain('route="/invalid"');
    expect(output).not.toContain('job="retention_purge"');
    expect(output).not.toContain('dependency="invalid"');
  });

  it('contains collector exceptions', () => {
    const service = new MetricsService(new Registry());
    const counter = service as unknown as {
      loginRateLimitHits: { inc: () => void };
    };
    counter.loginRateLimitHits.inc = () => {
      throw new Error('collector sentinel');
    };

    expect(() => service.recordLoginRateLimitHit()).not.toThrow();
  });
});
