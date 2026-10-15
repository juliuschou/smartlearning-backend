# Local environment safety checks

## Persistent retained test database

`compose.local-db.yml` is independent of the root Compose stack. It uses only
the reviewed existing PostgreSQL image and external W3/test data volume, on the
pinned `default` engine. It serves `smartlearning_test`; it does not provision a
development or production database. Never start the original container while
this service uses its data. Use one operator at a time: the checks are snapshots,
not a cross-process lock against other Docker clients.

Use the guarded entry rather than invoking Compose directly:

```bash
python3 tools/dev/local-db.py review  # offline, default action
python3 tools/dev/local-db.py status  # bounded metadata inspection
python3 tools/dev/local-db.py up      # create only if absent; start existing owned service
python3 tools/dev/local-db.py stop
python3 tools/dev/local-db.py start
python3 tools/dev/local-db.py restart
```

The tool fails closed on engine/image/volume/ownership/configuration drift or
another running volume consumer. No pull, build, initdb, migration, seed, role
changes or resource deletion is provided. The existing initialized cluster is
started directly as OS user `postgres`; no password file or env_file is mounted.
The application alone uses the private, Git-ignored `.env.test` credential.
Never print that file or pass credentials as command-line arguments.

`up`/`start`/`restart` wait for container health. This proves server readiness
only, not SQL identity, schema correctness, data continuity or application health.
Run `node tools/dev/local-db-verify.cjs` for a bounded TCP READ ONLY transaction
using the existing application credential. It verifies database/role, repository
migration checksums, mapped schema and aggregate table counts; it emits only
aggregate digests, never credentials or data rows. Compare identity/schema/counts
before and after one controlled restart, before launching the application. Then
perform three successful SQL probes five seconds apart. Do not run DB-backed
Jest setup: it implicitly deploys migrations.

Runtime acceptance additionally needs the retained, source-hash-matched compiled
snapshot, isolated `.env.test` configuration with `NODE_ENV=test`, Redis off and
memory login rate limiting. Run `npm run start:prod`, assert HTTP 200 from
`/health/live` with `status=ok` and `checks={}`, then stop only the owned app
process group. Startup can update/clean existing background data; the liveness
endpoint does not replace the independent SQL checks. A missing or stale snapshot
requires a separately scoped build; this manager never installs or rebuilds.

`stop` deliberately disables restart policy before stopping the exact verified
container; `start` restores `unless-stopped`. Docker daemon must remain running.
Stopping Docker or the host has not been tested by the controlled restart check.
If startup fails, the manager attempts to disable restart and stop the known
owned container; unresolved creation ownership requires exact-ID review before
cleanup. No automatic retry or container removal occurs. A conflicting consumer
also blocks cleanup: report it and resolve ownership before taking further action.
Stopping does not undo PostgreSQL WAL/recovery or application writes.

Rollback: use `stop`, verify the recorded full ID is exited with restart policy
`no`, and preserve the external volume, original container, role and `.env.test`.
If deployment removal is needed, separately verify ownership before removing only
that stopped container without `-v`, and only its empty owned Compose network.
Never use `down -v`. Point-in-time data restore requires a verified backup and
separate authorization.

Container-free verification:

```bash
python3 -B tools/dev/local-db.test.py
python3 -B tools/dev/local-db.py review
git diff --check
```

Checkpoint E preparation: [execution proposal](checkpoint-e-plan.md).
`python3 -B tools/dev/checkpoint-e.py` emits a repository-only pinned contract;
`python3 -B tools/dev/checkpoint-e.test.py` runs container-free regressions.
Checkpoint F adds the injectable executor and protected env transaction; see
[executor review and live gate](checkpoint-f-review.md). Container-free checks:
`python3 -B tools/dev/checkpoint-f.test.py` and
`python3 -B tools/dev/checkpoint-f-env.test.py`. The CLI remains review-only.
Checkpoint G adds a gated entry and durable sanitized lifecycle/outcome evidence;
see [entry review](checkpoint-g-review.md). Run `python3 -B tools/dev/checkpoint-g.test.py`
for container-free checks. The selected policy separates bootstrap, migration
and application roles. Execute mode requires exact contract/approval gates and
separately scoped human live authorization; default invocation is review-only.

Checkpoint B provides repository-only diagnostics. It does not select an
authoritative database, create a development environment, or authorize data
operations. The current recovery-sensitive baseline is recorded in
`tasks/todo.md` (2026-10-13 Checkpoint A).

## Metadata-only doctor

The old implicit test defaults and container/Redis/HTTP probes are removed.
All four expectations must be supplied from reviewed evidence. Example with
placeholders (replace every value before use):

```bash
EXPECTED_DOCKER_CONTEXT='<reviewed-context>' \
EXPECTED_DOCKER_ENGINE_ID='<reviewed-engine-id>' \
POSTGRES_CONTAINER='<reviewed-container-name>' \
POSTGRES_VOLUME='<reviewed-volume-name>' \
npm run env:doctor
```

The script rejects Docker environment overrides and pins inspection to the
expected context. Each Docker query is bounded to 10 seconds. It uses only
context show, info, container inspect, volume inspect, and ps; no raw inspect,
configuration environment, credentials, or connection strings are printed.
It verifies the exact named volume mounted writable at
`/var/lib/postgresql/data` (PostgreSQL 16 layout) and rejects other running
consumers of that volume. Unsupported layouts fail closed.

Exit 0 means only that metadata matched at the time of inspection. Exit 1
means blocked or inspection unavailable. A stopped container remains blocked;
the tool never starts it. It never executes SQL, enters a container, probes the
application, or changes resources. It does not prove PostgreSQL readiness,
SQL database identity, data integrity, backup recoverability, or continuous
exclusivity. Do not use its exit status as automatic approval for mutations.

## Container-free verification

```bash
bash -n tools/dev/env-doctor.sh tools/dev/env-doctor.test.sh
npm run env:doctor:test
git diff --check
```

Tests use a strict mock Docker allowlist and temporary files only. They do not
load `.env`, run Jest database setup, migrate, or contact Docker/PostgreSQL.

## Checkpoint C remains separately gated

Before any data operation, review the preserved source container/volume and
whether a separate working copy is required. Obtain explicit authorization
for the exact container/volume operations, read-only SQL identity proof,
external logical backup destination, and isolated restore verification.
A container start writes PostgreSQL recovery/WAL state; metadata inspection
alone cannot authorize it. Do not adopt a disposable W3/test volume as dev.
No lifecycle, snapshot, backup, restore, migration, seed, DB-backed tests,
credential rotation, or cleanup is included in Checkpoint B.

## Checkpoint C recovery verification result (2026-10-13)

The separately authorized run `sl-c-20261013-01` copied the stopped recovery
volume read-only to a new working volume, exported `postgres` and
`smartlearning_test` to Windows D:, and verified restoration in another isolated
cluster. Source file/ownership/mode/mtime manifests remain unchanged. All four
run-owned containers are stopped; volumes and evidence are retained.

Backup: `/mnt/d/Backups/SmartLearning/sl-c-20261013-01/`. Role passwords are
excluded. SHA-256, Windows file ACLs, restored schema/table content/counts and
database properties passed. Evidence: `artifacts/local-env/sl-c-20261013-01/`;
full results and known tooling interruptions are in the C section of
`tasks/todo.md`.

**Development database authority remains unproven:** this candidate has W3/test
provenance and contains no `smartlearning_dev`. Backup/restore success does not
authorize dev adoption, environment edits, migrations, or database-backed tests.

`checkpoint-c.py` and `checkpoint-c-backup-dir.ps1` are the exact reviewed run
artifacts, not reusable fresh-environment commands. Retained resource names
must not be overwritten or reused for another run. Container-free regressions:

```bash
python3 -B tools/dev/checkpoint-c.test.py
git diff --check
```

Checkpoint I revises helper image-VOLUME handling and reserves fresh resources;
see [current proposal and manual gate](checkpoint-i-review.md). H's single live
approval is consumed; do not execute using historical hashes or resource names.

## Fresh full recovery acceptance (2026-10-15)

Run `sl-full-recovery-20261015-01` passed fresh external backup, isolated SQL restore
and compiled application `/health/ready` against the restored DB. Backup location:
`D:\Backups\SmartLearning\sl-full-recovery-20261015-01` (restricted Windows ACLs,
password-free globals, verified SHA256). SQL verification covered 22 tables,
structure/constraints/indexes/extensions/ACLs, data hashes/counts and database
properties using the same exported source snapshot per database; no sequences
were present. Restore and source have different PostgreSQL system identifiers.

App readiness returned HTTP 200, status ok, db healthy, Redis off and limiter
memory. Backup took 6.236 s, restore/compare 13.752 s, app readiness 1.036 s.
Full elapsed including diagnosis/retries is recorded in
`artifacts/local-env/sl-full-recovery-20261015-01/result.json`; this is not an
RPO/RTO commitment. Owned app and both restore containers are stopped, source
remains running. New restore volume/network and external backups are retained.
The restore endpoint was loopback 55433, with restore-only trust restricted to
the app role/database and exact private forwarding peers. Do not start this
retained drill cluster as a general development database.

`full-recovery.py`, `full-recovery-runtime.cjs`, `full-recovery-sql.cjs` and
`full-recovery-backup-dir.ps1` are audited single-run artifacts. Initial and
continuation authorizations are consumed; do not replay them or reuse names.
The init container is one-shot and must remain stopped. See the task ledger for
failure recovery and resource IDs. No migrations/seed/DB-backed Jest were run.
Container-free regression command: `python3 -B tools/dev/full-recovery.test.py`.

## Reusable daily backup command — Checkpoint 1 (2026-10-15)

See [the full plan](daily-backup-plan.md) for scheduling, cancelled second-copy policy and drill
stages. This command backs up only the guarded retained test cluster. It never
starts services, restores, migrates, deletes, installs tasks or sends notifications.

```bash
python3 -B tools/dev/daily-backup.py review
python3 -B tools/dev/daily-backup.test.py
# Requires Docker, mounted Windows D and Windows PowerShell/ACL access:
python3 -B tools/dev/daily-backup.py run
python3 -B tools/dev/daily-backup.py status
# Intentional exit 1, before source access; proves last-success unchanged:
python3 -B tools/dev/daily-backup.py run --safe-preflight-failure
# Reports BLOCKED/exit 1 and no deletion candidates until later stages:
python3 -B tools/dev/daily-backup.py retention --dry-run
```

`run` generates a fresh UTC/UUID ID unless `--run-id` is supplied. Existing run
IDs are never reused. All sensitive files stay under the verified Windows path
`D:\Backups\SmartLearning\daily-v1`; no WSL fallback. A protected `.partial`
directory holds password-free globals, per-database snapshot dumps and source
SQL summaries. Archive database identity, parseability, SHA256, file inventory
and Windows ACLs are verified before non-overwriting directory publication.
`success.json` is written last inside partial; `last-success.json` is updated
only after publication. Consumers reject partials and verify every payload.
The manifest records exact tool hashes/versions and independent snapshot times.

A permanent `.lock` file with nonblocking flock serializes supported WSL entry
points. Do not run other Docker clients that change the source concurrently; the
existing source manager does not share this lock. Windows-native launchers must
call this WSL runner, never implement an independent writer.

A publish/index interruption may leave a valid published run with a FAIL receipt;
`status` reconstructs availability from valid published manifests, independent
of the index. It also rechecks each published run's ACL and reports corruption
as failure. Do not edit manifests or repair indexes by hand. Partial runs and
failed receipt directories are retained; do not retry their IDs or delete them
without an explicit scoped cleanup decision. Sanitized attempt receipts live in
`artifacts/local-env/<run-id>/`; no raw child logs, data rows or credentials.

Overall timeout is 15 minutes; remote dumps have their own 240-second bound,
SQL inventory has statement deadlines, and snapshot exporters expire after
300 seconds idle. Sequences, foreign tables, large objects, custom tablespaces
and unexpected databases fail closed pending expanded coverage. Consistency is
per database, not an atomic whole-cluster snapshot; concurrent role/schema
administration is outside the supported operating window. Windows rename is
non-overwriting and was exercised live, but power-loss durability has not been
proven; a crash requires full manifest/hash validation rather than trusting names.

`backupVerified` means parse/hash/ACL verification, not a new restore test.
`restoreVerified` remains false, `secondCopy` is not configured, and status marks
stale at 24 hours without implementing notifications. Retention currently blocks
all deletion; the policy engine and scheduler belong to later checkpoints.

First live run `sl-daily-20261015T083555Z-418358a9` published successfully in
19.802 seconds. Safe rejection `sl-daily-20261015T083702Z-7ec3ddb5` returned
expected exit 1, sourceAccessed=false and lastSuccessUnchanged=true. Final status
verified one published generation, hashes and Windows ACLs. This does not repeat
or supersede the historical full-recovery restore acceptance.

## Daily scheduler and independent watchdog — Checkpoint 2 (2026-10-15)

Settings were adopted and both exact tasks were deployed/enabled on 2026-10-15. Native local-script execution without Bypass and manual Task Scheduler execution passed (backup exit 0; watchdog exit 1 with only `second-copy-unverified`). Task Scheduler Operational logging is enabled after UAC elevation. Observation baseline: 2026-10-15T10:23:50Z; first daily due 20:00 Asia/Taipei. **Zero scheduled backup dates accepted so far; seven scheduled days, automatic triggers, retries and catch-up remain unverified.** Source remains the retained test DB, not a production/dev provisioning change. Deployment evidence: `artifacts/local-env/sl-scheduler-deployment-20261015-v1/` including enabled XML, compact readback, manual-origin events and receipts. Windows XML exports declare UTF-16 but were written UTF-8 by Set-Content; repository evidence copies normalize that declaration. Decode original exports explicitly before parsing/importing; do not blindly import them. Default task settings also disallow starting on battery and stop on battery transition; observed readback retains these defaults.

Deployment contract: Windows `DESKTOP-0KADDT9\USER`, SID `S-1-5-21-2171058193-2806922946-1671614276-1000`; `Taipei Standard Time`; WSL `Ubuntu`, Linux `user` (uid 1000), repo `/home/user/projects/smartLearning/smartLearning-backend`. The scheduled wrapper uses a clean environment with verified fixed Python, Rancher Docker and Windows PowerShell paths, preserving WSL interop only. Missing dependencies fail; it does not start Rancher or the DB.

`daily-backup-windows.ps1 -Action Review|Run|Watch|Install` is the Windows entry point. `Run -SafeFailure` rejects before source access and returns exit 1. Normal Run preserves WSL exit code and delegates the shared backup lock/900-second deadline to the existing runner. A launcher mutex additionally protects attempt state. The scheduler definition proposes daily 20:00, StartWhenAvailable (one current catch-up, no invented historical runs), IgnoreNew, two retries 15 minutes apart, and a 20-minute task execution limit. It does not enable wake-to-run. Interactive principal requires the specified user to be logged in; unattended logged-out/boot operation is **not accepted**. The native watchdog definition runs hourly and at that user's logon. A host that is off, or has no applicable logged-in session, cannot locally alert; external heartbeat remains pending.

The dedicated restricted native state directory is `C:\Users\USER\AppData\Local\SmartLearningDailyBackup-v1`, independent of both WSL and the D backup drive. Install copies the watchdog/launcher script there, verifies SHA256, and registers only `SmartLearning-DailyBackup-v1` and `SmartLearning-DailyWatchdog-v1`; existing task/script collisions fail without overwriting. The script must be installed from the reviewed repo version. Both tasks are registered disabled and exported before enabling the watchdog, then the backup. Installation can partially succeed: inspect both exact names and exported XML before retrying; no automatic destructive cleanup. After a partial failure, keep the exact backup task disabled, compare the native script SHA256 and all existing definitions with this implementation, then finish missing definition/export steps before enabling watchdog followed by backup; do not blindly rerun Install or overwrite collisions. Task registration/readback passed; preserve the deployed definitions during policy-only updates.

The watchdog scans owned formal manifests and payload hashes without invoking WSL, reconstructs latest conservative per-DB snapshot time, checks attempt failures/overdue/missed schedules and 24h/26h thresholds, and records de-duplicated raised/recovered events. `notification.json`, immutable `event-*.json`, `watchdog.json`, `attempt.json`, and completed `attempt-*.json` are local machine-readable notifications/evidence; no toast, email, webhook or external delivery is configured. A missing/corrupt backup root produces a verification failure notification on C. If C/state writing fails, the process/task fails nonzero; inspect Task Scheduler LastTaskResult. Second copy is CANCELLED/not-required; absence alone does not degrade health. State explicitly records secondCopyPolicy=cancelled and secondCopyRequired=false, without claiming copy verification. Prior second-copy warnings produce a durable recovered event; historical event files remain. External heartbeat is a separate pending capability.

Read state in Windows PowerShell:

```powershell
$state='C:\Users\USER\AppData\Local\SmartLearningDailyBackup-v1'
Get-Content -LiteralPath "$state\watchdog.json" -Raw
Get-Content -LiteralPath "$state\notification.json" -Raw
Get-ScheduledTaskInfo -TaskName SmartLearning-DailyBackup-v1
Get-ScheduledTaskInfo -TaskName SmartLearning-DailyWatchdog-v1
```

Initial installation is complete. Do not rerun Install for policy updates: verify installed hash, ACL and exact task actions, retain a restricted rollback script, replace only the known script under launcher/watchdog mutexes and read back hash/health. Local policy blocked the unsigned UNC script during manual tests; test invocations used process-only `-ExecutionPolicy Bypass` with permission, without changing system policy. The installed task uses the native local script path; execution-policy compatibility passed deployment verification. Rollback: `Disable-ScheduledTask -TaskName SmartLearning-DailyBackup-v1` and `Disable-ScheduledTask -TaskName SmartLearning-DailyWatchdog-v1`; stop only these task instances if necessary. Preserve all backups/state. Never stop source services as rollback.

`python3 -B tools/dev/daily-backup.py retention --dry-run` now inventories exact verified owned run paths/files/hashes and selects the union of 30 daily days, up to eight weekly representatives within 56 days, twelve calendar-month representatives and minimum seven generations. UTC determines weekly/monthly buckets; newest snapshot/run wins ties deterministically. Unknown/historical directories and partials are excluded; corruption of an owned formal generation fails the operation. Output separates proposed `policyDecision` from `effectiveDecision=keep-blocked`. Second copy is cancelled. Daily restore-baseline and latest-attempt receipt linkage are not implemented, so all deletion remains blocked, even if manifests claim restore/copy success. The successful daily runtime receipt is separate from the immutable publication manifest; future linkage must verify exact generation and manifest digest. No delete command exists. Exit 1 with `status=BLOCKED` is expected.

Container-free checks (no Jest/setup/migrations):

```sh
python3 -B tools/dev/daily-backup.test.py
python3 -B tools/dev/daily-retention.test.py
```

Run `daily-scheduler.test.ps1` in Windows PowerShell for fake-clock thresholds, never-run/missed/overdue/future times, actual local notification dedup/recovery/corrupt-state and a nonexistent backup-path injection. It creates a fresh Windows TEMP state directory and retains it; it does not stop DBs, unmount drives or register tasks.

Acceptance evidence: `artifacts/local-env/sl-scheduler-20261015-v1/`. Observe seven **scheduled** successful local calendar dates after deployment; correlate immutable attempt receipts with exact-task Task Scheduler events and current task definitions, rather than counting manual runs as scheduled days. Inspect Task Scheduler Operational log availability at deployment; if unavailable, arrange an authorized durable trigger-origin record before beginning observation. No seven-day pass or RPO/RTO guarantee is claimed. Second copy is cancelled; fresh daily-generation restore/runtime passed (below). External notification/heartbeat remains separate; test-entry guards, cold recovery and Snapshot remain later checkpoints.


## Fresh daily restore and compiled runtime acceptance (2026-10-15)

Run `sl-daily-runtime-20261015-01` passed using formal daily generation
`sl-daily-20261015T102351Z-0a8e4f93`; no replacement dump was taken. Six payload
hashes, unchanged manifest and restricted Windows ACL passed. The test DB snapshot
was about 16 minutes old at validation. Same-snapshot data hashes/counts and
structure/constraints/indexes/extensions/ACL/database properties matched for 22
tables before app writers; sequences and large objects were both absent.
Independent PostgreSQL system identifiers and the expected restore cluster were
proven. Persistent fresh build/source receipt is retained in
`artifacts/local-env/sl-daily-runtime-20261015-01/`.

Parsed `/health/ready` returned HTTP200, status ok, DB healthy, Redis off and
memory limiter. App process group stopped, port 3001 closed, restore container
stopped, source remains healthy/running; backup, volume and network retained.
Restore+compare took 13.776s, app readiness 1.547s, total driver execution including
build and cleanup 29.723s (excludes planning/review/approval; not cold RTO).
See `restore.json`, `runtime.json` and `result.json` in that evidence directory.

`daily-runtime.py`, `daily-runtime.cjs` and `daily-runtime-sql.cjs` are audited
single-run artifacts with consumed authorization. Do not replay them or restart
the one-shot init container. Container-free regression:
`python3 -B tools/dev/daily-runtime.test.py`. No migrations/seed/DB-backed Jest
were run. Second copy was cancelled; seven-day scheduled-origin acceptance is
still pending. The subsequent policy checkpoint below synchronizes that cancellation.

## Cancelled second-copy policy deployed (2026-10-15)

Evidence: `artifacts/local-env/sl-policy-cancelled-20261015-v1/`. Exact installed
script hash/ACL and both task definitions matched the deployment baseline before
replacement; definitions remained unchanged. Original script is retained in the
restricted native control directory as `daily-backup-windows.policy-before-20261015.ps1`.
Normal installed execution without policy override returned 0: active alerts empty,
secondCopyPolicy=cancelled, secondCopyRequired=false. The old second-copy warning
produced a recovered event; historical notifications were retained. Explicit
ExecutionPolicy Default was rejected as Restricted; the actual deployed invocation
without an override passed. No system execution policy was changed.

One fresh observation at 2026-10-15T10:49:59Z found only the prior manual trigger
(event 110), its completion and three immutable attempts (including older manual
tests); no automatic trigger was observed. Accepted scheduled dates remain zero;
next daily due is 20:00 Taipei. No generation was accepted as scheduled without an
automatic trigger, immutable attempt and generation linkage. Observation does not
block the next checkpoint. Retention remains dry-run/BLOCKED with no deletion
candidates; restore-baseline and latest-attempt receipt linkage remain required.

Rollback, if explicitly needed: acquire both existing launcher/watchdog mutexes,
verify installed SHA256 equals deployment.json afterHash and retained rollback
equals beforeHash, validate the same ACL/actions and atomically replace from a
new restricted copy of the rollback file. Retain both originals and receipts;
fail on drift/busy tasks. Task-disable fallback uses only the two exact task names
listed above. No backup or source-service change is needed.

## Isolated application/database cold rebuild preparation (2026-10-15)

`cold-rebuild-plan-v4.md` records the consumed fresh04 scope for
`sl-cold-rebuild-20261015-04`; one authorized invocation completed overall PASS. The historical
`cold-rebuild-plan-v3.md` remains consumed/BLOCKED. `cold-rebuild.py` creates fresh owned DB resources
from a verified formal daily generation and independently installs locked npm
dependencies, generates Prisma client and compiles an isolated workspace.
`cold-rebuild-{config,credentials,runtime,sql}.cjs` validate private config,
recover isolated SCRAM credentials, verify restricted-role SQL and HTTP smoke,
and stop owned processes. Source service/OS/WSL/Rancher are not restarted; this
is not whole-host cold recovery. Secret-store retrieval and OS/engine acquisition
are explicit preconditions, not accepted runtime capabilities. See the plan for
exact authorization, timing boundaries, background writes and safe stop.

Offline checks (no Docker/DB/migration):

```sh
python3 -B tools/dev/cold-rebuild.test.py
node tools/dev/cold-rebuild-config.test.cjs
node tools/dev/cold-rebuild-runtime.test.cjs
node tools/dev/cold-rebuild-credentials.test.cjs
```

All historical live drivers/runs remain consumed. Do not execute the new launcher
without separate approval of the precise scope in `cold-rebuild-plan-v4.md`.

Cold rebuild install failure analysis: `cold-rebuild-install-postmortem.md`.
The consumed run failed before DB allocation because npm user/global config
shared /dev/null. The launcher now uses distinct private files and a real npm
preflight before install, with failure-stage receipts. Before a fresh live run,
include this no-install parser regression in offline acceptance:

```sh
python3 -B tools/dev/cold-rebuild-npm.test.py
```

Cold rebuild v2 `sl-cold-rebuild-20261015-02` is now consumed: install, Prisma
generate and build passed; config validation rejected the existing schema=public
URL query before DB allocation. `cold-rebuild-plan-v2.md` is historical scope.
Current executable bindings use consumed04; DO NOT REPLAY. Consumed01/02/03
authorizations fail before I/O; existing04 evidence blocks reuse.
All consumed evidence is retained. V3 permits only absent query or single
schema=public, then normalizes every consumer to isolated loopback55433 without
query. Actual-file no-connect preflight uses root dotenv during preparation only:

```sh
node tools/dev/cold-rebuild-config.cjs --preflight
```

Future live independently reinstalls dependencies and repeats config validation
with fresh04 dotenv. Current preparation receipts/hashes are under
`artifacts/local-env/sl-cold-rebuild-preparation-20261015-v4/`; run01–03 and their
preparation evidence remain retained and must never be reused. See `cold-rebuild-plan-v4.md` for the single
precise scope. Offline PASS does not authorize DB/app lifecycle.

Run03 reached service-ready49.8001s after successful snapshot comparison and
restricted-app smoke, but overall result remains BLOCKED because strict post-stop
bind saw TIME_WAIT. Same-host postcheck confirmed no listeners, owned PG stopped
and source healthy. Future tooling now tests refused connections after stop while
retaining strict bind collision checks before launch; offline18+4 tests passed.
No consumed result was rewritten to PASS; no replay occurred. A future live must
use the prepared fresh04 identity and obtain its precise authorization.

Port cleanup cause, evidence, corrected preflight/post-stop semantics and regression
coverage: `cold-rebuild-port-cleanup-postmortem.md`. Future result.json records
both ports independently in portClosure and a nonempty cleanup-failure reason.

Fresh04 preparation: lifecycle23 + npm4 + config32 + runtime3 + credentials3
(65 tests) PASS; actual no-connect escrow and real no-install npm preflight PASS.
Run04 subsequently passed full live acceptance: service-ready42.0815s, total46.0135s,
exit0, cleanupFailures empty; owned PG stopped, source healthy, both ports refused.
Same-context independent postcheck PASS. All evidence/build/cache/volume/network
retained; prepared hashes unchanged. This is isolated app/DB recovery on existing
infrastructure, not whole-host recovery or SLA. Run04 is consumed; no replay.
