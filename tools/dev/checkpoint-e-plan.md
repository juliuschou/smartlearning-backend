# Checkpoint E — fresh development baseline execution proposal

This is new empty development data. Historical development authority is UNKNOWN.
No operation below has been executed or authorized by preparing this proposal.

## Reviewable preparation

`python3 -B tools/dev/checkpoint-e.py` emits the pinned execution contract and
all 20 migration SHA-256 values. It reads repository SQL only, rejects symlinks
and unexpected migration entries, and has no execution mode. The pure env
transform rejects ambiguous assignments; it does not read or write real env files.
The contract is an implementation specification, not a ready live provisioner.
The next checkpoint must implement and mock-test the live executor before any
request to approve data operations. Do not copy commands from this document into
an ad hoc shell provisioning session.

## Proposed resources and credentials

Use the exact engine/image/run identities emitted by the contract; revalidate
them immediately before live operations. Reject existing names rather than
adopting them. Preserve every existing container/volume and the C backup.

- Container: `sl-i-20261014-01-dev-pg`.
- Persistent PGDATA volume: `sl-i-20261014-01-dev-data`.
- Persistent credential volume: `sl-i-20261014-01-dev-secret` (additional resource
  beyond D's two names, necessary to avoid long-lived Rancher host bind mounts).
- Database/bootstrap: `smartlearning_dev` / `smartlearning_dev_owner` (superuser).
- Migration: `smartlearning_dev_migrator` (non-superuser DB/public-schema owner).
- Application: `smartlearning_dev_app` (non-superuser, no role memberships).
- Publication: `127.0.0.1:5433:5432`; restart policy `no`; no image pull.

Review image-supported postgres UID/GID before provisioning. Stream a generated
hex password through stdin to an exact run-labelled temporary secret helper;
never place it in argv, Docker Env, labels, reports or command output. Set file
owner to the verified postgres UID and mode 0400. Mount the secret volume read-only
in PG and use POSTGRES_PASSWORD_FILE; set POSTGRES_INITDB_ARGS to
`--auth-host=scram-sha-256`. The stock entrypoint may need root briefly to prepare
new PGDATA ownership before dropping to postgres: verify and document this
limited init exception rather than adding a blanket root override.

Stop the exact helper and retain its evidence; deletion is outside the proposed
scope. A retained credential volume is durable development configuration and
must not be described as a disposable test secret. Protected external backup
directory proposal: `/home/user/.local/share/smartlearning/sl-i-20261014-01`, mode
0700, current-user owner, no symlink parents. Fail if the destination exists.

## Preflight, migration and env gates

Require both WSL bind/listener check and Windows PowerShell IPv4 loopback bind
check for 5433 (including Windows reserved/excluded port ranges). A check is
point-in-time only: actual Docker publication must succeed and its metadata must
match exactly. A missing Windows probe blocks, never substitutes WSL evidence.

Verify exact container ID, image, labels, mounts, empty schema, actual database
and role before migration. Host TCP verification must demonstrate valid password
succeeds and incorrect password fails, without echoing URLs or subprocess stderr.
After bootstrap identity/empty-schema verification, create independently
credentialed migration/application roles. Transfer DB/public-schema ownership
to migration; revoke PUBLIC access on this fresh cluster's development, postgres
and template1 databases and the public schema. Application receives only CONNECT
and schema USAGE before migration. Role SQL is pinned by `rolePolicySha256`.
No backend or app tests may run. Apply repository migrations using the installed
Prisma CLI with the migration role's DATABASE_URL set in the child process
environment, not argv;
dotenv in prisma.config.ts does not override an already supplied variable.
The future executor must verify this and block inherited DIRECT_URL/PG*/Docker
overrides. Do not source the development env or use prisma db push.

Migration review: the chain creates tables/indexes and replaces constraints;
20260911100000 includes UPDATE archived_result and
20260920160000 includes INSERT SELECT sequence backfill. On an empty new schema
these affect zero application rows. The executor must check each migration
checksum/completion and zero application rows after deploy. Hashes bind review
to exact SQL; a changed tree requires review again. SQL execution has not been
validated against PG16 in E, so live compatibility remains unproven. After deploy,
grant application SELECT/INSERT/UPDATE/DELETE on public application tables,
USAGE/SELECT on sequences; revoke access to `_prisma_migrations` and public
functions. Audit effective privileges, role flags/memberships/ownership and
valid/invalid host passwords before any env change. Default function EXECUTE
for objects created by migration is revoked from PUBLIC. Future migrations must
reapply reviewed application grants for new tables/sequences; do not broaden
default table grants to expose migration metadata.

Only after all gates pass, back up `.env.development` outside Git with exclusive
creation, mode 0600, hash and fsync. Reject symlink/nonregular/unowned input and
unexpected connection assignments. Update DATABASE_URL and optional DIRECT_URL
to the same application-only target; preserve other content. Save the migration
URL exclusively in external `migration.url`, mode 0600, fsynced and hash-checked
before commit/written-env verification. Bootstrap password stays in the protected
secret volume; migration credential is never copied into the app env. Future
approved migrations must read that protected external file into the child
DATABASE_URL, never print it or use the app URL for deployment.
Use a same-directory mode-0600
temporary file, fsync, recheck original hash, os.replace, directory fsync. Require
exclusive edit access during this step; hash checks cannot eliminate an external
concurrent writer race. Never emit original or replacement file contents.

## Approval scope and rollback

Future data-operation approval must explicitly include new-volume initdb,
PostgreSQL start, secret-helper lifecycle, role creation/ownership/grants/PUBLIC
revocation on this fresh cluster, all 20 migrations on the new DB, protected env
backup/migration credential file and atomic env update. DB-backed tests, seed, Redis/backend
start, cleanup/deletion and old-resource adoption remain excluded.

On failure stop only the exact matching E container; retain all volumes and
sanitized diagnostics. Restore env atomically from the protected backup only if
current content matches the recorded E-written hash; otherwise stop for review.
Do not rollback schema with destructive SQL; isolate the failed new baseline.
No down -v, prune, resource wildcard deletion, commit or push.

## Container-free verification

```bash
python3 -B tools/dev/checkpoint-e.test.py
python3 -B tools/dev/checkpoint-e.py
git diff --check
```

These checks prove preparation behavior only. Live executor safety fixtures,
Windows bind checks, initdb/authentication/migration and atomic filesystem update
remain requirements for the next checkpoint, not claimed E verification results.


## Checkpoint I revision (2026-10-14)

The resource names above now reserve sl-i-20261014-01. H's sl-e-20261013-01
resources and artifacts are retained, never adopted or cleaned by this proposal.
Secret helper uses the same pinned image with explicit --mount
`type=tmpfs,destination=/var/lib/postgresql/data,readonly,tmpfs-size=1048576,tmpfs-mode=0700`.
This shadows the image VOLUME without mounting any PGDATA volume. The helper
only writes the named /secret volume; PG still mounts named PGDATA read-write
and secrets read-only. Root exception and separated roles remain unchanged.
Image Config.Volumes must be exactly /var/lib/postgresql/data. Helper inspect
must prove exactly one named secret volume and one read-only tmpfs plus exact
HostConfig tmpfs options, before start and during rollback. Any mismatch blocks.
Actual Docker inspect serialization and shadowing remain live-unverified.
