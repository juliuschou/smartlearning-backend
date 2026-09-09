# Retention operations runbook

This runbook covers the local-only Checkpoint 2 retention tooling. It is an operational handoff, not authorization to purge production data.

## Current defaults and scope

- `RETENTION_OPERATIONS_ENABLED` is disabled unless explicitly set to `1` or `true`.
- `RETENTION_PURGE_ENABLED`, `RETENTION_MANIFEST_EXPORT_ENABLED`, and `RETENTION_RECONCILE_APPLY_ENABLED` are independently disabled by default.
- `inspect` and `reconcile-inspect` are read-only. `run-once`, `manifest-export-once`, and `reconcile-apply` are not production workflows: the first two report that execution is intentionally not wired, and reconciliation apply requires its explicit gate.
- The local manifest provider is a test/inspection adapter backed by `RETENTION_LOCAL_MANIFEST_FILE`; it is not an immutable object store and must not be treated as one.

## Safe inspection

Use a compiled build or the repository's normal TypeScript runner in a non-production environment. Do not point inspection at a shared writable path.

```sh
RETENTION_OPERATIONS_ENABLED=1 NODE_ENV=test \
  node dist/src/bootstrap/retention.js inspect

RETENTION_OPERATIONS_ENABLED=1 \
RETENTION_LOCAL_MANIFEST_FILE=/path/to/copied-manifest.json \
  node dist/src/bootstrap/retention.js reconcile-inspect
```

Capture stdout, command environment (excluding secrets), timestamp, operator, and the exact artifact copy used. Do not edit the source manifest during inspection.

## Gates and placeholders

Before any future provider-backed implementation is enabled, require all of the following explicit approvals:

1. target environment and archive scope are recorded;
2. a dry-run report has been reviewed by two operators;
3. retention eligibility, manifest watermark, and idempotency evidence match;
4. an immutable object-store bucket/prefix and retention policy are verified;
5. recovery, audit, and monitoring checks are green;
6. the corresponding operation gate is enabled for that one invocation.

The current `run-once` and `manifest-export-once` commands deliberately stop before DB mutation or external I/O. Do not bypass this by setting an environment variable or calling internal services directly.

## Immutable object-store prerequisites

A real exporter must be added separately and prove: write-once object keys, versioning/object lock or equivalent retention enforcement, encryption and least-privilege credentials, checksum/content-addressed verification, durable upload acknowledgement, retry/dead-letter handling, and a DB-to-object reconciliation record. A local file, ordinary shared filesystem, or mutable bucket without retention enforcement does not satisfy these prerequisites.

## Stop and rollback

Stop immediately on an unexpected scope expansion, malformed manifest, watermark regression, duplicate non-idempotent event, provider timeout without durable acknowledgement, checksum mismatch, or any metric/alert indicating repeated failure. Preserve logs and the read-only report; do not retry a mutating operation blindly.

Rollback for the current tooling is process termination and reverting the code/config change; it has no purge or undelete side effect. A future destructive implementation must provide a provider-specific compensating action, an immutable audit trail, and a tested pause switch before rollout.

## Current blocked production gaps

- No production retention worker is wired to perform the purge.
- No provider-backed immutable object-store exporter is wired.
- No production reconciliation apply path, scheduler deployment, or durable operator audit workflow exists.
- Prometheus/Grafana deployment, alert routing, threshold tuning, and on-call ownership remain OPS-owned.
- Production dry-run, staging purge, backup/restore rehearsal, and W1-W8 capacity evidence are not certified by Checkpoint 2.

Until these gaps are closed under a separately approved change, keep all retention gates disabled and use inspection only.
