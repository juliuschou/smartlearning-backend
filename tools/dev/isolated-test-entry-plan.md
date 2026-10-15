# Isolated shared-test entry acceptance — 2026-10-15

Status: preparation only; no live SQL, lifecycle start or mutations executed.

## Independent expected contract

Run `node tools/dev/prepare-test-contract.cjs`. It checks exact SHA-256 pins of
historical PASS/restore/owned receipts and builds a mode-0600 contract in a new
mode-0700 /tmp directory. No candidate SQL supplies expected values. The restored
system is 7696842547779285008; the source system must differ. Cluster is
sl-daily-runtime-20261015-01, database smartlearning_test, schema public, primary.
Endpoint is exclusively 127.0.0.1:55433. Credentials/expected role come from the
existing private provisioning .env.test; never print the contract. This is a
reproducible local review input, not a signed provisioning attestation. Historical
receipt pins establish target identity, not current role permissions or authority
to mutate. Review the generated digest before launch; do not learn identity from
an arbitrary successful connection.

## Exact proposed live authorization boundary

Run ID: sl-test-entry-20261015-01. Retain the existing formal daily backup,
historical receipts, original exited container and restored volume. Source port
5432, source container, globals/roles/HBA and all other databases are excluded.
No restore, backup deletion, retention delete, Snapshot, source restart or grants.

1. Read-only Docker inspect must match historical owned.json ID, exact image
   digest from tools/dev/local-db.py, label smartlearning.checkpoint equal to
   sl-daily-runtime-20261015-01, volume sl-daily-runtime-20261015-01-data,
   dedicated network sl-daily-runtime-20261015-01-net, and zero running volume
   consumers. Verify port 55433 free. Record sanitized hashes/boolean predicates.
2. Create exactly one continuation container sl-test-entry-20261015-01-pg:
   same pinned image and dedicated network, --restart no --user 999:999,
   --entrypoint postgres, mount only the retained volume at
   /var/lib/postgresql/data, publish only 127.0.0.1:55433:5432,
   command `-D /var/lib/postgresql/data -c listen_addresses=* -c
   unix_socket_directories=/tmp -c cluster_name=sl-daily-runtime-20261015-01`.
   Label with the new run ID. Never start the consumed initdb container.
   Lifecycle start permits PostgreSQL recovery/checkpoint writes to this isolated
   volume only. No network/HBA/auth changes if connection fails.
3. Using only the prepared URL and digest, run
   `NODE_ENV=test TEST_DB_CONTRACT=<private-path> TEST_DB_CONTRACT_SHA256=<digest> node tools/dev/test-role-audit.cjs`.
   This issues BEGIN READ ONLY, compares expected identity, checks restricted role,
   EXECUTE on pg_control_system, schema CREATE, table TRUNCATE and migration-ledger
   privileges. It emits booleans only; exit 2 means blocked, not success. Current
   permission audit has NOT run because the cluster is stopped.
4. If existing role passes, permit shared helper migration and TRUNCATE RESTART
   IDENTITY CASCADE exclusively in smartlearning_test on this volume. It is a
   dedicated disposable restore DB; destruction of its restored test rows is
   intentional. Before truncate, audit cross-schema dependencies; reject any
   non-public relation dependencies rather than expand scope. Migration CLI is a
   separate connection: keep sole volume consumer, fixed image/loopback port and
   unchanged resource ownership for the entire run; no atomic identity claim.
5. Use a dedicated fail-hard Jest config preloading mutation-guard.ts (same order
   as shared integration config), no global setup or catch-and-skip. Acceptance
   suite must call the real setupTestDb and truncateAll, assert zero remaining
   application rows and unchanged _prisma_migrations checksums. Require at least
   one successful test, zero skips and a receipt of both actual helper invocations.
   Negative contract (changed expected system), missing permission and wrong
   endpoint tests must reject before CLI/TRUNCATE; don't connect to source as a
   negative test. After positive truncate, start createTestApp, assert actual
   /health/ready HTTP 200 and db.healthy=true, then close in finally. Authorization
   includes application initialization/background writes only in this disposable
   smartlearning_test; no external Redis/services. Preserve launch URL through
   dotenv; require Redis off, memory limiter, retention/failpoints disabled.
6. Always close app/clients, stop only the new continuation container, verify no
   running volume consumers and free app/DB ports; retain stopped resources and
   backups, success/failure receipts and sanitized failure category. Never remove
   evidence or automatically restore/retry. If identity, capability or ownership
   fails, stop before mutations. Report which predicate blocked.

The executor and fail-hard live suite must be made reviewable before granting
execution; this document is an exact scope proposal, not an executable driver.
No DB-backed test command is currently represented as verified.

## Least-privilege decision

Do not replace the app role with admin or grant pg_monitor/superuser. If the audit
reports system_read=false, prefer a separately reviewed scalar SECURITY DEFINER
function in an admin-owned schema with fixed search_path=pg_catalog, returning
only pg_control_system().system_identifier::text; revoke PUBLIC EXECUTE and grant
only the exact test role USAGE/EXECUTE. That would require an explicit isolated
DDL/grant authorization and corresponding guard SQL/offline regressions first.
No wrapper/grant is applied or selected silently here. If migration/truncate
privileges are absent too, propose a separate test-only role on this isolated
cluster; never expand the production application role merely to run tests.

## Remaining gate

Actual app-role SQL capability is unknown. Existing evidence proves restricted
role flags/readiness, not EXECUTE/CREATE/TRUNCATE rights. No current claim of live
migration/truncate PASS. Cold boot, Snapshot and retention remain separately scoped.
Seven-day automatic scheduling is independent; no refreshed observation here.

## First executable authorization request

The stopped-cluster constraint requires a lifecycle authorization before SQL
capabilities can be truthfully established. The reviewable executor is
`tools/dev/test-entry-role-check.py`; unlike the later proposed mutation suite,
it is implemented now and cannot execute migration/truncate/grants/app startup.
Invoke only after explicit authorization:

```sh
TEST_ENTRY_LIFECYCLE_AUTHORIZATION=sl-test-entry-20261015-01 python3 -B tools/dev/test-entry-role-check.py --contract <private-path> --digest <reviewed-sha256>
```

This permits creation/start/stop of exactly the continuation above and PostgreSQL
startup writes only in the retained isolated volume; audit SQL is read-only. It
retains every backup and resource. No source operations. Missing capability
produces a bounded concrete role decision, not permission escalation. Subsequent
migration/truncate/runtime execution still needs its finished fail-hard suite
and a specific mutation approval. This narrower request is necessary because
the handoff excludes service starts and the actual role cannot be audited on a
stopped server; it is not a claim that role readiness is complete.

## Actual read-only outcome (2026-10-15)

The user authorized the first executable lifecycle/read-only scope. One-shot
run sl-test-entry-20261015-01 completed with BLOCKED_CAPABILITIES (exit 2).
The existing restricted login role successfully read pg_control_system and matched
the expected isolated system identity. schema_create=false, truncate=false and
migration_ledger=false (not all required ledger DML privileges). No system-read
wrapper or grant is necessary for this target. No mutation helper/app was run.
Continuation and original are exited; source is running/healthy; port 55433 closed;
no running volume consumers. Structured evidence: artifacts/local-env/
sl-test-entry-20261015-01/{result,postcheck}.json. Preserve this consumed run.

Next prepare a dedicated isolated test execution role for migration/truncate and
a fail-hard suite, retaining the restricted app role for runtime. Explicit role
DDL/grants and test mutations remain unauthorized. The earlier stopped-cluster
unknowns above describe pre-run state and are superseded by this evidence.
