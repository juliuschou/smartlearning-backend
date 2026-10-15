# Checkpoint F — executor review and live gate

The E proposal remains the resource/migration/rollback contract. F implements
`Executor.execute()` and `EnvTransaction` with injectable runtime boundaries.
Default CLI prints review status only; it cannot provision. No Docker, initdb,
migration or real environment-file operations were performed to verify F.

## Concrete implementation

- Preflight pins context, endpoint, engine and stock PG16 image entrypoint; rejects
  runtime/connection/Node/Prisma overrides and existing resource names. Runtime
  identities are rechecked before mutations and migrations. Both WSL bind and
  Windows IPv4 bind/excluded-range checks are mandatory; unrecognized Windows
  output blocks. No fallback to WSL-only proof.
- New credential/data volumes have exact run labels, local driver, no options,
  and only recorded consumers. A retained helper uses network none and root
  solely to validate postgres UID/GID `999:999`, then write/chown/chmod the secret
  file. Its UID check runs before secret write and before PG initialization.
  No discovery database is started. This is a runtime guard, not current proof
  that the pinned image supports that UID. PG stock root entrypoint briefly
  prepares new PGDATA and drops to postgres; no blanket user override.
- Generated 64-hex credentials reach helper and TCP client only over stdin.
  Docker metadata receives only the secret-file path. Prisma receives an explicit
  child DATABASE_URL, not argv. Child stderr/stdout are captured and never printed
  by executor; reports contain IDs/stages only. Raw driver errors are suppressed.
- PG inspection verifies IDs/image/labels, entrypoint, exact two mounts, restart
  policy, privilege flags and configured/actual loopback publication. Readiness
  proves database/role and no public schema objects. TCP requires correct-password
  success and SQLSTATE 28P01 rejection of an independent incorrect password.
- Installed Prisma CLI deploy is bound to reviewed SQL hashes checked before and
  after; completion requires every expected name/checksum, no failed/rolled-back
  rows and zero application rows. No app suites, seed or db push.
- Env transaction accepts only the exact generated target URL and owner-only
  source file. Backup is outside repository, exclusive directory 0700/file 0600;
  fsync precedes atomic replacement. It verifies the written hash and connection
  assignments before final TCP authentication. Restoration requires the protected
  backup hash and matching current E-written hash; unsafe state blocks.
- Failure stops only inspected recorded helper/PG IDs, retains all resources,
  restores only a committed unchanged env, and reports blocked rollback gates.
  It does not attempt destructive schema rollback or cleanup.

## Verification limits / next approval boundary

Mock tests prove guards and ordering, not Windows parsing on this host, image UID,
stock entrypoint behavior, actual Docker publication, secret persistence, PG16 SQL
compatibility or migration performance. Baseline authority remains UNKNOWN;
this would create new empty development data, not recover historical records.

G continuation explicitly selected separate roles. `smartlearning_dev_owner`
remains the bootstrap superuser for initialization/ACL administration only;
`smartlearning_dev_migrator` owns the DB/public schema and migration objects;
`smartlearning_dev_app` receives application table DML and sequence USAGE/SELECT.
Both latter roles are non-superusers without elevated flags or memberships.
Prisma receives only migration credentials in its child env. App env contains
only application URLs; migration URL is retained outside Git in protected
`migration.url` alongside the original env backup. Policy source hash is part
of the revised contract. Effective privilege audit and role-specific TCP valid/
invalid-password checks precede env writes; audit repeats after commit.
Future migrations need separately approved routing through the protected
migration URL and reviewed grant refresh for newly created application objects.

Any future live entry point must preserve the reviewed expected contract, use the
exact `.env.development` and `/home/user/.local/share/smartlearning/sl-e-20261013-01`
backup destination, guarantee exclusive environment editing and serialized
resource provisioning, and persist sanitized stages/IDs/rollback results in
`artifacts/local-env/sl-e-20261013-01/` even on failure. F returns successful
sanitized evidence; on failure its executor object retains IDs/stages, so the
future live wrapper must capture them. Lifecycle event recording and the live
wrapper are not implemented or claimed by this checkpoint.

Point-in-time identity/hash/port checks cannot eliminate concurrent external
runtime changes or writers; require exclusive operation ownership. Volume-create
is Docker-idempotent; immediate collision and label/consumer checks reduce, but
cannot atomically eliminate, an external creator race. No approval for live
operations is inferred from a Python approval string.

The separately reviewed live scope remains: two new persistent volumes, exact
PG container and retained secret helper, new-volume initdb/start, separated role
creation/DB-schema ownership/grants/PUBLIC revocation, all 20 reviewed migrations,
protected migration credential file/env backup/atomic update, evidence writes and guarded stop/
env-restore on failure. All old resources, backups and unrelated changes remain
preserved. No deletion, backend/Redis, DB-backed tests, seed, commit or push.

```bash
python3 -B tools/dev/checkpoint-e.test.py
python3 -B tools/dev/checkpoint-f.test.py
python3 -B tools/dev/checkpoint-f-env.test.py
python3 -B tools/dev/checkpoint-f.py
git diff --check
```
