# Checkpoint L — repository-only AUDIT diagnosis (2026-10-14)

## Result

No demonstrated SQL correction. K root cause remains UNKNOWN. Do not reuse I approval or run the existing G entry: its names/evidence are consumed.

## Evidence and boundary

- `artifacts/local-env/sl-i-20261014-01/k-diagnosis.json` records failure at lifecycle sequence 217, after migrations, completion/checksums, zero-row checks and grants succeeded.
- `checkpoint-f.py:run` discards stderr and raises `Subprocess blocked` for nonzero exit. `sql` calls psql with stdin, `-X -qAt -v ON_ERROR_STOP=1`, then parses JSON. `migrate` requires AUDIT to return the Python singleton True before application TCP authentication and before environment preparation.
- Consequently, a failing subprocess differs from a successfully executed audit returning false (which raises `Effective role privileges mismatch`). Neither SQL syntax error nor privilege mismatch can be attributed from retained evidence alone. Docker exec failure is also not excluded.
- Closest F migration regression simulates True/False audit output; G runtime fixture simulates SQL. Neither executes PostgreSQL SQL. Passing these tests does not establish syntax, catalog resolution, overload resolution or planner/runtime behavior.

## PostgreSQL 16 documentation review

- [Access privilege inquiry functions](https://www.postgresql.org/docs/16/functions-info.html#FUNCTIONS-INFO-ACCESS-TABLE): comma-separated privilege strings mean ANY listed privilege. Existing SQL correctly uses individual checks for required table/sequence grants and negated combined checks for forbidden grants. Documented database privileges include CONNECT, CREATE and TEMP/TEMPORARY; schema privileges USAGE/CREATE; sequence privileges USAGE/SELECT/UPDATE.
- [pg_sequences](https://www.postgresql.org/docs/16/view-pg-sequences.html): `sequenceowner`, `schemaname` and `sequencename` are documented columns. No evidence supports renaming these columns.
- Static review found no demonstrated defect in these constructs. This is not a successful SQL parse or PostgreSQL execution proof.

## Verification

`python3 -B tools/dev/checkpoint-{e,f,f-env,g}.test.py` individually: 6 + 23 + 18 + 19 = 66 PASS. Default G CLI: REVIEW_ONLY, separated-roles, unchanged hash `e6b0dd19379ccc391a99de9cdf58f0e2a6973d74b064d4708d15c250e46229fe`. `git diff --check`: PASS.

No production tooling/policy change or regression test was added because no defect/repro was established. No Docker queries/lifecycle, SQL, migrations, real env access, application suites, cleanup, commit or push.

## Next checkpoint proposal (repository preparation only)

Prepare a separate SQL-only diagnostic harness and reviewed scope before any live approval request. It must define fresh names/evidence identity, pinned image/runtime and strict ownership/mount/consumer guards; never restart/adopt H/K resources. Use synthetic independent credentials via protected stdin/storage, no real env access or backup publication. Reproduce role setup and a minimal synthetic schema including `_prisma_migrations`, an application table and a sequence, then execute exact AUDIT. Include positive grants and missing/forbidden-grant negative cases; record only fixed check identifiers, boolean results and allowlisted SQLSTATE classification (not raw error text/query/credentials). A minimal schema validates SQL and representative privilege semantics, not the full 20-migration schema.

Implement container-free tests for diagnostic failure, fail-closed publication boundaries and sanitized evidence first. Present exact resource identities, command, contract hash, permitted lifecycle and retention/rollback scope for separate explicit authorization. Migration/full-schema reproduction, if later necessary, requires its own explicit permission. No live diagnostic attempt is approved by this document.

Local development baseline remains incomplete; historical development data authority UNKNOWN. Stop at AGENTS.md manual gate after L.
