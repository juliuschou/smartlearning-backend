# Test database mutation guards

`setupTestDb()` is asynchronous: callers must await it. `truncateAll()` checks
identity and truncates using the same Prisma interactive transaction/connection.
No database operation was authorized or performed when implementing these guards.

Integration/e2e configs preload the guard before suite imports can load dotenv.
Custom runners must preserve this ordering.

The launcher must supply all of these **before module loading**, outside dotenv:

- `NODE_ENV=test`
- `TEST_DB_MUTATIONS=migrate,truncate` (only operations specifically authorized)
- `TEST_DB_CONTRACT=/absolute/path/to/reviewed-contract.json`
- `TEST_DB_CONTRACT_SHA256=<independently reviewed SHA-256 of exact file bytes>`

Contract shape (placeholder values are not a usable target):

```json
{
  "db": "smartlearning_test",
  "role": "REVIEWED_APP_ROLE",
  "schema": "public",
  "cluster": "REVIEWED_CLUSTER_NAME",
  "system": "REVIEWED_NUMERIC_SYSTEM_IDENTIFIER",
  "recovery": false,
  "endpoint": "REVIEWED_POSTGRESQL_URL"
}
```

The endpoint must exactly match the loaded DATABASE_URL. The contract contains
credentials: keep it outside version control with private file permissions; do
not print it. Build expected identity from independently reviewed provisioning /
restore evidence, not by accepting whatever a candidate connection reports.
The digest is a launcher trust input, not a signature against a hostile launcher.
No real contract is published by this change: existing evidence is not silently
converted into permission for future mutations. A missing contract blocks.

Identity uses existing cluster/schema/primary predicates plus
`pg_control_system().system_identifier`. If the app role cannot read this,
execution blocks; this change does not grant privileges or switch to an admin role.
A separately reviewed least-privilege identity mechanism is required before live
verification if the existing role lacks permission.

Migration uses a separate Prisma CLI connection, pinned to the checked URL in
its child environment. Endpoint replacement between verification and CLI connect
remains a race; this is not an atomic identity guarantee for migration. Only use
an isolated, stable endpoint under reviewed lifecycle control. Prisma config
must continue to respect the supplied DATABASE_URL (dotenv currently does not
override it). Migration subprocess output is suppressed and errors are redacted.
Truncate uses statement/transaction deadlines; CASCADE can reach dependent
objects outside public, so the database must be dedicated to these tests.

Scope: the two shared helper entry points and their awaited suite callers.
This is not a general SQL firewall. Direct application writes, load-harness
cleanup, raw Prisma calls, and manual CP5/6/7 verifiers that address external
backends do not gain protection merely by this change. Some existing suites
catch setup failures and skip: a skipped suite is not DB-backed verification.
The app factory can start background writers; these are not authorized by a
successful read-only guard. Do not launch a DB-backed suite without a separately
reviewed isolated target and explicit authorization of all its mutation effects.

Offline verification (no DB setup/global setup; pg, dotenv and CLI mocked):

```
npx jest --config test/jest-mutation-guards.json --runInBand
npm run typecheck
npx eslint test/setup/db.ts test/setup/mutation-guard.ts test/mutation-guards.offline-spec.ts
```

Live follow-up requires specific authorization of migration/truncate on a pinned
isolated test target, retained backup and expected identity/role capability review.
Do not use integration/e2e commands as a read-only diagnostic.
Rollback: revert these source changes and awaited callers only; no schema,
role, configuration, or database rollback is needed for this offline checkpoint.
Do not bypass the guard as an operational workaround.

Preparation follow-up (2026-10-15): dotenv now preserves launcher values
(`override: false`), including the isolated DATABASE_URL.
`tools/dev/prepare-test-contract.cjs` generates a private expected contract from
SHA-256-pinned retained restore receipts plus existing provisioning credentials;
it never queries a candidate database or authorizes mutations. Current app-role
capabilities remain unverified while the retained cluster is stopped.
See `tools/dev/isolated-test-entry-plan.md` and the gated
`tools/dev/test-entry-role-check.py` continuation/read-only audit. This driver
contains no migrations, truncate, grants, or app startup.

Execution-role preparation (2026-10-15): the actual app role passed restricted
identity/system-read checks but lacked schema CREATE, all-ledger-DML and all-table
TRUNCATE capability. See `tools/dev/isolated-execution-role-plan.md` for the new
isolated-only owner/executor policy, separate-process contract loading, fail-hard
negative/shared-helper/readiness suites, precise live authorization and rollback.
These tools are prepared offline; they have not run live. The shared single-role
contract remains unchanged: executor and app run in different processes rather
than switching URLs after guard or application modules are imported.

Live acceptance completed after explicit authorization (2026-10-15):
`sl-test-runtime-20261015-02` passed both real-helper negative cases, real shared
migrate-deploy/truncate and original restricted-app readiness HTTP200, zero skips.
No pending migrations were applied; app table/schema privileges were unchanged.
Owned continuation stopped, original isolated HBA restored, source operational
health preserved. See that run's private `verified-summary.json` and tasks/todo.md.
This consumed run is not permission to replay or use guards against source.
