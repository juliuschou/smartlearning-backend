import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('retention operational artifacts', () => {
  const root = resolve(__dirname, '..');
  const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

  it('defines alerts for retention backlog, repeated failures, manifests, and reconciliation', () => {
    const alerts = read('ops/observability/prometheus-alerts.yml');
    for (const alert of [
      'SmartLearningRetentionOldestDueAgeHigh',
      'SmartLearningRetentionDueBacklogHigh',
      'SmartLearningRetentionPurgeJobFailing',
      'SmartLearningRetentionPurgeQuarantined',
      'SmartLearningRetentionManifestExportJobFailing',
      'SmartLearningRetentionPurgeNoRecentSuccess',
      'SmartLearningRetentionManifestLagHigh',
      'SmartLearningRetentionManifestDeadRecords',
      'SmartLearningRetentionReconciliationFailing',
    ]) {
      expect(alerts).toContain(`alert: ${alert}`);
    }
    expect(alerts).toContain('smartlearning_retention_manifest_lag_seconds');
    expect(alerts).toContain('smartlearning_retention_manifest_dead_records');
    expect(alerts).toContain(
      'smartlearning_retention_reconciliation_failures_total',
    );
  });

  it('keeps dashboard handoff and runbook aligned with safety boundaries', () => {
    const dashboard = read('ops/observability/dashboard-inventory.md');
    const runbook = read('ops/observability/retention-runbook.md');
    expect(dashboard).toContain('Retention oldest due age');
    expect(dashboard).toContain('Manifest lag');
    expect(dashboard).toContain('Manifest dead records');
    expect(dashboard).toContain('Reconciliation failures');
    for (const gate of [
      'RETENTION_OPERATIONS_ENABLED',
      'RETENTION_PURGE_ENABLED',
      'RETENTION_MANIFEST_EXPORT_ENABLED',
      'RETENTION_RECONCILE_APPLY_ENABLED',
    ]) {
      expect(runbook).toContain(gate);
    }
    expect(runbook).toContain('immutable object-store');
    expect(runbook).toContain('keep all retention gates disabled');
    expect(runbook).toContain('not production-authorized or enabled');
    expect(runbook).toContain('dry-run');
    expect(runbook).toContain('RETENTION_MANIFEST_EXPORT_BATCH_SIZE');
  });
});
