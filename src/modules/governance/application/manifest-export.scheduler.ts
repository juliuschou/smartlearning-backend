import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../../../config/env.validation';
import { DeletionManifestExporter } from './deletion-manifest.exporter';

/**
 * Independent scheduler for draining immutable deletion manifests to the
 * configured provider. It is fully decoupled from the purge-loop
 * `RetentionScheduler`: own enable/tick/batch, own no-overlap guard, own
 * shutdown drain. Cross-replica safety remains the outbox PostgreSQL lease,
 * not process memory. Export pass/failure job metrics are recorded by
 * `DeletionManifestExporter` itself, mirroring how `GovernanceService` owns
 * the purge-loop metrics.
 *
 * Disabled by default; production additionally requires a durable S3 provider
 * (enforced in `validateEnv`).
 */
@Injectable()
export class ManifestExportScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ManifestExportScheduler.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private destroyed = false;

  constructor(
    private readonly exporter: DeletionManifestExporter,
    private readonly config: ConfigService<EnvConfig>,
  ) {}

  onModuleInit(): void {
    this.destroyed = false;
    if (!this.config.get('RETENTION_MANIFEST_EXPORT_ENABLED', { infer: true }))
      return;
    void this.runOnce();
    const interval = Number(
      this.config.get('RETENTION_MANIFEST_EXPORT_TICK_MS', { infer: true }) ??
        900_000,
    );
    this.timer = setInterval(() => void this.runOnce(), interval);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async runOnce(): Promise<void> {
    if (this.destroyed || this.running) return;
    const batchSize = Number(
      this.config.get('RETENTION_MANIFEST_EXPORT_BATCH_SIZE', {
        infer: true,
      }) ?? 50,
    );
    this.running = this.exporter
      .exportDueBatch(batchSize)
      .then((result) => {
        this.logger.log(
          `Manifest export completed: selected=${result.selected} exported=${result.exported} failed=${result.failed}`,
        );
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Manifest export failed: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    await this.running;
  }
}
