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

# CP/phase verification suites (each has its own jest config in test/jest-*.json)
npm run test:cp5:e2e
npm run test:cp6:manual
npm run test:cp7:manual
npm run test:cp8                           # full CP8 runner (scripts/run-cp8.cjs)
npm run test:cp8:static
npm run test:retention:artifacts
npm run test:login-rate-limit:redis        # Redis-backed rate-limit store

# Ops / tooling
npm run gate3:up|status|doctor|down        # tools/gate3/gate3.sh environment
npm run env:doctor
npm run retention                          # node dist/src/bootstrap/retention.js

# Load harness (W1–W8; see docs/load-harness.md — has a strict safety contract)
npm run load:test:list
npm run load:test -- --scenarios W1 --participants 5
npm run load:w1
npm run load:w3:unit
npm run load:w3:diag                       # W3 diagnostics run (REALTIME_TRACE_*)
```

Integration and e2e tests use PostgreSQL database `smartlearning_test` only. `test/setup/db.ts` refuses other database names and truncates test data between tests. Apply migrations to that database separately and only when authorized. Prefer targeted tests first, then module-level and full regression checks. Run Prettier before the lint gate.

**Load harness safety contract** (`docs/load-harness.md`): default fixture mode is `existing` — no fixture creation or cleanup unless `LOAD_FIXTURE_MODE=create LOAD_ALLOW_FIXTURE_WRITES=1 LOAD_DISPOSABLE_TARGET=1`; credentials/tokens only via environment variables, never printed or written to reports; a report is evidence only for the exact target and fixture it records. Load drivers enforce run-once guards: fresh fixture/runId per run, artifact-overwrite refusal, exact-ID cleanup only, and a protected-ID existence check before any truncating suite.

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
- `src/modules/realtime/`: Socket.IO `/live` gateway, durable outbox/publisher, in-process post-commit event bus, Redis adapter service, and realtime diagnostics.
- `src/modules/governance/`: S-5 archive/retention — retention reconciliation/scheduler, deletion manifests + S3 provider, tombstones.
- `src/modules/metrics/`: prom-client registry, metrics middleware/controller.

PostgreSQL is authoritative. IDs are application-generated UUID v7; state fields are `TEXT + CHECK`; timestamps are UTC `TIMESTAMPTZ`; migrations should be additive. `TransactionService` advisory locks must use `$executeRaw` because Prisma 7 cannot deserialize PostgreSQL `void` through `$queryRaw`.

## Current implementation boundaries

- P1 question authoring and P2 teacher-session capabilities are implemented: question CRUD/reorder and all current authoring types; batch validate/confirm plus CLI credentials; session close/cancel; teacher detail; result aggregation; and realtime counts/lifecycle notifications.
- Phase A submission flow supports poll single/multiple, quiz, and open text with activation gates, immutable/idempotent writes, result reveal privacy, and participant-safe realtime projections.
- Phase B student accounts/enrollment is implemented through B1–B4: `student` role, enrollment roster, account-bound participants, and student-safe realtime access. B5 privacy/documentation closeout and full regression evidence may still be tracked in `tasks/todo.md`.
- Still deferred or partial: CLI key rotation/expiry and CLI course commands; account list/detail/update; and other follow-ups listed in `SKILL.md`.

## Compose stacks and ops

`docker-compose.yml` is the dev stack (`db`, one-shot `migrate`, `backend` on 3000). Additional **verification-only** stacks exist — `docker-compose.cp5.yml`, `docker-compose.cp8.yml` (CP8: PG16 + Redis + loopback-only HTTPS Nginx; explicitly not the OPS-1 production topology), and `docker-compose.fe51.yml` — for checkpoint/compat verification. `ops/observability/` holds Prometheus alerts and retention/observability runbooks; `tools/gate3/` is the gate3 environment.

## Invariants to preserve

- Web auth uses DB-backed opaque cookies; only SHA-256 hashes are persisted. Login issues `__Host-session` and non-HttpOnly `__Host-csrf`; authenticated browser mutations require constant-time CSRF double-submit plus an exact allowed `Origin`. Missing auth is 401; authenticated-but-forbidden is 403.
- Raw passwords, cookies, CSRF/participant/CLI/validation tokens, idempotency keys, answer payloads, and hashes must not enter logs or response projections. Add new sensitive paths to `src/common/observability/pino-redaction.ts`.
- `canCreateCourse=false` does not revoke an independent CLI credential; disabling an account does revoke its CLI credentials and unused validation tokens.
- Submission rows are immutable. Idempotency fingerprints use sorted reference sets plus normalized text; open-text persistence uses `Prisma.DbNull`, not `JsonNull`.
- Question edits are blocked when a waiting/active session has selected the question (`QUESTION_LOCKED_BY_SESSION`). Reordering/deletion uses two-phase temporary positions to avoid transient unique-key violations; static routes such as `order` must precede `:id` routes.
- Realtime publication is post-commit, fire-and-forget, and listener-isolated. A publish failure must not fail a committed mutation. Socket handshake cookies require manual parsing because Socket.IO bypasses Express `cookie-parser`. Realtime writes are now **durable**: `LiveSessionEvent` rows are appended inside the caller's transaction and claimed by `LiveSessionOutboxService`/`LiveSessionPublisher` (drains ≈1 event/sec, sequentially); the in-process bus only wakes a bounded outbox scan. `delivery_state='delivered'` means *server dispatch completed*, never *client received* — client receipts must be correlated by `event_seq`.
- Teacher projections never enter the session room. Participant projections must not reveal teacher-only counts or quiz correctness before `revealCorrectness`; open-text results remain anonymous.
- Realtime diagnostics trace: set `REALTIME_TRACE_RUN_ID` explicitly before backend start (it otherwise defaults to the instanceId and driver correlation returns 0 records); size `REALTIME_TRACE_BUFFER_SIZE` before spawn (W3-300 requires ≥20000), not after.

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



# Project Instructions

在執行任何操作前，請先讀取目前專案的 `.claude/rules/`，列出本次任務適用的規則，並以這些規則作為後續執行邊界。

任何涉及 **Container、Docker / Rancher Desktop、Database、Redis、測試基礎設施、fixture、integration / E2E / load test** 的建立、修改、啟動、停止、清理或其他可能改變狀態的操作，都必須先完成 preflight。

Preflight 至少確認：

- 目前 repository / branch / revision
- 執行環境與 `NODE_ENV`
- Docker / Rancher Desktop runtime 與 Docker context
- Database / schema 身分
- Redis / dependency 身分（若適用）
- Container / process / port ownership
- 目標資源是否屬於本次 test/run
- 必須保護、不得修改的既有資源
- cleanup ownership 與授權範圍

若任何資源的 **身分、用途、環境分類、ownership 或授權範圍不明確**：

`STOP — RESOURCE IDENTITY UNCERTAIN`

不得猜測、不得以名稱（例如 `test`、`qa`、`dev`）推定安全性，也不得先修改後再確認。
