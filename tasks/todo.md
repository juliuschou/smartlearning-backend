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
