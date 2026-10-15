# Isolated cold rebuild v3 — 2026-10-15

Status: CONSUMED — one authorized invocation executed; DO NOT REPLAY.
Run03 restored and reached service-ready in49.8001s; final strict-bind cleanup
check failed on TIME_WAIT. Original overall result remains BLOCKED. Independent
same-host postcheck: source healthy, owned PG exited, both ports ECONNREFUSED.
A future-only tool fix uses refused connections after stop, retains strict bind
before start, and passed offline tests. No live rerun validated that fix.
Fresh identity `sl-cold-rebuild-20261015-03`; consumed01/02 evidence, build/cache,
resources and historical plans remain untouched. This is one preparation checkpoint.

## Scope and failure model

Reconstruct a missing application workspace/dependency tree and missing PostgreSQL
cluster from formal backups, with existing Windows/WSL/Docker infrastructure.
This measures **isolated application/database rebuild RTO**, not whole-host cold
recovery. Windows `DESKTOP-0KADDT9`, WSL Ubuntu/user and Rancher Docker are evidenced
in tools/dev/README.md deployment contract; these are prerequisites, not restarted.
The exact default engine and PostgreSQL image are pinned in local-db.py:
`8820f44b-5227-4afe-8eff-245fcc9e8a31` and
`sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54`.
Source is exact container
`d053acc4d005b7484ca06dfe5b2d73a7908265e8c9edb580638c99eb26601c4d`;
it must remain healthy/running. Source data before/after hashes are not claimed.
No source stop/restart, host/WSL/Rancher restart, Snapshot, scheduler changes,
second copy, retention deletion, migration, seed, truncate or DB-backed Jest.

New owned resources: `sl-cold-rebuild-20261015-03-pg`, `-data` volume and `-net`
bridge network, exact run label, restart=no, user999:999, pinned image. DB host
publication is only 127.0.0.1:55433. App is only 127.0.0.1:3001: workspace copy
of src/main.ts receives one documented listen-address patch, with separate root
and workspace hashes; repository application source is not changed. App runs as
current WSL user with restricted restored DB role, never admin. No preexisting
consumed cluster or retained volume is reused. Name/port collisions fail closed.
The source and isolated DB share the existing engine; no daemon outage is simulated.

## Dependencies, config and secrets recovery contract

- Node v26.5.1, npm11.17.0, Python3, Docker CLI/default engine, Windows
  PowerShell/WSL interop and verified Windows D mount must already be available.
  Pinned PG image must already be available. No engine installation/pull/start.
- Repository source, package-lock.json, Prisma schema/migrations and tool sources
  must be recoverable. New private build copies source/config/lock only, no .env,
  root node_modules, generated or dist. Two distinct empty mode0600 npm user/global
  config files and a fresh private npm cache isolate the installation.
  `npm ci --ignore-scripts --no-audit --no-fund` installs locked dependencies, then
  `npm run prisma:generate` and `npm run build`. Registry access/npm package
  distribution and Prisma binary acquisition may be needed; fail after bounded
  deadlines rather than reuse warm root assets. Package lifecycle scripts are
  disabled; runtime smoke will fail if a required native artifact is unavailable.
- `.env.test` at repository root is the explicit local secret escrow, mode0600,
  regular non-symlink file, owned/managed by the operator. Restore this file from
  the operator's approved secret store BEFORE launching; set umask077, install
  to a private file, verify permissions and required key presence without printing
  values. No external secret-store backup is evidenced here, so secret-store/OS
  disaster recovery is NOT accepted by this drill. Its manual retrieval time is
  excluded and must be reported separately if whole-environment RTO is needed.
  Existing `/tmp` contracts are never inputs. Source escrow remains unchanged.
- Required keys: DATABASE_URL (source contract loopback:5432/smartlearning_test,
  restricted username and nonempty password), COOKIE_SECRET, CORS_ORIGIN,
  PORT=3001; NODE_ENV absent/test. Original COOKIE_SECRET preserves cookie
  verification semantics. Runtime explicitly overrides DB endpoint to55433.
  All schema checks use the original restricted role. Globals backup excludes
  role passwords: after data comparison, restore only this role's password from
  escrow via protected psql stdin; use SCRAM host rules and assert a deliberately
  wrong password fails with28P01, then actual password passes read-only SQL.
  No app privilege grants, ownership transfer, new executor or admin substitution.
- Runtime env is allowlisted to DB URL/cookie/CORS/port plus test and local
  policies. Redis off; login limiter memory; deletion manifest local; retention
  defaults disabled. Reject injected alternate DB URLs, Redis endpoints, S3,
  bootstrap credentials, failpoints and loader overrides. No external Redis/S3
  provisioning or acceptance is implied.

## Ordered execution and acceptance

1. Start monotonic RTO before backup validation or workspace creation. Require
   exact explicit authorization and unused evidence directory. Enforce25min
   execution deadline; intake receipt includes launcher PID.
2. Verify mounted daily-v1 destination, newest formal published generation only,
   immutable success manifest/payload SHA256/Windows ACL, engine/image/source
   identity and per-database snapshot baseline. No corrupt-newest fallback.
3. Validate resource/port absence; independently reconstruct dependencies/client/
   build. Validate recovered secrets contract before allocating DB resources.
   Before install, real npm --version runs against the exact isolated build
   environment (10s timeout), with a private npm-preflight.json result. A failed
   preflight blocks install. Install/generate/build persist sanitized stage
   status/exit/time receipts, including failure paths; no raw output is retained.
   Build occurs early because the forwarding/SQL checks also need fresh pg/dotenv.
4. Create labeled fresh network/volume/container, initdb, readiness. Restore globals
   and postgres/smartlearning_test archives. Compare each database against its
   own exported snapshot: data hashes/counts, objects/constraints/indexes/ACL,
   extensions, no unsupported sequences/large objects. Compare database properties.
   Verify independent system identifier, exact cluster/DB/role/schema/primary.
   Cross-database atomic snapshot consistency is not claimed.
5. Only after data equivalence: configure observed private forwarded peer /32 HBA,
   recover isolated app SCRAM password, reject wrong password; verify actual
   restricted app role, all migration names/checksums and completion, mapped
   schema columns and table counts using READ ONLY SQL. No migrate command runs;
   pending/divergent ledger fails and requires a separately revised plan.
6. Start compiled app; normal auto-close and realtime expiry/claim/cleanup writers
   are explicitly permitted ONLY in isolated restored DB after the comparison
   barrier. No requirement for post-start row-count equality; report its digest
   equality, require identity/schema/migration equality after app shutdown.
7. Accept HTTP readiness200/status ok/DB healthy/Redis off/limiter memory and valid
   timestamp; liveness200 plus unauthenticated GET /api/v1/auth/session401.
   These are minimum dependency/auth-boundary smoke, not a full user-flow E2E.
   No skipped acceptance path; any missing marker/nonzero process/timeout fails.
8. Stop owned app group; assert3001 closed; postcheck DB, reverify backup hashes/ACL,
   stop owned PG; assert55433 closed and source still healthy. Retain all assets.

## Timings and safe stop

`build-receipt.json` records install/generate/build seconds. `result.json` records
restoreAndCompareSeconds, appReadinessSeconds, serviceReadyOffsetSeconds,
serviceReadySeconds (launcher start through last functional smoke),
appCleanupSeconds, runtimeIncludingCleanupSeconds and totalSeconds including
postchecks/cleanup. Service-ready occurs BEFORE app shutdown and cleanup. RTO
includes current engine validation, backup verification, dependency downloads,
restore, build/start and acceptance; excludes prior approval, OS/engine acquisition,
manual secret retrieval and source artifact recovery. No invented outage interval:
start models loss of isolated workspace/DB, not source service interruption.
One observed run is not an SLA, RPO guarantee or whole-host RTO.

Stage bounds: install600s, generate/build180s each, DB archive operations240s each,
Docker calls60s (startup probes bounded40 attempts), runtime120s, plus25min
overall deadline. Stop uses45s Docker timeout/30s grace. On SIGTERM/SIGINT/alarm,
unwind finally, terminate owned npm sessions and runtime child/app group; reconcile
ambiguous container creation by exact name AND full ownership metadata before stop.
Never stop an unverified resource. Record BLOCKED/cleanup uncertainty; do not retry
consumed run, restart initdb, delete resources or restore onto source.

Normal execution automatically stops owned resources. For early stop send SIGTERM
to the exact launcherPid from private intake.json after checking its command/run.
If launcher is lost/SIGKILL, inspect owned.json and exact label/image/mount/network/
port/ID with `cold-rebuild.py --check-restore ID` before a manual owned-container
stop. That check needs a running DB; if it cannot pass, inspect static ownership
and obtain incident-specific stop approval rather than guess. Inspect process
session/command before terminating any orphan app group. Close both loopback
ports; retain every backup, volume, network and receipt. A failed cleanup is a
failed run, not an automatic source rollback. Kernel/SIGKILL recovery remains
an operational limitation.

## One precise live authorization request

Authorize one invocation below, up to25min plus bounded cleanup, with npm registry/
Prisma binary access; read newest verified formal daily backup on D and source
identity/health; create the exact three fresh isolated resources; restore globals
and both DBs (DDL/data writes ONLY there); set the restored restricted role's
SCRAM password and isolated peer HBA; build/run restricted app with its normal
background writes; perform read-only SQL/HTTP acceptance; stop only owned app
and PG, retain all assets. If blocked, stop/report rather than replay. No migrations,
DB-backed Jest, truncation, source writes/stops, engine/host restart, Snapshot,
retention or deletion is included. OS Docker-socket escalation is separate.

```sh
SL_COLD_REBUILD_AUTHORIZATION=sl-cold-rebuild-20261015-03 \
python3 -B tools/dev/cold-rebuild.py
```

Preparation/offline tests do not authorize or prove live recovery. Latest completed
shared-helper/runtime acceptance remains PASS; this v3 scenario is consumed;49.8001s is observed service-ready time, with overall cleanup acceptance BLOCKED.

## Preparation verification gate

Before any future invocation, compare current tool/source SHA256 with the private
preparation receipt in artifacts/local-env/sl-cold-rebuild-preparation-20261015-v3/.
Confirm run03 evidence/resources/ports are unused using exact live preflight;
preparation does not access Docker or claim current resource absence.
Run01 and run02 authorizations are rejected before I/O; executable code paths refer only to
run03 build, cache, evidence and cluster. A run03 evidence collision refuses replay.
Real no-install npm regressions include the original double-load failure and
corrected shared launcher environment. Prior consumed workspaces/caches are never reused.

Offline commands:

```sh
python3 -B tools/dev/cold-rebuild-npm.test.py
python3 -B tools/dev/cold-rebuild.test.py
node tools/dev/cold-rebuild-config.test.cjs
node tools/dev/cold-rebuild-runtime.test.cjs
node tools/dev/cold-rebuild-credentials.test.cjs
```

No offline result proves dependency downloads/native module usability, restore,
credential recovery or service readiness. Those gates execute once only after
live approval, with at most25min plus bounded cleanup. Failure consumes the run;
stop/report, retain evidence, never automatically retry.

## Configuration compatibility gate (v3)

Only no query or one decoded `schema=public` pair is accepted. Every connection
consumer uses the same `isolatedURL` normalizer: fixed127.0.0.1:55433,
smartlearning_test and validated credentials; query/fragment are absent.
Duplicate (including encoded duplicate), routing, unknown and alternate schema
parameters fail before any client connects. Escrow is never edited.

Preparation executes root dotenv solely to parse the actual private escrow in
memory, without inspecting dependencies or connecting. This is NOT independent
dependency recovery. `node tools/dev/cold-rebuild-config.cjs --preflight` emits
only status/noConnection/isolatedTarget booleans; its regression disables socket,
HTTP/TLS/UDP and child-process APIs. Live uses only fresh03-installed dotenv after
a new npm ci/generate/build; `configuration.json` records PASS or a sanitized
CONFIGURATION_REJECTED category before resource creation. No raw assertions,
credentials, URLs or subprocess output are retained. Actual-file preflight PASS
does not establish SCRAM/restore/app readiness; these remain live acceptance.

Before live, compare prepared-source-hashes.json against current files, run the
actual-file no-connect gate again, then perform exact live collision/identity
preflight. Preparation does not claim current ports, engine health or resource
absence. The live evidence directory must not exist. No consumed run is resumed.
