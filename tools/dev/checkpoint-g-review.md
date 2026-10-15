# Checkpoint G — gated entry and evidence review

Repository work only. No Docker query/lifecycle, SQL, real env access, initdb,
migration or app tests were performed. Historical data authority is UNKNOWN.
Credential decision is **separated-roles**, explicitly selected by the user.
Bootstrap, migration and application credentials are independent. E/F contract,
authentication, env URL guards and regressions reflect this decision. Repository
completion does not authorize live operations; default CLI is review-only.

## Implemented entry and persistent evidence

`python3 -B tools/dev/checkpoint-g.py` is a repository-only review. It reports
the deterministic SHA-256 of the full E contract, credential decision and live
enablement state. Execute mode requires exact reviewed hash, F's scoped approval,
the selected separated-role privilege policy, and exclusive env
editing/resource provisioning. These arguments never establish human authority.
The reserved targets remain E's exact resources, `.env.development`, external
backup path and `artifacts/local-env/sl-i-20261014-01/`; no overrides or fallback.

The evidence directory must be absent with existing nonsymlink parents. Journal
files are created exclusively, mode 0600 in mode 0700 directory, with directory
fsync. Each lifecycle record is flushed/fsynced before continuing. The first
record binds the reviewed contract hash. Command intent/completion/failure and
exact returned container IDs are recorded without argv, env, raw output/errors,
URLs or secrets. The pre-opened outcome file records sanitized stages, IDs,
rollback errors, recorder failure and unresolved create response status.

A lost/invalid Docker create response causes fail-closed recovery of the exact
reserved name under pinned runtime identity and full F ownership/mount/consumer
verification. It never resumes provisioning after recovery. IDs remain available
for guarded rollback even when post-create journal writes fail. If recovery is
unavailable, outcome explicitly records unresolved helper/PG identity: absence
of an ID is not proof that no resource was created. Retained resources require
review; do not run again or adopt them.

Rollback continues despite recording failures and uses F's identity guards.
An event or outcome write failure cannot produce success. Outcome persistence
failure attempts guarded rollback and returns an explicit blocked diagnostic;
filesystem/runtime outage can prevent persistence or stopping, and is not
claimed safe completion. Do not erase partial evidence.

Docker lifecycle events are collected using bounded `--since/--until` and exact
run-label filter after success, and attempted after failure/rollback. Only known
container IDs and allowlisted actions are retained; attributes are discarded.
This is retrospective Docker event capture, not an always-on monitor. Daemon
history loss or process/host termination can leave incomplete evidence; command
intent and IDs already fsynced provide the last known state. Final inspected PG
must still be running. No automatic recovery after host/process termination.

## Revised concrete live scope — approval still required

The concrete live scope remains E/F's new persistent data/secret volumes, exact
PG and retained helper, stdin secret write, new-volume initdb/start, creation of
non-superuser `smartlearning_dev_migrator` and `smartlearning_dev_app`, transfer
of development DB/public-schema ownership to migration, PUBLIC access revocation
on this fresh cluster's development/postgres/template1 databases, application
DML/sequence grants and privilege audits, 20 reviewed migrations run solely as
migration, protected external env backup plus `migration.url` (0600), and atomic
development env update to application URLs only, evidence
writes and exact-ID guarded stop/hash-guarded env restoration. Exclusive editing
and serialized provisioning are mandatory. Preserve every old resource/C backup;
no deletion, seed, db push, app suites, backend/Redis, commit or push. The revised
approval literal and role-policy source hash invalidate prior contract approval.
Bootstrap stays a superuser only for initialization/admin checks; its password
remains in the exact secret volume, never the application env. Future migrations
require separately approved protected migration URL routing and grant refresh.
See `checkpoint-e-plan.md` for exact resource names and backup destination.

## Verification

```bash
python3 -B tools/dev/checkpoint-g.test.py
python3 -B tools/dev/checkpoint-e.test.py
python3 -B tools/dev/checkpoint-f.test.py
python3 -B tools/dev/checkpoint-f-env.test.py
python3 -B tools/dev/checkpoint-g.py
git diff --check
```

Mocks/temp files prove guards and evidence failure behavior only. Windows ports,
image UID/stock entrypoint, real publication/authentication, PG16 migration
compatibility and live rollback remain unverified. G repository implementation
and mocked verification are complete; the reliable local environment goal and
live readiness remain unverified.

Initial continuation verification (before role decision): G 17, E 6, F 18 and
F env 15 tests PASS (56 total); review CLI was disabled/pending. Added CLI
pre-evidence rejection, foreign recovered-ID guarded-stop rejection, and real
RecordedExecutor/F execution orchestration through successful and failing env
transaction paths. Provisioning stages, runtime and filesystem transaction are
mocked in that initial orchestration test. Role continuation adds a complete F
execution through G's recorder using a deterministic simulated Docker/TCP/SQL
runtime (including real preflight/provision/role/migration methods), successful
and failed effective-privilege paths. Actual SQL semantics remain unverified.

Policy references: PostgreSQL 16 [default PUBLIC privileges](https://www.postgresql.org/docs/16/ddl-priv.html),
[privilege inquiry semantics](https://www.postgresql.org/docs/16/functions-info.html#FUNCTIONS-INFO-ACCESS-TABLE),
and [default function privileges](https://www.postgresql.org/docs/16/sql-alterdefaultprivileges.html).
Required DML privileges are checked individually: a comma-separated inquiry
returns true for any matching privilege, so it cannot prove all required grants.

Final verification after role decision: E 6 + F 21 + F env 18 + G 19 = 64 PASS;
`git diff --check` PASS. Review CLI reports REVIEW_ONLY / separated-roles /
liveEnabled=true (implementation gate available, no human live authority).
Historical pre-I contract SHA-256 (superseded; do not execute):
`e5da104678835296a6f60d80a8eca6bd044a7181eda06e195b55412b9a1b8b46`.
Historical pre-I approval literal (consumed):
`fresh-initdb-start-secret-helper-separated-roles-grants-20-migrations-env-backup-update`.
Independent read-only review found no concrete role/routing blocker. Live SQL,
grants/authentication, application CRUD and infrastructure checks remain unproven.
