import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../../../config/env.validation';
import { ManifestExportScheduler } from './manifest-export.scheduler';
import { DeletionManifestExporter } from './deletion-manifest.exporter';

describe('ManifestExportScheduler', () => {
  const makeHarness = (
    overrides: {
      operationsEnabled?: boolean;
      operationEnabled?: boolean;
      schedulerEnabled?: boolean;
      tickMs?: number;
      batchSize?: number;
      exportDueBatch?: jest.Mock;
    } = {},
  ) => {
    const exporter = {
      exportDueBatch:
        overrides.exportDueBatch ??
        jest.fn().mockResolvedValue({ selected: 0, exported: 0, failed: 0 }),
    } as unknown as jest.Mocked<DeletionManifestExporter>;
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'RETENTION_OPERATIONS_ENABLED')
          return overrides.operationsEnabled ?? true;
        if (key === 'RETENTION_MANIFEST_EXPORT_ENABLED')
          return overrides.operationEnabled ?? true;
        if (key === 'RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED')
          return overrides.schedulerEnabled ?? true;
        if (key === 'RETENTION_MANIFEST_EXPORT_TICK_MS')
          return overrides.tickMs ?? 1_000;
        if (key === 'RETENTION_MANIFEST_EXPORT_BATCH_SIZE')
          return overrides.batchSize ?? 50;
        return undefined;
      }),
    } as unknown as ConfigService<EnvConfig>;
    const scheduler = new ManifestExportScheduler(exporter, config);
    return { scheduler, exporter, config };
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
    const { scheduler, exporter, config } = makeHarness({
      schedulerEnabled: false,
    });

    scheduler.onModuleInit();
    await jest.runOnlyPendingTimersAsync();

    expect(config.get).toHaveBeenCalledWith(
      'RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED',
      { infer: true },
    );
    expect(exporter.exportDueBatch).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    await scheduler.onModuleDestroy();
  });

  it.each([
    ['master', { operationsEnabled: false }],
    ['manifest-export operation', { operationEnabled: false }],
  ])(
    'does not start when the %s gate is disabled',
    async (_name, overrides) => {
      const { scheduler, exporter } = makeHarness(overrides);

      scheduler.onModuleInit();
      await jest.runOnlyPendingTimersAsync();

      expect(exporter.exportDueBatch).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      await scheduler.onModuleDestroy();
    },
  );

  it('runs on startup and schedules the configured interval with the batch size', async () => {
    const { scheduler, exporter } = makeHarness({ tickMs: 250, batchSize: 7 });
    exporter.exportDueBatch.mockResolvedValue({
      selected: 2,
      exported: 2,
      failed: 0,
    });

    scheduler.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();
    expect(exporter.exportDueBatch).toHaveBeenCalledWith(7);

    await jest.advanceTimersByTimeAsync(250);
    expect(exporter.exportDueBatch).toHaveBeenCalledTimes(2);
    await scheduler.onModuleDestroy();
  });

  it('does not overlap an in-flight export run', async () => {
    let resolveExport!: (value: {
      selected: number;
      exported: number;
      failed: number;
    }) => void;
    const exportDueBatch = jest.fn(
      () =>
        new Promise<{ selected: number; exported: number; failed: number }>(
          (resolve) => {
            resolveExport = resolve;
          },
        ),
    );
    const { scheduler, exporter } = makeHarness({ exportDueBatch });

    const first = scheduler.runOnce();
    const second = scheduler.runOnce();
    expect(exporter.exportDueBatch).toHaveBeenCalledTimes(1);
    resolveExport({ selected: 1, exported: 1, failed: 0 });
    await Promise.all([first, second]);
    await scheduler.onModuleDestroy();
  });

  it('waits for the current export during shutdown and prevents later runs', async () => {
    let resolveExport!: (value: {
      selected: number;
      exported: number;
      failed: number;
    }) => void;
    const exportDueBatch = jest.fn(
      () =>
        new Promise<{ selected: number; exported: number; failed: number }>(
          (resolve) => {
            resolveExport = resolve;
          },
        ),
    );
    const { scheduler, exporter } = makeHarness({
      exportDueBatch,
      tickMs: 100,
    });

    scheduler.onModuleInit();
    await Promise.resolve();
    const shutdown = scheduler.onModuleDestroy();
    resolveExport({ selected: 1, exported: 0, failed: 1 });
    await shutdown;
    await jest.advanceTimersByTimeAsync(100);

    expect(exporter.exportDueBatch).toHaveBeenCalledTimes(1);
  });

  it('restart performs a startup scan without leaking a second wake source', async () => {
    const { scheduler, exporter } = makeHarness({ tickMs: 250 });
    exporter.exportDueBatch.mockResolvedValue({
      selected: 1,
      exported: 1,
      failed: 0,
    });

    scheduler.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();
    expect(exporter.exportDueBatch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    await scheduler.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);

    scheduler.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();
    expect(exporter.exportDueBatch).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);

    await scheduler.onModuleDestroy();
  });

  it('duplicate init creates no duplicate wake sources', async () => {
    const { scheduler, exporter } = makeHarness({ tickMs: 100 });

    scheduler.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();
    scheduler.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();

    expect(exporter.exportDueBatch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    await scheduler.onModuleDestroy();
  });

  it('repeated destroy cleans up at most once', async () => {
    const { scheduler, exporter } = makeHarness({ tickMs: 100 });

    scheduler.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();
    await scheduler.onModuleDestroy();
    await scheduler.onModuleDestroy();

    expect(jest.getTimerCount()).toBe(0);
    expect(exporter.exportDueBatch).toHaveBeenCalledTimes(1);
  });

  it('logs redacted counts without leaking error details', async () => {
    const { scheduler, exporter } = makeHarness();
    exporter.exportDueBatch.mockResolvedValue({
      selected: 4,
      exported: 2,
      failed: 2,
    });
    const log = jest.spyOn(
      (scheduler as unknown as { logger: { log: (message: string) => void } })
        .logger,
      'log',
    );

    await scheduler.runOnce();

    expect(log).toHaveBeenCalledWith(
      'Manifest export completed: selected=4 exported=2 failed=2',
    );
  });

  it('logs only the error class when an export run fails', async () => {
    const { scheduler, exporter } = makeHarness();
    exporter.exportDueBatch.mockRejectedValue(
      new Error('contains-sensitive-details'),
    );
    const error = jest.spyOn(
      (scheduler as unknown as { logger: { error: (message: string) => void } })
        .logger,
      'error',
    );

    await scheduler.runOnce();

    expect(error).toHaveBeenCalledWith('Manifest export failed: Error');
    expect(error.mock.calls[0]?.[0]).not.toContain(
      'contains-sensitive-details',
    );
  });
});
