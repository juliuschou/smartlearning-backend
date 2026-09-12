# Disposable MinIO rehearsal for BE-5.2 / Checkpoint G step 3

This folder provisions a **throwaway** S3-compatible target to prove the
delete-manifest upload contract against a real store, then tears it down.

> **Environment blocker (2026-09-12):** the Docker daemon is not running and
> cannot be started from this session (no `dockerd` binary, non-root, passworded
> sudo). The scripts below are ready and become runnable the moment a Docker
> daemon with the compose plugin is available — on this machine (start docker)
> or on the operator's host.

## What the rehearsal proves

Run against a disposable MinIO at `127.0.0.1:19000`, bucket
`sl-rehearsal-manifests` (object-lock + versioning enabled), with a
**prefix-scoped write-only** user:

- conditional immutable write (`If-None-Match:'*'`, `ChecksumSHA256`,
  COMPLIANCE object retention, SSE);
- exact replay equality + outbox → `exported`;
- idempotent replay and duplicate re-put acceptance;
- (provider read-back of a conflicting/unverifiable object is covered by the
  S3 provider unit suite; the sandbox spec observes the exporter/outbox side).

Read-back inspection with an admin credential is **optional** and requires
admin access you must supply explicitly — the generated credential is write-only
by design (matches `.env.sandbox-rehearsal` and the cleanup register).

## Steps

```bash
# 1. Start MinIO (needs a running Docker daemon)
docker compose -f ops/minio-rehearsal/docker-compose.yml up -d

# 2. Provision bucket + write-only user; writes creds to .env.minio-rehearsal
ops/minio-rehearsal/setup.sh

# 3. Run the guarded rehearsal (DB = .env.test, S3 = generated creds)
ops/minio-rehearsal/rehearse.sh
#    optional single test:  ops/minio-rehearsal/rehearse.sh "uploads the manifest"

# 4. Tear down when evidence is recorded
ops/minio-rehearsal/teardown.sh
```

## Safety boundaries

- The scripts touch only the disposable `s3-sandbox-rehearsal`/`minio-rehearsal`
  MinIO container + `minio-sandbox-data` volume. They never touch
  dev/staging/production, never print credentials, and never commit them
  (`.gitignore` + gitignored output).
- The rehearsal DB rows live in `smartlearning_test` (covered by existing
  `truncateAll` suites); the scripts do not delete DB rows.
- `teardown.sh` prompts and removes only the container/volume/credential file.
- This is NOT a production topology and is not part of the backend Compose
  stack. SEE ALSO `ops/observability/retention-runbook.md` for production S3
  prerequisites (this rehearsal does not stand in for production readiness).
