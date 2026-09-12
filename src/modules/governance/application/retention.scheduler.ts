import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../../../config/env.validation';
import { GovernanceService } from './governance.service';
import { MetricsService } from '../../metrics/metrics.service';

@Injectable()
export class RetentionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionScheduler.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private destroyed = false;

  constructor(
    private readonly governance: GovernanceService,
    private readonly config: ConfigService<EnvConfig>,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    this.destroyed = false;
    if (
      !this.config.get('RETENTION_OPERATIONS_ENABLED', { infer: true }) ||
      !this.config.get('RETENTION_PURGE_ENABLED', { infer: true }) ||
      !this.config.get('RETENTION_PURGE_SCHEDULER_ENABLED', { infer: true })
    )
      return;
    void this.runOnce();
    const interval = Number(
      this.config.get('RETENTION_PURGE_TICK_MS', { infer: true }) ?? 900_000,
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
      this.config.get('RETENTION_PURGE_BATCH_SIZE', { infer: true }) ?? 50,
    );
    this.running = this.governance
      .purgeDue(batchSize)
      .then(async (result) => {
        this.logger.log(
          `Retention sweep completed: selected=${result.selected} deleted=${result.deleted} failed=${result.failed}`,
        );
        const due = await this.governance.inspectDue();
        this.metrics?.recordRetentionDueBacklog(
          due.dueCount,
          due.oldestDueAgeSeconds,
        );
        const manifest = await this.governance.inspectManifestDelivery();
        this.metrics?.recordRetentionManifestLag(manifest.manifestLagSeconds);
        this.metrics?.recordRetentionManifestDeadRecords(
          manifest.manifestDeadRecords,
        );
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Retention sweep failed: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    await this.running;
  }
}
