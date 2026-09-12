# BE-5.2 Checkpoint G step 5 — staging canary replica runbook

**Status: DRAFT — files only, never started.** Every command below requires
explicit user authorization; this document is not an authorization.

This stack gives the Checkpoint G step 5 canary an **identifiable local
staging replica**: dedicated compose project, network, container-name prefix
(`staging-replica-*`), host ports (DB 15432, backend 13000, MinIO 19010/19011,
Prometheus 19090, Alertmanager 19093, webhook 13999), and database name
(`smartlearning_staging_replica`). No other stack shares any of these. It is
**not production and not the real staging host**; evidence produced here
closes the "no identifiable staging target" preflight at the replica level,
and any claim to production readiness still requires the real staging host and
final reconciliation.

## Identity / provenance to record BEFORE starting

- Exact source revision deployed: `git rev-parse HEAD` at `docker compose build`
  time (expect a clean tree — `git status --porcelain` empty except this
  toolkit's untracked files).
- Expected env identity: `DB_NAME=smartlearning_staging_replica`, `NODE_ENV=production`,
  `CORS_ORIGIN=http://localhost:13000`, all retention mutation gates `false`.
- Rollback: `docker compose -p <project> down` (see step 9) — the replica owns
  its volumes; nothing outside `ops/staging-replica/` is touched.

## Step 0 — Preflight (no containers)

```sh
git rev-parse HEAD && git status --porcelain   # record revision + clean tree
docker info --format '{{.ServerVersion}}'      # daemon available
grep -cE '^RETENTION_(PURGE|MANIFEST_EXPORT|RECONCILE_APPLY)[^=]*=false$' \
  ops/staging-replica/.env.staging             # expect 5 (all mutation gates off)
grep -c 'smartlearning_staging_replica' ops/staging-replica/.env.staging  # >= 1
```

Stop unless every check passes and the user has explicitly authorized this run.

## Step 1 — Create env + build

```sh
cp ops/staging-replica/.env.staging.example ops/staging-replica/.env.staging
# Fill DB_PASSWORD, COOKIE_SECRET, MINIO_ROOT_USER/PASSWORD with
# `openssl rand -base64 32` values.
docker compose -f ops/staging-replica/docker-compose.yml \
  --env-file ops/staging-replica/.env.staging build
```

## Step 2 — Bring the stack up (migrations run only against the replica DB)

```sh
docker compose -f ops/staging-replica/docker-compose.yml \
  --env-file ops/staging-replica/.env.staging up -d
ops/staging-replica/setup.sh     # bucket + write-only user + creds into .env.staging
# Recreate backend if creds were merged after first start:
docker compose -f ops/staging-replica/docker-compose.yml \
  --env-file ops/staging-replica/.env.staging up -d --force-recreate backend
```

Verify: `curl -s http://127.0.0.1:13000/health/ready` → 200; the alert
webhook listener logs `[webhook] listening`; Prometheus
`http://127.0.0.1:19090/targets` shows the backend target up.

## Step 3 — Seed exactly ONE synthetic due archive

Create a closed session with `purgeAt` in the past **through the API** (same
fixture shape the guarded e2e uses) so the archive is genuine application
output. Record the archive id — the canary may select exactly this one row.

## Step 4 — Read-only inspection + two-operator review

```sh
docker exec staging-replica-backend sh -c \
  'RETENTION_OPERATIONS_ENABLED=1 NODE_ENV=production node dist/src/bootstrap/retention.js inspect'
docker exec staging-replica-backend sh -c \
  'RETENTION_OPERATIONS_ENABLED=1 RETENTION_PURGE_BATCH_SIZE=1 NODE_ENV=production \
   node dist/src/bootstrap/retention.js dry-run'
```

Requirements: dry-run artifact selects **exactly** the reviewed synthetic
archive, per-category counts recorded, **zero writes** (row counts unchanged).
Two-operator sign-off recorded in `tasks/todo.md` before any mutation.

## Step 5 — Exactly one purge (batch-size-1, schedulers off)

```sh
docker exec staging-replica-backend sh -c \
  'RETENTION_OPERATIONS_ENABLED=1 RETENTION_PURGE_ENABLED=true \
   RETENTION_PURGE_SCHEDULER_ENABLED=false RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED=false \
   RETENTION_PURGE_BATCH_SIZE=1 NODE_ENV=production \
   node dist/src/bootstrap/retention.js run-once'
```

Verify: the one archive is now `deleted` tombstone with `payload IS NULL`,
answer-bearing rows for that session are zero, exactly one `deletion_event`
(trigger retention) + one `deletion_manifest_outbox` (pending) row, `dry-run`
afterwards selects nothing.

## Step 6 — Exactly one immutable manifest export

```sh
docker exec staging-replica-backend sh -c \
  'RETENTION_OPERATIONS_ENABLED=1 RETENTION_MANIFEST_EXPORT_ENABLED=true \
   RETENTION_PURGE_SCHEDULER_ENABLED=false RETENTION_MANIFEST_EXPORT_SCHEDULER_ENABLED=false \
   RETENTION_MANIFEST_EXPORT_BATCH_SIZE=1 NODE_ENV=production \
   node dist/src/bootstrap/retention.js manifest-export-once'
```

Verify: outbox row → `exported`; object exists at
`sl-staging-manifests/deletion-manifests/<deletionEventId>.json` with
COMPLIANCE retention, SSE, and the expected checksum (verify with an admin
credential you supply explicitly — the app credential is write-only);
repeat `manifest-export-once` is idempotent (no duplicate object, no
conflict failure).

## Step 7 — Metrics / alerts / disabled steady state

With schedulers off and gates back to `false` (the long-running backend never
had them on), confirm over one scheduler-tick + alert-evaluation window:

- `/metrics` exposes retention gauges with `bg_job="retention_purge"` /
  `bg_job="manifest_export"` (NEVER `job=` — step 4 collision regression);
- `SmartLearningRetentionDueBacklogHigh` / `OldestDueAgeHigh` resolve to
  inactive with the backlog drained;
- no `PurgeNoRecentSuccess` false alarm without due backlog (due-backlog guard);
- Alertmanager → webhook listener records firing/resolved deliveries.

## Step 8 — Evidence

Record in `tasks/todo.md`: revision, env identity, all command outputs
(summarized, secrets redacted), before/after row counts, object
checksum/retention headers, alert timeline, and two-operator review entries.

## Step 9 — Teardown (removes ALL replica data)

```sh
docker compose -f ops/staging-replica/docker-compose.yml \
  --env-file ops/staging-replica/.env.staging down -v
# Optionally drop the images: docker rmi staging-replica-alert-webhook ... 
rm ops/staging-replica/.env.staging   # generated creds
```

## Boundaries

- The replica never touches `smartlearning_dev`, `smartlearning_test`,
  or any non-replica database (name + network + port separation).
- The long-running backend container runs with every mutation/scheduler gate
  false for its entire lifetime; one-shot CLI invocations are the only
  mutation path, each with exactly one operation gate.
- This replica proves the **staging canary profile** only. Production
  rollout, capacity/W1–W8, and WBS BE-5 closeout remain separately gated.