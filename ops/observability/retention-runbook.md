# Retention operations runbook

This runbook covers the retention worker operation tooling. The purge and manifest-export workers are wired and execute behind explicit (default-disabled) gates; this document is an operational handoff, not authorization to purge production data.

## Current defaults and scope

- `RETENTION_OPERATIONS_ENABLED` is disabled unless explicitly set to `1` or `true`.
- `RETENTION_PURGE_ENABLED`, `RETENTION_MANIFEST_EXPORT_ENABLED`, and `RETENTION_RECONCILE_APPLY_ENABLED` authorize individual operations and are independently disabled by default.
- `RETENTION_PURGE_SCHEDULER_ENABLED` and `RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED` separately authorize recurring scheduler startup and are disabled by default. Enabling an operation does **not** authorize its scheduler; a scheduler requires the master `RETENTION_OPERATIONS_ENABLED` gate and its matching operation gate or environment validation fails.
- `inspect`, `dry-run`, and `reconcile-inspect` are read-only. `run-once`, `manifest-export-once`, and `reconcile-apply` are destructive/networked operator workflows: they execute only behind their explicit per-operation gates (`RETENTION_PURGE_ENABLED`, `RETENTION_MANIFEST_EXPORT_ENABLED`, `RETENTION_RECONCILE_APPLY_ENABLED`, each additionally gated by `RETENTION_OPERATIONS_ENABLED`). All gates are disabled by default.
- Each scheduler has its own tunables: purge uses `RETENTION_PURGE_TICK_MS`, `RETENTION_PURGE_BATCH_SIZE`, `RETENTION_PURGE_LEASE_MS`, and `RETENTION_PURGE_MAX_ATTEMPTS`; manifest export uses `RETENTION_MANIFEST_EXPORT_TICK_MS` and `RETENTION_MANIFEST_EXPORT_BATCH_SIZE`. Production requires a durable S3 manifest provider before either operation is enabled (`DELETION_MANIFEST_PROVIDER=s3`).
- The local manifest provider is a test/inspection adapter backed by `RETENTION_LOCAL_MANIFEST_FILE`; it is not an immutable object store and must not be treated as one.
- Upgrade note: deployments that previously used only `RETENTION_PURGE_ENABLED` or `RETENTION_MANIFEST_EXPORT_ENABLED` for recurring loops must explicitly add the matching scheduler gate and `RETENTION_OPERATIONS_ENABLED`. Omission intentionally leaves the loop stopped; verify expected-run alerts after rollout.

## Alert guidance

- `SmartLearningRetentionPurgeJobFailing` / `SmartLearningRetentionManifestExportJobFailing`: a worker reports repeated run failures — inspect scheduler logs and the redacted exit output before retrying.
- `SmartLearningRetentionPurgeQuarantined`: any archive reached the quarantined state, meaning it could not be purged within its retry budget. Stop the purge loop and investigate the stable failure code before proceeding.
- `SmartLearningRetentionPurgeNoRecentSuccess`: the purge loop has not completed a successful run recently (last-success stamp is stale or absent). This is a missing-expected-run signal, distinct from a backlog gauge.

## Safe inspection

Use a compiled build or the repository's normal TypeScript runner in a non-production environment. Do not point inspection at a shared writable path.

```sh
RETENTION_OPERATIONS_ENABLED=1 NODE_ENV=test \
  node dist/src/bootstrap/retention.js inspect

# Execution-equivalent, write-free deletion plan (per-archive per-category counts)
RETENTION_OPERATIONS_ENABLED=1 RETENTION_PURGE_BATCH_SIZE=50 NODE_ENV=test \
  node dist/src/bootstrap/retention.js dry-run

RETENTION_OPERATIONS_ENABLED=1 \
RETENTION_LOCAL_MANIFEST_FILE=/path/to/copied-manifest.json \
  node dist/src/bootstrap/retention.js reconcile-inspect
```

`dry-run` shares the same eligibility/ordering/plan predicates as a real purge but performs **no writes and no
provider calls**; its per-category counts equal what `run-once` would delete on unchanged fixtures. Capture stdout,
command environment (excluding secrets), timestamp, operator, and the exact artifact copy used. Do not edit the
source manifest during inspection.

## Gates and placeholders

Before any future provider-backed implementation is enabled, require all of the following explicit approvals:

1. target environment and archive scope are recorded;
2. a dry-run report has been reviewed by two operators;
3. retention eligibility, manifest watermark, and idempotency evidence match;
4. an immutable object-store bucket/prefix and retention policy are verified;
5. recovery, audit, and monitoring checks are green;
6. the corresponding operation gate is enabled for that one invocation.

`run-once` and `manifest-export-once` execute their destructive/networked operations when both `RETENTION_OPERATIONS_ENABLED` and the relevant per-operation gate (`RETENTION_PURGE_ENABLED` / `RETENTION_MANIFEST_EXPORT_ENABLED`) are set. The operator CLI forces both scheduler-specific gates false before booting `AppModule`, so read-only and one-shot commands cannot trigger startup sweeps; keep them false in the command profile as an explicit audit control. Do not enable any operation or scheduler in production without the immutable-object-store prerequisites below and explicit two-operator sign-off.

### Batch-size-1 staging canary profile

Use a dedicated one-shot process from the exact deployed artifact. Do not change the long-running backend's scheduler configuration.

```sh
RETENTION_OPERATIONS_ENABLED=1 \
RETENTION_PURGE_ENABLED=true \
RETENTION_PURGE_SCHEDULER_ENABLED=false \
RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED=false \
RETENTION_PURGE_BATCH_SIZE=1 \
  node dist/src/bootstrap/retention.js run-once

RETENTION_OPERATIONS_ENABLED=1 \
RETENTION_MANIFEST_EXPORT_ENABLED=true \
RETENTION_PURGE_SCHEDULER_ENABLED=false \
RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED=false \
RETENTION_MANIFEST_EXPORT_BATCH_SIZE=1 \
  node dist/src/bootstrap/retention.js manifest-export-once
```

Immediately before each mutation, repeat the read-only selection check. Stop unless the dry-run selects exactly the reviewed synthetic archive and no unrelated item can precede it. Afterward, return every operation and scheduler gate to false and observe at least one scheduler tick plus alert evaluation delay; no additional run may occur.

## Immutable object-store prerequisites

A real exporter must be added separately and prove: write-once object keys, versioning/object lock or equivalent retention enforcement, encryption and least-privilege credentials, checksum/content-addressed verification, durable upload acknowledgement, retry/dead-letter handling, and a DB-to-object reconciliation record. A local file, ordinary shared filesystem, or mutable bucket without retention enforcement does not satisfy these prerequisites.

## Stop and rollback

Stop immediately on an unexpected scope expansion, malformed manifest, watermark regression, duplicate non-idempotent event, provider timeout without durable acknowledgement, checksum mismatch, or any metric/alert indicating repeated failure. Preserve logs and the read-only report; do not retry a mutating operation blindly.

Rollback for the current tooling is process termination and reverting the code/config change; it has no purge or undelete side effect. A future destructive implementation must provide a provider-specific compensating action, an immutable audit trail, and a tested pause switch before rollout.

## Current blocked production gaps

- The purge and manifest-export workers are wired (schedulers + CLI) but **not production-authorized or enabled**; a production rollout that enables them requires separate approval plus provider/alert/staging evidence (BE-5.2 Checkpoint G).
- No provider-backed immutable object-store exporter is configured for production (`DELETION_MANIFEST_PROVIDER=local` is the default and is rejected in production).
- No production reconciliation apply path, scheduler deployment, or durable operator audit workflow exists.
- Prometheus/Grafana deployment, alert routing, threshold tuning, and on-call ownership remain OPS-owned.
- Production dry-run, staging purge, backup/restore rehearsal, and W1-W8 capacity evidence are not certified by Checkpoint 2.

Until these gaps are closed under a separately approved change, keep all retention gates disabled and use inspection/dry-run only.
