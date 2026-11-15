# Handoff — SmartLearning Backend M01

**Date:** 2026-11-12
**Focus for next session:** Based on current development progress, continue M01 backend implementation without duplicating existing plans or specifications.

## Current status

- M01 Checkpoint A (contract inventory) is complete; details and requirement traceability are in `tasks/todo.md`.
- Checkpoint B implements the Login / Logout / login-session validation slice, CSRF and Origin protections, session guard and Prisma runtime wiring. Source is under `src/auth/` and `src/database/`; application wiring is in `src/app.module.ts`, `src/main.ts`, and `src/openapi.ts`.
- The approved implementation plan is `_plans/2026-11-12-m01-backend-implementation-plan.md`; current checkpoint decisions, implementation notes, results and limitations are recorded under Checkpoint B in `tasks/todo.md`.
- Checkpoint C (own profile and password change), D (password reset, shared send limits and mail adapter), and E (administrator bootstrap) have not been implemented. Do not begin them without following the checkpoint approval process in the plan.

## Verification evidence

The delegated verification run reported:

- `npm test -- --runInBand auth`: PASS, 8 suites / 28 tests.
- `npm run lint:check`, `npm run typecheck`, `npm run build`: PASS. Lint, typecheck and build were rerun after the final `main.ts` startup-validation change and passed.
- `npm run openapi:export`, `npm run openapi:client:check`, `npm run openapi:names:check`: PASS; names check reported 55 glossary rules.
- `git diff --check`: PASS.

These are unit/API and static checks, not PostgreSQL runtime evidence. No DB integration tests, Docker operations, migrations, DB mutations, or full runtime HTTP acceptance were performed. WBS M01 behavior and integration acceptance items remain unchecked; do not represent the checkpoint as fully end-to-end accepted.

## Decisions and operational cautions

- Approved session model: HttpOnly cookie, SameSite=Lax, signed double-submit CSRF, exact `CORS_ORIGIN` allowlist without wildcards, and reject mutations that lack an allowed Origin.
- Session expiry: 30-minute idle and 24-hour absolute; protected requests atomically validate and touch `last_used_at`. Login failures must not be throttled, delayed, or lock accounts.
- Example environment files were updated to `SESSION_ABSOLUTE_MS=86400000`; actual `.env*` files were not changed. If the runtime loads an old 8-hour value (`28800000`), startup validation fails closed. An environment owner must update the local/deployment setting before running the service under that configuration.
- M02/M04 role-disable immediate revocation integration remains outstanding; do not claim it is complete.
- DB-backed integration testing must use a newly created isolated disposable DB for that run, not the retained test DB or development DB. Docker startup, migrations and DB mutations require the repository's preflight and explicit authorization. Do not execute them as an assumed next step.
- Preserve pre-existing `.gitignore` and working-tree changes. `.gitignore`, package files, env examples, app files, `tasks/todo.md`, `_plans/`, and new auth/database paths are currently modified or untracked; inspect `git status` before editing and avoid reverting unrelated work.

## Suggested skills

- `run-smartlearning-backend` — for the project's prescribed non-DB backend checks and safe HTTP smoke workflow; review its scope before running.
- `security-review` — for a focused security pass over the authentication and session changes.
- `nestjs-expert` — when implementing the next NestJS slice (Checkpoint C), after reviewing the approved plan and project rules.
- `docker-compose` — only if a DB-backed test environment is later explicitly approved and the required Docker preflight/authorization is completed.

## Recommended next actions

1. Review Checkpoint B results in `tasks/todo.md` and the approved plan; verify the working tree before making edits.
2. Coordinate updating the runtime's actual session lifetime setting to 24 hours; do not edit real `.env*` files without authorization.
3. If DB-backed acceptance is requested, first provide the impact, data-safety, isolation, and rollback explanation, then obtain the required approval and create a fresh disposable DB according to repository rules.
4. Otherwise, stop at the current checkpoint boundary and obtain approval before starting Checkpoint C.
