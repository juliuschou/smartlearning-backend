# Isolated execution role / runtime acceptance (2026-10-15)

Status: live authorized and completed PASS on 2026-10-15. Run
`sl-test-runtime-20261015-02` is consumed; do not replay this command/container.
Four live processes passed with zero skips, readiness HTTP200/db healthy, app
privileges unchanged and owned-resource stop/HBA restoration postchecks PASS.
Evidence: `artifacts/local-env/sl-test-runtime-20261015-02/verified-summary.json`.
The preparation and exact authorized scope below are retained for audit.

## Roles and migration review

`isolated-role-policy.cjs` generates provisioning SQL, with identifier quoting and
fixed executor `sl_isolated_test_executor`. Existing `full_restore_admin` is used
only over the owned container's local socket to verify identity, read catalog /
ledger / app privilege snapshots, create the executor and transfer public table
ownership. Neither Jest nor Prisma nor the application receives admin credentials.

Executor: LOGIN, random private 256-bit password, NOINHERIT, NOSUPERUSER,
NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS; CONNECT on the exact test DB,
USAGE/CREATE on public, EXECUTE on the identity function, ownership of restored
public tables including `_prisma_migrations`. Ownership provides ledger DML,
TRUNCATE and ALTER/DROP/RESTART capabilities; table grants alone cannot support
arbitrary migration DDL. No database/schema ownership, membership grants, global
REASSIGN OWNED, app grants, default-ACL changes or source-role changes.

Reviewed 20 migration files: table/constraint alterations, table/index creation,
index drop, UPDATE backfills, INSERT SELECT and three DO invariant checks. No
extension installation or elevated DDL is required by this set. Nonetheless this
acceptance deliberately requires the exact applied migration names AND SHA-256
checksums in the restored ledger. Pending/drifted migrations block before role
DDL. `setupTestDb()` invokes the real CLI but should have nothing pending. This
proves the real guarded migrate-deploy path, not application of new DDL. A future
pending migration needs its own app privileges and ownership review; no default
app grants are silently installed.

Pinned inventory currently has ordinary public tables, zero sequences and no
other application schemas. Launcher rejects partitions/views/sequences, nonpublic
relations and extension-owned public relations before provisioning. Suite also
checks cross-schema foreign keys and inheritance before truncate. The entire DB
must be exclusive/disposable: helper CASCADE is not a SQL firewall.

App remains its existing restricted LOGIN role. Effective per-table privileges
(SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER) and public USAGE/CREATE
are compared before provisioning, after ownership transfer and after app exit.
The app suite asserts no elevated role flags and matching expected identity.
No source database SQL is issued; source running/healthy is an operational
postcheck, not a source data hash comparison.

## Implemented execution

`isolated-test-runtime.py` is a fresh one-shot driver, run ID
`sl-test-runtime-20261015-02`. It reuses the exact retained daily volume/network,
image, engine and original-container pins from the consumed read-only driver;
it never replays that driver or its initdb command. It requires the exact
`ISOLATED_MUTATION_AUTHORIZATION` value before Docker access. It checks original
stopped, no running volume consumers, unused container/evidence name, free
127.0.0.1:55433, and source operational health. It creates a new direct-postgres
continuation and verifies its shape/unique consumer before dispatch.

Temporary isolated HBA entries copy only the existing app's exact test-DB RFC1918
IPv4 /32 peers, changing the role to executor and authentication to SCRAM. Missing,
public, loopback or broad peer rules fail closed. Original HBA bytes are retained,
restored/reloaded in finally, then only the owned new container is stopped.
Existing app HBA lines stay intact. No source HBA is read or changed.

`isolated-live.cjs` verifies private app contract mode/hash, loopback endpoint and
expected DB/cluster/system/primary through the local provisioning connection
before DDL. Executor contract copies those independent expectations, replacing
only the separately provisioned role/credential. It is generated in a mode0700
/tmp directory, mode0600 file; never printed or committed.

Each acceptance phase is a separate Jest process with its contract/URL and
mutation authorization installed before the guard preload and dotenv imports:

1. Executor connection inserts a nonempty sentinel; negative suite runs with no
   mutation authorization. Both real helpers must reject; sentinel count survives.
2. Separate process uses a digest-pinned deliberately wrong system expectation.
   Both real helpers must reject; sentinel count survives.
3. Executor suite runs real `setupTestDb()`, inserts another sentinel, runs real
   `truncateAll()` and checks every eligible table empty and applied ledger kept.
4. Fresh app process gets only the original app URL/contract, Redis off, memory
   limiter and empty bootstrap-admin overrides. Real app factory/init may perform
   direct/background writes in this disposable DB. HTTP `/health/ready` must be
   200, status ok and DB healthy; app closes in finally. Readiness scalar receipt
   is retained. Guard's `truncate` authorization here is only for identity contract
   loading; app suite never calls truncate or migration.

Every process must pass exactly one test, with zero pending/todo; errors/timeouts
fail hard. Jest raw reports remain in private evidence because error reports may
contain SQL or credentials. Output is redacted. Parent owns a process group and
kills remaining descendants before DB cleanup. SIGTERM/SIGINT unwind through cleanup;
repeated soft signals are ignored during cleanup. SIGKILL/host loss cannot be
handled: retained ownership receipts must guide manual recovery. Endpoint precheck versus Prisma's
separate CLI remains a race: use the exclusively owned stable Docker endpoint,
never claim atomic migration identity enforcement.

## Stop, retention and rollback

Always stop the owned continuation and restore HBA; keep volume/network, private
contracts, all receipts and formal backups. Cleanup errors produce BLOCKED_CLEANUP,
never PASS. Postchecks require port closed, no running isolated consumers, source
running/healthy. No deletes, retention, seed, db push, scheduler or Snapshot work.

Before role DDL, save private original-owner rollback SQL and app privilege
snapshot. `rollback-roles.sql` restores each exact original owner, revokes the
executor's schema/database/function grants and drops only that executor, in one
transaction. It is NOT run automatically. Run it only after a separately reviewed
owned-container continuation and DB/cluster/system verification, using the same
local admin socket. It does not undo truncate or background writes: recovering
contents requires a new isolated restore from the retained formal backup. Never
restore these changed contents into source. Failure after provisioning leaves
stopped isolated resources for diagnosis, not an automatic replay candidate.

## Exact next live authorization

Authorize one run of `sl-test-runtime-20261015-02`: new direct-postgres continuation
on retained `sl-daily-runtime-20261015-01-data` and `-net`, pinned image/engine,
loopback 55433; isolated startup writes; temporary exact-peer executor HBA/reload;
local-admin identity/catalog checks and the bounded role creation/ownership/grants
above; private execution contract generation; sentinel INSERT, two negative
shared-helper cases, real migrate deploy (no pending migrations allowed), real
truncate of all eligible public test tables with RESTART IDENTITY CASCADE;
restricted-app initialization/background writes/readiness; app/worker stop,
original HBA restore and owned DB stop. Preserve source role privileges, source
service, all backups/evidence. No source SQL, data deletion outside the restored
test DB, db push/seed, rollback replay, Snapshot or retention deletion.

Prepared app-contract summary: `/tmp/sl-test-runtime-contract-preparation.json`.
Its file/digest must be read and verified at execution; if missing or changed,
rebuild offline from pinned receipts and review again rather than learning identity
from candidate SQL. Invocation after approval only:

```sh
ISOLATED_MUTATION_AUTHORIZATION=sl-test-runtime-20261015-02 \
python3 -B tools/dev/isolated-test-runtime.py \
  --contract /tmp/sl-test-contract-fA6OrY/contract.json \
  --digest 73553bad1d3a185ff19d4e3f40d0dc5b413d74744088880eb0d7abb51143c408
```

Live command passed after explicit user authorization and normal Docker escalation.
No pending migration DDL was applied. This result does not authorize replay, new
pending migrations, source mutations, cold recovery or retention deletion.
