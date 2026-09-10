import { readFile } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { GovernanceService } from '../src/modules/governance/application/governance.service';
import { MetricsService } from '../src/modules/metrics/metrics.service';
import { RetentionReconciliationService } from '../src/modules/governance/application/retention-reconciliation';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  try {
    const governance = app.get(GovernanceService);
    const metrics = app.get(MetricsService);

    const due = await governance.inspectDue();
    const manifest = await governance.inspectManifestDelivery();
    metrics.recordRetentionDueBacklog(due.dueCount, due.oldestDueAgeSeconds);
    metrics.recordRetentionManifestLag(manifest.manifestLagSeconds);
    metrics.recordRetentionManifestDeadRecords(manifest.manifestDeadRecords);

    // Reconciliation failure rehearsal: apply a malformed local manifest in
    // the same process that owns the registry (a refused apply must count).
    const localManifestFile = process.env.RETENTION_LOCAL_MANIFEST_FILE;
    if (localManifestFile) {
      const store = JSON.parse(await readFile(localManifestFile, 'utf8')) as {
        manifests: unknown[];
        watermark?: unknown;
      };
      const service = new RetentionReconciliationService({
        list: async () => store.manifests,
        watermark: async () => store.watermark,
        saveWatermark: async () => undefined,
        applyManifest: async () => undefined,
      });
      try {
        await service.apply();
      } catch {
        metrics.recordRetentionReconciliationFailure();
      }
    }

    const out = await metrics.getRegistry().metrics();
    const wanted = [
      'smartlearning_retention_due_backlog',
      'smartlearning_retention_oldest_due_age_seconds',
      'smartlearning_retention_manifest_lag_seconds',
      'smartlearning_retention_manifest_dead_records',
      'smartlearning_retention_reconciliation_failures_total',
    ];
    for (const line of out.split('\n')) {
      if (wanted.some((n) => line.startsWith(n))) console.log(line);
    }
  } finally {
    await app.close();
  }
}
void main();
