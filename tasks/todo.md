# 2026-11-14 Checkpoint B test account and integration path

## Goal / acceptance criteria
- [ ] Provide a safe test-only `TEACHER` account fixture for Checkpoint B auth acceptance; never grant `SYSTEM_ADMIN`.
- [ ] Add a real PostgreSQL-backed HTTP integration suite for CSRF, Login, login-session validation, Logout, and post-logout rejection.
- [ ] Bind DB writes to an explicit fresh isolated test run; refuse dev/prod/shared/remote or stale targets.
- [ ] Update first-account and Checkpoint B HTML guides with runnable commands and truthful status.
- [ ] Keep secrets out of command-line arguments, output, logs, and committed files; exact fixture cleanup only.

## Risk & rollback
- Risk: medium-high; test harness writes auth fixtures to PostgreSQL and runs real auth routes.
- Affected: `test/`, test DB tooling, M01 operator guides.
- Rollback: revert only these test harness/documentation changes. Any DB cleanup must be scoped to the exact run and separately authorized; no volume deletion is included.
- Runtime test execution (Docker startup, migrations, DB writes) is not authorized by this task and requires separate explicit approval plus read-only preflight.

## Working notes
- User chose `TEACHER` as the minimum role; no permission mapping is needed for Checkpoint B login/session verification.
- Existing tree has uncommitted and untracked work. Preserve it; do not reset, clean, stash, or rewrite unrelated files.
- Existing `test:integration` target and bootstrap script paths are not backed by present sources; implement actual maintained test paths rather than trusting script names.
- Test DB create tool produces a clean migrated DB. Once fixtures/tests write rows, do not label it a clean baseline.
- Auth integration regression: the successful-login case leaves a REVOKED session; the invalid-login case must compare session counts before/after its requests rather than assert zero total rows.

## Steps
- [ ] Verify current account/role constraints and app startup/config path; define fail-closed run identity gate.
- [ ] Add test DB run preflight/identity assertion and focused safe-target tests.
- [ ] Add integration Jest config, exact test-only fixture lifecycle, and real HTTP/DB auth acceptance cases.
- [ ] Update both HTML guides with actual command sequence, account behavior, safety gates, and status distinctions.
- [ ] Run non-DB checks and focused unit tests through a dedicated test subagent; do not start Docker or run DB tests without separate approval.
- [ ] Record actual verification and remaining blocked/not-run items.

# 2026-11-15 Manual UI test account provisioning

## Goal / acceptance criteria
- [ ] Provide a local test-only CLI that creates a manually usable ACTIVE, email-verified TEACHER account from operator-entered credentials; no SYSTEM_ADMIN.
- [ ] Verify exact isolated `smartlearning_test` run and pristine baseline before creation; refuse other targets and duplicate identities.
- [ ] Store only Argon2 password hash; accept password via hidden interactive prompt and never echo/log/persist plaintext.
- [ ] Provide exact account disable/session-revoke operation and document how to use credentials at `/login`.
- [ ] Keep manual UI DB separate from clean-baseline integration DB; preserve existing transient integration fixture and all dirty worktree changes.
- [ ] Run offline targeted tests/typecheck/lint only. No DB/container/migration/account operations without separate authorization.

## Risk & rollback
- Risk: medium-high; account creation mutates auth tables.
- Affected: `tools/test-db/`, `package.json`, operator docs.
- Rollback: revert code/docs only. Any account cleanup must verify exact run and account first; never broad-clean or remove volumes without separate approval.
- Runtime account provisioning remains explicitly not authorized by this implementation request.

## Working notes
- Screenshot login page is credential entry only; forgot-password remains unsupported.
- Integration suite's random fixture is transient and credentials are not disclosed; not suitable for human browser login.
- Migration creates no TEACHER role seed, so the dedicated local utility must safely ensure only the fixed TEACHER role exists in its dedicated test DB.

## Steps
- [x] Add reusable non-clean run identity assertion without weakening existing pristine-baseline guard.
- [x] Implement interactive test-account create/revoke CLI and pure validation helpers.
- [x] Add offline unit coverage for input/password handling, hash-only writes, role, duplicate refusal, and exact revoke scope.
- [x] Document commands and manual `/login` integration verification, plus DB separation and cleanup constraints.
- [x] Delegate targeted tests/typecheck/lint to a test subagent; do not access DB/Docker or execute provisioning.
- [x] Record verification evidence and runtime steps that still require explicit approval.

## Results
- Added `db:test:ui-account:create` and `db:test:ui-account:revoke` for a manually usable local TEACHER account; passwords are hidden on input and only Argon2 hashes are stored.
- Added target validation support while preserving the clean-baseline requirement of `db:test:assert-integration`.
- Documented setup, manual `/login` verification and exact revocation in `tools/test-db/README.md` and the M01 guide.
- Verified offline: `npm run test:db-tools` (8/8 PASS), `npm run typecheck` (PASS), `npm run format:check` (PASS), and Node syntax checks for both CJS tools (PASS). `git diff --check` passed.
- No Docker, database, migration, account provisioning, backend runtime, or browser login was run. Those steps require separate authorization and local test DB preflight.

# 2026-11-16 M01 Forgot Password Reset

## Goal / acceptance criteria
- [x] Add forgot-password request and reset endpoints with M01 non-enumeration, 30-minute single-use token and all-session revocation behavior.
- [x] Deliver reset links through Gmail SMTP using environment-injected credentials; never expose/log raw tokens or secrets.
- [x] Enforce 60-second account cooldown and prior-link superseding atomically under concurrent requests.
- [x] Document actual API/config contract and test the negative, replay, expiry, failure, and concurrency cases.

## Risk & rollback
- Risk: high; authentication, password/session state mutation, and a new additive outbox table.
- Affected: auth module/API, mail delivery configuration, PostgreSQL one-time-link and email-outbox rows.
- Rollback: stop the outbox worker, ensure no pending jobs, then revert this feature's source/config/docs and migration changes. No migration was applied in this task.
- No real Gmail credentials or delivery will be used in tests. No database/container operation without a separately authorized disposable test environment.

## Working notes
- Existing worktree has unrelated/uncommitted Auth changes; preserve them and make narrowly scoped edits.
- Existing schema has `one_time_link` and `PASSWORD_RESET`; implement actual lifecycle behavior rather than treating fields as sufficient.
- Gmail SMTP credentials/App Password must be supplied by operator through secret injection; do not place secrets in `.env.example`, chat, tests, or logs.
- User explicitly authorized adding Nodemailer and its TypeScript typings from npm; no Gmail credential values were provided or stored.

## Steps
- [x] Implement injectable Gmail SMTP mail provider/config with fail-closed behavior.
- [x] Implement atomic token issuance, cooldown/superseding, and delivery failure handling.
- [x] Implement atomic one-time token consumption, password update, and session revocation.
- [x] Add controller DTOs, Swagger contract, OpenAPI docs and safe environment examples.
- [x] Add targeted Auth unit/controller/repository tests; 14 suites and 68 tests passed.
- [x] Run Prisma schema validation, typecheck, targeted Prettier check, lint, and build; all passed.
- [x] Confirm final OpenAPI export to `dist/openapi.json`.
- [x] Record actual verification; PostgreSQL tests, migration execution, and live Gmail delivery remain unrun pending configured disposable DB/environment.

## Results
- Added reset-request and reset-token endpoints, encrypted durable Gmail SMTP outbox, account-level send cooldown, single-use expiry, and transactional password/session update.
- Updated M01 D05 and acceptance scenarios to record the approved no-enumeration response policy, internal SMTP retry, and 503 behavior when request persistence is unavailable; corrected the bootstrap guide's stale reset status.
- Verified offline: `npm run prisma:dev:validate`; `npm test -- --runInBand auth` (14 suites, 68 tests); `npm run typecheck`; targeted Prettier check; `npm run lint:check`; `npm run build`; and `npm run openapi:export` all passed.
- No database integration, migration execution, Docker, or live Gmail delivery was run. The schema migration is additive and has not been applied.

# 2026-11-19 M01 Reset Token URL Fragment Hardening

## Acceptance criteria
- [ ] Reset email tokens are placed in URL fragments, never query strings, so the initial HTTP request excludes the bearer token.
- [ ] Configured reset URL is validated as a clean HTTP(S) page URL with no credentials, query, or fragment.
- [ ] Unit tests assert fragment placement and fail-closed handling of unsafe base URLs.
- [ ] Configuration documentation states the token fragment contract.
- [ ] No database, migration, container, SMTP credential, live email, or deployment operation is performed.

## Risk & rollback
- Risk: medium-high; bearer-token link contract.
- Affected: M01 email reset URL producer and frontend parser.
- Rollback: revert only URL producer/UI parser/docs together. Do not re-enable query tokens as a fallback; users with pre-change query links should request a new link.
- No schema or OpenAPI payload changes.

## Working notes
- Existing reset links use `?token=...`, which can enter request logs and URL/referrer paths before client-side cleanup.
- Backend was clean at start; UI already contains this session's M01 frontend work plus existing checklist edits. Preserve them.
- UI must read `#token=...`, scrub the current browser history entry, and keep the existing reset API payload unchanged.

## Steps
- [x] Change backend reset link URL construction to fragment form and validate base URL.
- [x] Update backend mail/password-reset unit tests and env/config notes.
- [x] Change frontend parsing to fragment only; scrub query/fragment and reject legacy query links.
- [x] Update frontend tests and M01 documentation without marking backend integration acceptance passed.
- [x] Run focused backend/UI tests, typecheck, lint, UI build, and `git diff --check` in both repos.

## Results
- Backend reset URL builder now rejects non-HTTP(S), credentials, query, and fragment in base configuration, and appends `token` as a URL fragment. UI captures only the fragment on mount, scrubs query/hash from current history, and rejects legacy query-token URLs. Tests include React StrictMode double-effect coverage.
- Backend unit tests: `npm test -- --runInBand auth/reset-mail.service.spec.ts auth/password-reset.service.spec.ts auth/email-outbox.processor.spec.ts` PASS (3 suites, 16 tests); backend typecheck PASS; lint and Prettier checks PASS; backend `git diff --check` PASS.
- UI focused auth tests PASS (2 files, 15 tests); typecheck, lint, build, and `git diff --check` PASS.
- No DB, migration, Docker, SMTP, live email, or deployment was run. Previously issued query-token links require a fresh reset request. M01 backend email/security integration remains unverified.

# 2026-11-19 Fail Fast on Database Startup

## Acceptance criteria
- [x] Backend startup awaits Prisma adapter initialization and rejects when initialization itself fails.
- [x] Failure output must be actionable and must not disclose connection strings or credentials.
- [x] Add deterministic unit coverage for successful adapter initialization, rejected initialization, missing `DATABASE_URL`, and safe disconnect lifecycle.
- [x] Do not run migrations or mutate Docker/database resources; keep static OpenAPI export independent of a live database.

## Risk & rollback
- Risk: medium; DB connectivity becomes a required dependency for starting the API.
- Affected: `src/database/prisma.service.ts` and its unit tests.
- Rollback: revert the lifecycle hook and focused tests; no DB state changes are involved.

## Steps
- [x] Add lifecycle connection check to PrismaService and focused unit tests.
- [x] Run targeted test, typecheck, lint/format check, and build; inspect Nest lifecycle to confirm OpenAPI export does not invoke app initialization hooks.
- [x] Record results and confirm no Docker/database operations were performed.

## Results
- `PrismaService.onModuleInit()` awaited `$connect()` and sanitized initialization failures, but later investigation found that Prisma 7.10.1 with `@prisma/adapter-pg` can initialize the lazy pool without proving a query-level PostgreSQL connection. That check alone did not establish database reachability; the follow-up correction is recorded in the 2026-11-20 section below.
- Added five mock-based lifecycle tests for adapter initialization, rejected initialization/error sanitization/cleanup, missing URL, normal disconnect, and unused client. Static OpenAPI export remains DB-independent because its script creates the Nest app but never calls `app.init()` or `listen()`; checked against the installed Nest lifecycle implementation.
- Verification PASS: `npm test -- --runInBand database/prisma.service.spec.ts` (1 suite, 5 tests); `npm run typecheck`; `npm run lint:check`; `npx prettier --check src/database/prisma.service.ts src/database/prisma.service.spec.ts`; `npm run build`; `env -u DATABASE_URL npm run openapi:export`; `git diff --check`.
- No Docker, database, integration test, migration, or other external-resource operation was run.

# 2026-11-20 DB Startup Probe Hangs on Unresponsive Endpoint

## Acceptance criteria
- [x] Startup probe against an unresponsive PostgreSQL endpoint fails within a bounded time, not hang forever.
- [x] Runtime reproduction drives the acceptance (no real/dev DB or Docker used).
- [ ] Fail-fast error remains credential-safe and prevents listening.

## Root cause
- pg.Pool defaults to waiting forever when an endpoint accepts TCP but never completes the handshake (a stopped container can behave this way). `$connect()` + `SELECT 1` may hang indefinitely; Nest never reaches `app.listen()` and never reports failure, so the process appears "started" but serves nothing.

## Steps
- [x] Runtime repro (loopback port with no listener, 5436): initially exited only via 60s timeout (exit 124), no error logged — confirmed hang.
- [x] Add bounded `connectionTimeoutMillis` (5000) via `createPgAdapterFactory` in prisma.service.ts.
- [x] Add unit test for bounded timeout configuration.
- [x] Rebuild and rerun repro (exit 1 in seconds; error logged; no success log).
- [ ] Record final verification and note remaining unverified items.

## Results
- Focused tests: `.spec.ts` 6/6 PASS; typecheck, lint, prettier, `npm run build`, `git diff --check` PASS.
- Runtime repro before fix: exit 124 no error; after fix: exit 1 with sanitized error; `successfully started` line absent.
- No Docker, no real DB, no other processes used during repro; port 5436/3457 were confirmed free and are ephemeral.
- Fail-fast error credential-safe and listening prevented: confirmed in same repro (sanitized message in log; no success log; no listener needed — process exited during init).

# 2026-11-20 Require a Real Database Probe at Startup (Superseded Root Cause Note)

## Acceptance criteria
- [x] Startup waits for a real PostgreSQL query, not only Prisma adapter initialization.
- [x] Probe failure prevents successful startup and reports a credential-safe error.
- [x] Unit tests cover successful probe, failed probe, and disconnect cleanup.
- [x] Preserve unrelated worktree changes; no Docker/app/DB/migration operations.

## Steps
- [x] Add `SELECT 1` probe after `$connect()` in Prisma startup hook.
- [x] Extend Prisma lifecycle mocks and regression coverage.
- [x] Run focused unit tests, typecheck, lint/format checks, and build via test subagent.
- [x] Record verification and explicitly note runtime startup not exercised (initially); runtime hang root cause now covered by the 2026-11-20 "DB Startup Probe Hangs on Unresponsive Endpoint" section above.

## Results
- `PrismaService.onModuleInit()` now awaits `$connect()` and a constant `SELECT 1` query before Nest completes initialization. Query/connect failures use the existing sanitized diagnostic and best-effort disconnect.
- Expanded unit coverage verifies the query probe runs, a rejected probe fails startup, and a disconnect failure cannot replace the sanitized startup error.
- Final verification PASS: `npm test -- --runInBand src/database/prisma.service.spec.ts` (now 6 tests); `npm run typecheck`; `npm run lint:check`; `npx prettier --check src/database/prisma.service.ts src/database/prisma.service.spec.ts`; `npm run build`.
- Runtime reproduction was later performed with the bounded `connectionTimeoutMillis` fix (see 2026-11-20 hang section); before that fix the probe could hang indefinitely, which is now resolved.
