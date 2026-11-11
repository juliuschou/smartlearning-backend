---
name: run-smartlearning-backend
description: Run, build, smoke-test, and record the SmartLearning NestJS backend and its WBS 1.1–1.4 checks, including migration/OpenAPI evidence. Use when asked to run the backend, validate the backend baseline, or record CI-equivalent results.
---

# Run SmartLearning Backend

Run commands from the backend repository root. The primary agent path is the driver below: it executes the repository's lint, unit-test (or explicit skip), typecheck, build, and OpenAPI export checks; starts the built NestJS service; and interacts with `GET /openapi.json`. It stores a sanitized JSON summary under ignored `artifacts/`. It never starts Docker, connects to PostgreSQL, applies migrations, or removes resources.

## Prerequisites

- Node.js 22 and npm, matching `.github/workflows/ci.yml`.
- Repository dependencies installed from the existing npm lockfile. Dependency installation was not part of the verified run in this session.
- For CI-equivalent database evidence, access to the fresh-database CI job/artifact, or separately authorized access to a newly created isolated disposable PostgreSQL database. Never use a development or shared database for this check.

## Run (agent path)

Run the full non-database verification and live HTTP smoke check:

```sh
node .claude/skills/run-smartlearning-backend/driver.mjs all
```

The driver can also be invoked with `checks`, `smoke`, or `audit` as its single mode argument. `smoke` requires a current `dist/src/main.js`; `all` builds before it starts the service. The HTTP check binds an unused local port, enables OpenAPI for this test process, requires a valid OpenAPI 3 response, then stops only the process it launched. Inspect the printed `results_file` for per-check PASS, FAIL, SKIPPED, or BLOCKED status. A passing smoke test only proves the backend skeleton responds; it does not prove business endpoint behavior.

## WBS evidence and safety

- **WBS 1.1 — schema and migrations:** The maintained ER-model DDL is currently `prisma/migrations/20261105000000_init_app_schema/migration.sql`, with the Prisma representation in `prisma/schema.prisma`; no separate `er_model_postgresql.sql` was found. Use `.github/workflows/ci.yml`'s `database-migrations` job as the fresh-database migration authority and retain its successful artifact. Do not run `db:dev:*`, the legacy fixed-project `db:test:up`, or `prisma:dev:deploy` as a substitute for an isolated fresh-database run. Any local Docker creation, migration/DDL, or cleanup requires explicit task authorization and a fresh read-only identity/resource preflight under repository Docker rules. Never remove a retained volume to make a run pass.
- Check table and column descriptions against the authoritative GLOSSARY and the live catalog only when a specifically authorized isolated DB is available. Driver comment counts are inventory hints, not proof every column has a comment. Record discrepancies; do not silently alter the source SQL in a verification run.
- Make future schema changes as additive, forward-compatible migrations first; defer destructive/contracting changes to a separately reviewed rollout. Verify each migration chain from an empty disposable database.
- **WBS 1.2 — errors and pagination:** Confirm actual maintained handlers/DTOs/services and executable tests before marking these features complete. Test generic account-sensitive error responses and pagination contract edge cases (empty result, final page, out-of-range page/cursor exhaustion, invalid parameters, stable ordering, no overlap/gaps). This backend currently has no business API paths; do not infer these behaviors from schema fields or planned work.
- **WBS 1.3 — OpenAPI and client:** `npm run openapi:export` validates/exports the backend OpenAPI document. Compare actual endpoint/DTO names with the authoritative GLOSSARY at `/home/user/projects/smartLearning/docs/智學互動平台/20_系統分析/GLOSSARY.md` when available. The backend does not own `packages/api-client`; client generation belongs to the frontend project. An empty `paths` object is not evidence that business client generation was validated.
- **WBS 1.4 — CI and recorded results:** Review the current workflow definitions and download the run-specific migration artifact; do not report old artifacts as current-run evidence. The driver writes a per-run summary but marks database migration `NOT_RUN` because it deliberately does not mutate Docker/database state. A DB result is complete only with fresh-run identity, successful migration ledger, and no failed/pending migrations.
- The frontend `/admin` and `/learner` shells are outside this backend-only skill's scope.

## Troubleshooting and known limits

- **No unit specs:** the driver records `SKIPPED` when there are no `src/**/*.spec.ts` files, matching the CI skip condition; this is not a test pass.
- **HTTP smoke is BLOCKED after a failed build/check:** fix or explain the check failure first; the driver will not run stale `dist` output in `all` mode.
- **Migration or column-comment status is unknown:** do not use a shared DB or reuse a retained test volume. Use a fresh authorized disposable database or the matching CI run artifact. If neither is available, record BLOCKED/NOT_RUN.
- **No business routes in OpenAPI:** the smoke test validates the running NestJS/OpenAPI skeleton only; feature acceptance remains unverified until maintained route and regression-test sources exist.
