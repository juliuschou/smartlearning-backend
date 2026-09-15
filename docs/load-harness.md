# W1–W8 load harness

The standalone harness in `scripts/load-harness/` drives the real REST and Socket.IO paths. It is deliberately opt-in. Existing-fixture mode does not create or clean up fixtures; guarded create mode can create one disposable W1 fixture and leaves it for inspection.

## Safety contract

- Default fixture mode is `existing`.
- No fixture writes or cleanup are implemented by default.
- Tokens are accepted only through environment variables and are never printed or written to reports.
- W8 is reported `blocked` unless an external controlled-clock adapter is added.
- A report is performance evidence only for the exact target and fixture it records; browser tests are not capacity evidence.

## Commands

List scenarios without contacting the backend:

```bash
npm run load:test:list
```

Run a small W1 join smoke against an already-active disposable session:

```bash
LOAD_BASE_URL=http://127.0.0.1:3000 \
LOAD_SESSION_CODE='<session-code>' \
npm run load:test -- --scenarios W1 --participants 5 --output artifacts/w1-smoke.json
```

Create one disposable W1 fixture and run the smoke (credentials stay in the environment):

```bash
LOAD_BASE_URL=http://127.0.0.1:3000 \
LOAD_FIXTURE_MODE=create \
LOAD_ALLOW_FIXTURE_WRITES=1 \
LOAD_DISPOSABLE_TARGET=1 \
LOAD_TEACHER_USERNAME='<teacher-username>' \
LOAD_TEACHER_PASSWORD='<teacher-password>' \
npm run load:test -- --scenarios W1 --participants 5 --output artifacts/w1-create-smoke.json
```

Create mode requires both explicit write flags, loopback base URL, teacher credentials, and W1 only. It creates one course, poll question, active session, and open question; cleanup is disabled and the report contains only safe fixture identifiers.

## One-process W1 orchestration

`load:w1` owns one runtime-only credential lifecycle: it checks the test target and backend health, provisions a fresh uniquely marked teacher, immediately performs a create-mode credential/authorization smoke, then runs the documented W1 stages sequentially (20, 50, 100, 300). A failed preflight or stage stops the process before the next participant load. The protected historical teacher is never selected by this command.

```bash
NODE_ENV=test \
LOCAL_W1_PROVISIONING_ENABLED=1 \
LOCAL_PROVISION_TARGET=disposable \
LOAD_DISPOSABLE_TARGET=1 \
LOAD_BASE_URL=http://127.0.0.1:3001 \
LOAD_CORS_ORIGIN=http://localhost:3000 \
LOCAL_W1_PROVISION_CREATED_BY='<admin-account-id>' \
npm run load:w1
```

The password is generated in memory, passed only as `LOCAL_W1_TEACHER_PASSWORD` / `LOAD_TEACHER_PASSWORD` to child processes, and is never printed, persisted, or included in artifacts. Stage reports contain safe identifiers only. The new teacher is retained as a cleanup candidate after a failed run; optional cleanup after a fully passing run requires `W1_AUTO_CLEANUP=1` and still affects only the newly generated marked teacher.

## Dedicated local W1 teacher provisioning

The account provisioning command is separate from the load harness and does not run W1. It is guarded to the isolated `smartlearning_test` database and refuses production/development targets, missing opt-in, non-marker usernames, and existing usernames.

```bash
NODE_ENV=test \
LOCAL_W1_PROVISIONING_ENABLED=1 \
LOCAL_PROVISION_TARGET=disposable \
DATABASE_URL='postgresql://.../smartlearning_test?schema=public' \
LOCAL_W1_PROVISION_CREATED_BY='<admin-account-id>' \
LOCAL_W1_TEACHER_USERNAME='local-w1-<run-id>' \
LOCAL_W1_TEACHER_PASSWORD='<runtime-only-password>' \
npm run bootstrap:w1-teacher -- provision
```

Cleanup is explicit and disables only the marked teacher after provenance checks:

```bash
NODE_ENV=test \
LOCAL_W1_PROVISIONING_ENABLED=1 \
LOCAL_PROVISION_TARGET=disposable \
DATABASE_URL='postgresql://.../smartlearning_test?schema=public' \
LOCAL_W1_PROVISION_CREATED_BY='<admin-account-id>' \
LOCAL_W1_TEACHER_USERNAME='local-w1-<run-id>' \
npm run bootstrap:w1-teacher -- cleanup
```

Passwords are supplied only through the process environment and are never printed or written to tracked files. The current production-mode Compose stack intentionally fails this command's `NODE_ENV=test` guard; use an explicitly isolated test target. Provisioning verification does not start W1.

Run W2 with one token per participant:

```bash
LOAD_BASE_URL=http://127.0.0.1:3000 \
LOAD_SESSION_CODE='<session-code>' \
LOAD_LIVE_SESSION_ID='<live-session-uuid>' \
LOAD_SESSION_QUESTION_ID='<session-question-uuid>' \
LOAD_PARTICIPANT_TOKENS_JSON='["<token-1>","<token-2>"]' \
npm run load:test -- --scenarios W2 --participants 2
```

The placeholders above must not be replaced with credentials in committed files or chat output. Use a controlled local environment file or process environment.

## Environment

| Variable                       | Required | Meaning                                             |
| ------------------------------ | -------: | --------------------------------------------------- |
| `LOAD_BASE_URL`                |      yes | Backend origin, for example `http://127.0.0.1:3000` |
| `LOAD_SCENARIOS`               |       no | Comma-separated `W1`–`W8`; defaults to all          |
| `LOAD_PARTICIPANTS`            |       no | Positive integer; defaults to 300                   |
| `LOAD_SESSION_CODE`            |    W1–W7 | Existing active session code                        |
| `LOAD_LIVE_SESSION_ID`         |    W2–W4 | Existing session UUID                               |
| `LOAD_SESSION_QUESTION_ID`     |       W2 | Existing open session-question UUID                 |
| `LOAD_PARTICIPANT_TOKENS_JSON` |    W2–W4 | JSON array of raw anonymous participant tokens      |
| `LOAD_TIMEOUT_MS`              |       no | Per-operation timeout; default 10000                |
| `LOAD_OUTPUT`                  |       no | Optional JSON report path                           |

## Current scenario support

- **W1** joins the configured session and checks successful/duplicate participant IDs.
- **W2** submits a single-choice `source` answer using one supplied token per participant and checks duplicate submission IDs.
- **W3** connects anonymous Socket.IO clients to `/live` and validates connection timing and event-sequence monotonicity.
- **W4** is reserved for reconnect orchestration after the socket cohort has a verified fixture.
- **W5** is intentionally blocked in the first safe slice; do not accidentally run a 30-minute soak.
- **W6** requires teacher lifecycle credentials and a race controller; it is blocked unless that explicit fixture is added.
- **W7** requires a verified answer fixture; it is blocked unless the retry scenario is configured.
- **W8** is blocked because the external server has no clock-control endpoint.

The harness reports `passed`, `failed`, or `blocked`; a blocked scenario is not a pass.

## Verification and scale-up

First run:

```bash
npm run load:test:list
npm run typecheck
npm run lint:check
npm run format:check
npm run build
```

Only after a reviewed 2–5-client smoke should W1–W7 be expanded. A 300-client or 30-minute run requires an explicitly selected disposable/staging target, telemetry capture, authority reconciliation, and separate approval. W1–W8 thresholds are defined in `docs/智學互動平台/00_專案規劃/MVP 效能目標.md`.
