import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../../../config/env.validation';
import { MetricsService } from '../../metrics/metrics.service';
import { RetentionScheduler } from './retention.scheduler';
import { GovernanceService } from './governance.service';

describe('RetentionScheduler', () => {
  const makeHarness = (
    overrides: {
      operationsEnabled?: boolean;
      operationEnabled?: boolean;
      schedulerEnabled?: boolean;
      tickMs?: number;
      batchSize?: number;
      purgeDue?: jest.Mock;
      inspectDue?: jest.Mock;
    } = {},
  ) => {
    const governance = {
      purgeDue:
        overrides.purgeDue ??
        jest.fn().mockResolvedValue({ selected: 0, deleted: 0, failed: 0 }),
      inspectDue:
        overrides.inspectDue ??
        jest.fn().mockResolvedValue({ dueCount: 0, oldestDueAgeSeconds: 0 }),
    } as unknown as jest.Mocked<GovernanceService>;
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'RETENTION_OPERATIONS_ENABLED')
          return overrides.operationsEnabled ?? true;
        if (key === 'RETENTION_PURGE_ENABLED')
          return overrides.operationEnabled ?? true;
        if (key === 'RETENTION_PURGE_SCHEDULER_ENABLED')
          return overrides.schedulerEnabled ?? true;
        if (key === 'RETENTION_PURGE_TICK_MS') return overrides.tickMs ?? 1_000;
        if (key === 'RETENTION_PURGE_BATCH_SIZE')
          return overrides.batchSize ?? 50;
        return undefined;
      }),
    } as unknown as ConfigService<EnvConfig>;
    const metrics = {
      recordRetentionDueBacklog: jest.fn(),
    } as unknown as MetricsService;
    const scheduler = new RetentionScheduler(governance, config, metrics);
    return { scheduler, governance, config, metrics };
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('does not start when the scheduler gate is disabled', async () => {
    const { scheduler, governance, config } = makeHarness({
      schedulerEnabled: false,
    });

    scheduler.onModuleInit();
    await jest.runOnlyPendingTimersAsync();

    expect(config.get).toHaveBeenCalledWith(
      'RETENTION_PURGE_SCHEDULER_ENABLED',
      { infer: true },
    );
    expect(governance.purgeDue).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    await scheduler.onModuleDestroy();
  });

  it.each([
    ['master', { operationsEnabled: false }],
    ['purge operation', { operationEnabled: false }],
  ])(
    'does not start when the %s gate is disabled',
    async (_name, overrides) => {
      const { scheduler, governance } = makeHarness(overrides);

      scheduler.onModuleInit();
      await jest.runOnlyPendingTimersAsync();

      expect(governance.purgeDue).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      await scheduler.onModuleDestroy();
    },
  );

  it('runs on startup and schedules the configured interval', async () => {
    const { scheduler, governance, metrics } = makeHarness({
      tickMs: 250,
      batchSize: 7,
    });
    governance.purgeDue.mockResolvedValue({
      selected: 2,
      deleted: 2,
      failed: 0,
    });
    governance.inspectDue.mockResolvedValue({
      observedAt: '2026-09-09T00:00:00.000Z',
      dueCount: 3,
      oldestDueAt: '2026-09-08T23:59:48.000Z',
      oldestDueAgeSeconds: 12,
      sample: [],
    });

    scheduler.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();
    expect(governance.purgeDue).toHaveBeenCalledWith(7);
    expect(metrics.recordRetentionDueBacklog).toHaveBeenCalledWith(3, 12);

    await jest.advanceTimersByTimeAsync(250);
    expect(governance.purgeDue).toHaveBeenCalledTimes(2);
    await scheduler.onModuleDestroy();
  });

  it('does not overlap an in-flight sweep', async () => {
    let resolvePurge!: (value: {
      selected: number;
      deleted: number;
      failed: number;
    }) => void;
    const purgeDue = jest.fn(
      () =>
        new Promise<{ selected: number; deleted: number; failed: number }>(
          (resolve) => {
            resolvePurge = resolve;
          },
        ),
    );
    const { scheduler, governance } = makeHarness({ purgeDue });

    const first = scheduler.runOnce();
    const second = scheduler.runOnce();
    expect(governance.purgeDue).toHaveBeenCalledTimes(1);
    resolvePurge({ selected: 1, deleted: 1, failed: 0 });
    await Promise.all([first, second]);
    await scheduler.onModuleDestroy();
  });

  it('waits for the current sweep during shutdown and prevents later runs', async () => {
    let resolvePurge!: (value: {
      selected: number;
      deleted: number;
      failed: number;
    }) => void;
    const purgeDue = jest.fn(
      () =>
        new Promise<{ selected: number; deleted: number; failed: number }>(
          (resolve) => {
            resolvePurge = resolve;
          },
        ),
    );
    const { scheduler, governance } = makeHarness({ purgeDue, tickMs: 100 });

    scheduler.onModuleInit();
    await Promise.resolve();
    const shutdown = scheduler.onModuleDestroy();
    resolvePurge({ selected: 1, deleted: 1, failed: 0 });
    await shutdown;
    await jest.advanceTimersByTimeAsync(100);

    expect(governance.purgeDue).toHaveBeenCalledTimes(1);
  });

  it('passes failed counts to the completion log without leaking error details', async () => {
    const { scheduler, governance } = makeHarness();
    governance.purgeDue.mockResolvedValue({
      selected: 4,
      deleted: 2,
      failed: 2,
    });
    const log = jest.spyOn(
      (scheduler as unknown as { logger: { log: (message: string) => void } })
        .logger,
      'log',
    );

    await scheduler.runOnce();

    expect(log).toHaveBeenCalledWith(
      'Retention sweep completed: selected=4 deleted=2 failed=2',
    );
  });

  it('logs only the error class when a sweep fails', async () => {
    const { scheduler, governance } = makeHarness();
    governance.purgeDue.mockRejectedValue(
      new Error('contains-sensitive-details'),
    );
    const error = jest.spyOn(
      (scheduler as unknown as { logger: { error: (message: string) => void } })
        .logger,
      'error',
    );

    await scheduler.runOnce();

    expect(error).toHaveBeenCalledWith('Retention sweep failed: Error');
    expect(error.mock.calls[0]?.[0]).not.toContain(
      'contains-sensitive-details',
    );
  });
});
