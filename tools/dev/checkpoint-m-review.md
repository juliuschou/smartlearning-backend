# Checkpoint M — SQL-only diagnostic preparation (2026-10-14)

## Delivered boundary

`checkpoint-m.py` provides a separate pure contract, guarded SQL transport,
synthetic-schema diagnostic driver and sanitized subprocess classifier.
It never calls G, migrations or environment transactions. Default invocation
only returns a review summary. Every CLI argument, including `--execute`,
is rejected before runtime access. **There is no enabled live orchestration
entry. This document is a concrete proposed scope, not a live approval request
or an executable provisioning runbook.**

Review command:

```sh
python3 -B tools/dev/checkpoint-m.py
```

Prepared contract SHA-256:
`319359319c3c7cc9ff99821f15d3933d5df769884f749c7a1e0ad2fddd9f6f8c`.
The hash binds diagnostic code, F/E guard sources, role-policy source,
exact AUDIT, synthetic schema, case mutations, classifications and identities.
Any future orchestration adapter changes the reviewed contract and requires
another review/hash before live authorization. No current live command exists.

## Proposed single-use live scope (not authorized)

Fresh identity: `sl-m-20261014-01`.

| Resource | Exact identity |
| --- | --- |
| PG container | `sl-m-20261014-01-sql-pg` |
| Secret helper | `sl-m-20261014-01-secret-helper` |
| Data volume | `sl-m-20261014-01-sql-data` |
| Secret volume | `sl-m-20261014-01-sql-secret` |
| Evidence directory | `artifacts/local-env/sl-m-20261014-01` |
| Ownership label | `smartlearning.checkpoint=sl-m-20261014-01` |
| Docker context / endpoint | `default` / `unix:///var/run/docker.sock` |
| Engine ID | `8820f44b-5227-4afe-8eff-245fcc9e8a31` |
| PostgreSQL image ID | `sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54` |
| Publication | `127.0.0.1:5433:5432` |
| Database | `smartlearning_dev` in this fresh isolated cluster only |

Proposed lifecycle:

1. Reserve serialized provisioning and port use; reject inherited runtime/DB
   overrides. Revalidate exact context/endpoint/engine/image and stock image
   volume, entrypoint/user/command. Reject every name/evidence collision; prove
   Windows and WSL port availability. Do not query/adopt/restart H/K containers.
2. Begin protected, exclusive sanitized lifecycle evidence before creation.
   Create exact labeled volumes, check driver/options and consumer sets.
   Generate three distinct independent synthetic 64-hex credentials in memory.
   Stream bootstrap password via stdin to a fresh helper, mode 0400, UID/GID
   999:999. Helper's sole root exception is secret ownership initialization;
   it has network none, no PGDATA volume, and read-only 1 MiB mode-0700 tmpfs
   explicitly shadowing the image VOLUME. No secrets in argv, metadata or logs.
3. Create fresh PG with only approved data/secret mounts, restart=no, protected
   PASSWORD_FILE and loopback publication. Validate exact IDs/image/labels/
   command/mount configuration/actual mounts/consumers before any start or SQL.
   Fresh initdb and readiness checks are included in proposed future permission,
   but no Prisma migration is included. No retry of a failed diagnostic case.
4. Bootstrap role is `smartlearning_dev_owner`; independent migration and app
   roles are `smartlearning_dev_migrator` and `smartlearning_dev_app`.
   Execute exact existing `roles.setup`, minimal synthetic schema (empty
   `_prisma_migrations`, application table, sequence, function), exact GRANTS,
   then exact AUDIT. Setup passwords travel only in protected stdin.
5. Each negative case executes BEGIN, a fixed mutation, exact AUDIT and ROLLBACK
   within one psql connection. Expect false; run exact AUDIT afterward expecting
   true before advancing. Missing table/sequence SELECT and forbidden table
   TRUNCATE, sequence UPDATE, metadata SELECT, function EXECUTE, schema CREATE
   and database TEMP are tested. Any unexpected result or exception stops work.
6. Capture only fixed check IDs, booleans/match results and allowlisted SQLSTATE
   classification (42601, 42501, 42704, 42883, 42P01, 3D000, 28P01, 08006,
   57014). Unclassified failures remain UNKNOWN. SQLSTATE is a diagnostic
   classification, not proof of K's historical root cause. Never publish raw
   stderr, SQL, credentials, connection strings or unconstrained exceptions.
7. On success or failure, use existing F exact-ID runtime/image/mount/consumer
   guards to stop only owned current-run containers. Retain volumes and
   evidence; secrets remaining in retained storage must stay protected.
   Cleanup/deletion requires separate authorization. Capture stop/recording
   failures explicitly; do not rerun or silently replace failed resources.

Excluded: real env reads/writes/backups, migration.url, all 20 migrations,
Prisma, application tests, seed, old resources, development data, backend/Redis,
cleanup/deletion/prune, automatic retry/restart, commit/push.

## Required next repository work before requesting live permission

Implement and review a separate single-use orchestration adapter with explicit
scope/hash/exclusivity gates, the fresh preflight/provisioning above, protected
exclusive durable evidence, and recording of unresolved creates/stop failures.
Model image VOLUME behavior and consumer sets in container-free full-lifecycle
fixtures, including failed evidence writes and interrupted creates. Do not use
F's current `preflight`, `separate_roles` or `execute` directly: they bind the
I migration/env contract. M intentionally disables those inherited operations;
only runtime/container/volume checks and guarded rollback are reused.

Select and review the final exact live command and refreshed adapter-bound hash
before asking for explicit live authorization. This repository work is the
recommended next checkpoint. Generic checkpoint approval cannot authorize the
proposed SQL/container lifecycle. Resource names remain a proposal; the future
preflight must reject any collision rather than assume they are available.

## Evidence and limitations

Container-free M tests: 16 PASS. E/F/F-env/G: 6 + 23 + 18 + 19 = 66 PASS.
M default CLI: REVIEW_ONLY, liveEnabled=false. `--execute`: exit 1,
LIVE_NOT_ENABLED. `git diff --check`: PASS.

These tests prove driver control flow, preserved guard invocation, credential
validation, exact SQL composition, fail-closed CLI/contract boundaries and
sanitized failures. They do not execute PostgreSQL and cannot establish SQL
parse/execution, effective privileges, Docker lifecycle or full migration
compatibility. K root cause remains UNKNOWN; local development baseline remains
incomplete. H/K evidence and resources are untouched.
