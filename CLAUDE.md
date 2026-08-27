# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

SmartLearning backend for the 智學互動平台: NestJS 11 + Express, Prisma 7, PostgreSQL, and Socket.IO. The runtime is Node.js 24+ and the package manager is npm. M2 design decisions in `../docs/智學互動平台/` are authoritative when they cover the work; `SKILL.md` contains the fuller implementation history and invariant catalog.

## Before changing code

- Read `AGENTS.md` first; it defines operation and database-safety boundaries.
- Read the relevant design document under `../docs/智學互動平台/` and the related commit body before changing an established layer.
- Read `tasks/todo.md` and `tasks/lessons.md` for current checkpoints and known failure modes. Non-trivial work must be tracked in `tasks/todo.md`.
- Never run migration commands or database-clearing operations without explicit authorization. Test setup may implicitly run migrations; confirm authorization before running DB-backed suites.

## Commands

```bash
npm install
npm run start:dev                         # hot reload, http://localhost:3000
npm run build                             # emits dist/src/main.js
node dist/src/main.js                     # production entry point (start:prod is stale)
npm run typecheck
npm run lint:check                        # no-fix gate
npm run lint                              # ESLint --fix
npm run format:check
npm run format                            # format src/test TypeScript
npm run prisma:generate                   # run after schema changes
npm run prisma:validate
npm run prisma:migrate:status
npm run prisma:migrate:deploy             # authorized environments only
npm run prisma:seed
npm run bootstrap:admin
npm test -- --runInBand <file> -t "test name" # targeted unit test
npm test -- --runInBand                   # all unit tests
NODE_ENV=test npm run test:e2e -- --runInBand <file>
NODE_ENV=test npm run test:integration -- --runInBand <file>
```

Integration and e2e tests use PostgreSQL database `smartlearning_test` only. `test/setup/db.ts` refuses other database names and truncates test data between tests. Apply migrations to that database separately and only when authorized. Prefer targeted tests first, then module-level and full regression checks. Run Prettier before the lint gate.

## Runtime and API shape

- `src/main.ts` and `test/setup/app-factory.ts` share `configureApplication()`; it installs `/api` global prefix, URI versioning, validation, Helmet, cookies, CORS, response/error handling, and the Socket.IO adapter. Versioned controllers must explicitly set `version: '1'`; health controllers use `VERSION_NEUTRAL` and remain at `/health/live` and `/health/ready`.
- `/api/v1/**` responses are `{ data, meta: { schemaVersion, requestId }, error }`; health probes and `/api/docs` plus `/api/docs-json` are raw responses. Swagger is pinned to `@nestjs/swagger@11.4.6` with `js-yaml@5.3.0` override.
- Domain/application code throws `DomainError` subclasses with stable `ErrorCode`s. `GlobalExceptionFilter` owns HTTP status and error-envelope mapping; do not shape HTTP errors in services.
- Environment files are selected by `NODE_ENV`: `.env.development`, `.env.test`, or `.env.production`, each falling back to `.env`. Required settings are `PORT`, `NODE_ENV`, `DATABASE_URL`, `CORS_ORIGIN`, and `COOKIE_SECRET`; `REDIS_URL` is optional.

## Architecture

Feature modules use the bounded-context flow `api/` (controllers and DTOs) → `application/` (orchestration and persistence) → `domain/` (transport-independent rules and unit specs). Important areas are:

- `src/common/`: stable errors/envelopes, request IDs, security/auth guards, crypto, pagination, clocks, and Pino redaction.
- `src/prisma/`: Prisma client and `TransactionService`, which centralizes transactions, row locks, advisory locks, and Prisma-error mapping.
- `src/modules/identity/`: accounts, roles, opaque web sessions, CSRF, step-up, password lifecycle, admin lifecycle, and CLI credentials.
- `src/modules/courses/` and `src/modules/enrollments/`: course ownership/lifecycle and student enrollment roster.
- `src/modules/questions/`: authoring/read/mutation, poll-multiple/open-text/quiz contracts, and batch validate/confirm.
- `src/modules/live-sessions/`, `participants/`, and `submissions/`: session lifecycle, anonymous or account-bound participants, immutable idempotent answers, snapshots, and result projections.
- `src/modules/realtime/`: Socket.IO `/live` gateway and in-process post-commit event bus.

PostgreSQL is authoritative. IDs are application-generated UUID v7; state fields are `TEXT + CHECK`; timestamps are UTC `TIMESTAMPTZ`; migrations should be additive. `TransactionService` advisory locks must use `$executeRaw` because Prisma 7 cannot deserialize PostgreSQL `void` through `$queryRaw`.

## Current implementation boundaries

- P1 question authoring and P2 teacher-session capabilities are implemented: question CRUD/reorder and all current authoring types; batch validate/confirm plus CLI credentials; session close/cancel; teacher detail; result aggregation; and realtime counts/lifecycle notifications.
- Phase A submission flow supports poll single/multiple, quiz, and open text with activation gates, immutable/idempotent writes, result reveal privacy, and participant-safe realtime projections.
- Phase B student accounts/enrollment is implemented through B1–B4: `student` role, enrollment roster, account-bound participants, and student-safe realtime access. B5 privacy/documentation closeout and full regression evidence may still be tracked in `tasks/todo.md`.
- Still deferred or partial: durable realtime outbox/replay and Redis adapter; archive/retention/tombstones; auto-close scheduler and complete submit/close race matrix; CLI key rotation/expiry and CLI course commands; account list/detail/update; and other follow-ups listed in `SKILL.md`.

## Invariants to preserve

- Web auth uses DB-backed opaque cookies; only SHA-256 hashes are persisted. Login issues `__Host-session` and non-HttpOnly `__Host-csrf`; authenticated browser mutations require constant-time CSRF double-submit plus an exact allowed `Origin`. Missing auth is 401; authenticated-but-forbidden is 403.
- Raw passwords, cookies, CSRF/participant/CLI/validation tokens, idempotency keys, answer payloads, and hashes must not enter logs or response projections. Add new sensitive paths to `src/common/observability/pino-redaction.ts`.
- `canCreateCourse=false` does not revoke an independent CLI credential; disabling an account does revoke its CLI credentials and unused validation tokens.
- Submission rows are immutable. Idempotency fingerprints use sorted reference sets plus normalized text; open-text persistence uses `Prisma.DbNull`, not `JsonNull`.
- Question edits are blocked when a waiting/active session has selected the question (`QUESTION_LOCKED_BY_SESSION`). Reordering/deletion uses two-phase temporary positions to avoid transient unique-key violations; static routes such as `order` must precede `:id` routes.
- Realtime publication is post-commit, fire-and-forget, and listener-isolated. A publish failure must not fail a committed mutation. Socket handshake cookies require manual parsing because Socket.IO bypasses Express `cookie-parser`.
- Teacher projections never enter the session room. Participant projections must not reveal teacher-only counts or quiz correctness before `revealCorrectness`; open-text results remain anonymous.

## Verification bundle

For a delivery, run the smallest relevant checks first, then expand as needed:

```bash
npm run prisma:validate
npm run typecheck
npm run lint:check
npm run format:check
npm run build
npm test -- --runInBand
NODE_ENV=test npm run test:e2e -- --runInBand
NODE_ENV=test npm run test:integration -- --runInBand
npm run prisma:migrate:status
git diff --check
```

Record skipped or blocked DB-backed checks and their reason in `tasks/todo.md`; do not silently treat unavailable PostgreSQL as successful verification.
