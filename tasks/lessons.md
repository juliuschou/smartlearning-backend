# Lessons learned

## 2026-09-01 — Prisma migration images must expose the bundled OpenSSL ABI

- **Failure mode:** The isolated CP8 `migrate` container omitted OpenSSL, so Prisma defaulted to `debian-openssl-1.1.x` and attempted a network download that failed inside the internal Compose network (`getaddrinfo EAI_AGAIN binaries.prisma.sh`), even though the image contained the OpenSSL 3 schema engine.
- **Detection signal:** Migration logs warned that Prisma could not detect libssl/OpenSSL and then failed fetching the 1.1 engine; inspecting `/app/node_modules/@prisma/engines` showed `schema-engine-debian-openssl-3.0.x` was already present.
- **Prevention rule:** Install the runtime OpenSSL package in every Docker stage that invokes Prisma CLI; keep the CP8 network internal and do not make migration depend on runtime downloads.
- **Tripwire:** In the migration image, assert `openssl version` and the bundled `schema-engine-debian-openssl-3.0.x` path before running `prisma migrate deploy`, then require migration exit 0.

## 2026-09-01 — Required Redis recovery needs an explicit liveness probe

- **Failure mode:** Stopping and restarting the required realtime Redis service left the existing API clients reporting `redis_unavailable`; readiness stayed 503 for 30 seconds until the API instances were restarted.
- **Detection signal:** Runtime probe observed liveness 200/readiness 503 during outage, but no readiness recovery within the bounded 30-second post-restart window; API restart restored readiness 200.
- **Prevention rule:** Treat required Redis recovery as an explicit runtime acceptance case; add a bounded connection-health/reconnect probe or restart policy that proves the existing API process re-enters the available state after Redis returns.
- **Tripwire:** CP8 outage drill must stop/restart `redis-realtime`, require readiness 503 during outage and readiness 200 without API restart within the agreed recovery budget, or record `DEFERRED/BLOCKED`.

## 2026-08-31 — CP5 bootstrap must use the compiled runtime entrypoint

- **Failure mode:** The CP5 runtime image prunes dev dependencies, so invoking `npm run bootstrap:admin` inside `backend-a` failed with `sh: 1: tsx: not found`; a host-side `tsx` invocation also failed during Nest DI startup with `UndefinedDependencyException` for `RateLimiterService`.
- **Detection signal:** The verifier's three rate-limit tests passed, but the successful-login assertion returned `401` because no admin had been created.
- **Prevention rule:** For the built CP5 runtime, bootstrap with `node dist/src/bootstrap/bootstrap-admin.js` inside a running backend container; keep bootstrap output free of passwords and tokens.
- **Tripwire:** Require a successful `Bootstrapped first admin` line before starting `npm run test:cp5:e2e -- --runInBand`, and treat any bootstrap non-zero exit as a hard stop.

## 2026-08-31 — CP5 manual verifier timeout must cover real-clock expiry waits

- **Failure mode:** The CP5 two-backend verifier used 5.5-second real-clock expiry waits while Jest's default per-test timeout remained 5 seconds, so every manual test timed out before completing.
- **Detection signal:** `npm run test:cp5:e2e -- --runInBand` failed all four tests with `Exceeded timeout of 5000 ms` at `test/manual-cp5-verify.e2e-spec.ts`.
- **Prevention rule:** Manual verification specs that intentionally wait beyond Jest's default timeout must set an explicit suite timeout with margin for network and outage-recovery polling.
- **Tripwire:** Keep an explicit Jest timeout in the CP5 verifier and rerun the complete four-test manual suite after changes.

## 2026-08-31 — CP5 outage proof needs an unexpired fixed window

- **Failure mode:** The outage/recovery case used a 5-second Redis window, but the pre-check, three Argon2 login attempts, Redis restart, and readiness polling could exceed that window; the recovered login then correctly returned 401 because the bucket had expired.
- **Detection signal:** The CP5 verifier passed the outage 503/liveness checks but received `Expected: 429, Received: 401` after Redis recovery.
- **Prevention rule:** Give the dedicated manual topology enough fixed-window margin for the outage sequence and derive the test expiry wait from the same explicit window.
- **Tripwire:** Keep the CP5 Compose account/source windows and manual `rateLimitWindowMs` synchronized, then rerun the complete verifier.

## 2026-08-29 — Quiesce the shared publisher before every destructive truncate, not just the realtime suite

- **Failure mode:** `LiveSessionPublisher` is a shared singleton across the whole Jest process. Wrapping only the realtime suite's `truncateAll()` left every other DB-backed suite truncating while the publisher was active, so the `40P01` deadlock recurred in `route-matrix`, `close-cancel`, `results`, `enrollments`, and `archive-governance` — intermittently, depending on whether the publisher had in-flight work at cleanup time.
- **Detection signal:** The seven-suite matrix and full e2e run failed in `test/setup/db.ts::truncateAll()` with SQLSTATE `40P01`, while isolated reruns could pass; suites that passed in one run failed in another.
- **Prevention rule:** Treat destructive fixture cleanup as a process-wide lifecycle boundary. Quiesce the publisher (`withQuiescedLiveSessionPublisher`) around **every** `truncateAll()` call site in DB-backed suites, not just the realtime suite. A suite that permanently stops the publisher in `beforeAll` (e.g. `cp3-terminal-state`) is already safe and needs no wrapper.
- **Tripwire:** Keep the deterministic deferred/fake-timer lifecycle unit tests, and grep that no DB-backed suite calls `truncateAll()` without a quiesce wrapper (except suites that permanently stop the publisher).

## 2026-08-16 — Prisma advisory locks and PostgreSQL `void`

- **Failure mode:** Prisma 7 `$queryRaw` cannot deserialize the `void` result returned by `pg_advisory_xact_lock`.
- **Detection signal:** Auth/course e2e failed in `BootstrapService` with `Failed to deserialize column of type 'void'`.
- **Prevention rule:** Use `$executeRaw` for PostgreSQL advisory-lock calls that intentionally return no result; reserve `$queryRaw` for row-producing queries.

## 2026-08-16 — URI versioning requires explicit controller metadata

- **Failure mode:** `defaultVersion: 'v1'` tagged routes as versioned but mapped controllers without an explicit version to `/api/...`, not `/api/v1/...`.
- **Detection signal:** Auth/course e2e requests to `/api/v1/*` returned 404 while startup logs showed `/api/*` mappings.
- **Prevention rule:** Set `version: '1'` in each versioned controller's `@Controller` options and keep neutral health routes explicitly marked.

## 2026-08-16 — Plain-HTTP test sessions

- **Failure mode:** Secure cookies were not retained by supertest agents over HTTP, so authenticated follow-up requests were treated as unauthenticated.
- **Detection signal:** Login returned 201, but subsequent guarded routes returned 403 because the session cookie was absent.
- **Prevention rule:** Default `SESSION_COOKIE_SECURE` to false only when `NODE_ENV=test`; production and explicitly configured environments remain secure by default.

## 2026-08-16 — Guard status semantics

- **Failure mode:** Returning `false` from `SessionGuard` made Nest emit 403 Forbidden for a missing session instead of the contract's 401 Unauthorized.
- **Detection signal:** Unauthenticated course requests returned 403 while the e2e contract expected 401.
- **Prevention rule:** Throw `UnauthorizedError` for missing or invalid session credentials; reserve `ForbiddenError` for authenticated callers lacking permission.

## 2026-08-16 — Format before lint on new contract files

- **Failure mode:** The first lint/format verification reported only Prettier errors across newly added common HTTP files.
- **Detection signal:** `npm run lint:check` returned 12 `prettier/prettier` diagnostics while `npm run typecheck` and targeted tests were already green.
- **Prevention rule:** Run `npx prettier --write` on newly added/edited files before the lint gate, then rerun both `npm run format:check` and `npm run lint:check` so formatting-only failures do not obscure behavioral verification.

## 2026-08-16 — Normalize transport boundaries after implementation

- **Failure mode:** A shallow envelope check, locale-sensitive validation ordering, and pass-through framework exception messages could violate the stable contract or expose implementation details at the HTTP boundary.
- **Detection signal:** Adversarial correctness/security review identified stale request metadata, malformed envelope bypasses, incorrect unmapped 4xx codes, array path mismatches, and raw client/server exception text.
- **Prevention rule:** Treat transport normalization as a strict boundary: validate the complete envelope, overwrite request metadata, allow only explicitly trusted validation details, use locale-independent ordering, and keep exception logs structured and redacted.

## 2026-08-16 — Reject wildcard Origins for CSRF-protected mutations

- **Failure mode:** Exact allowlist matching alone could accept a literal `Origin: *` when the configured allowlist was also `*`, despite wildcard-only Origin policy being fail-closed.
- **Detection signal:** Adversarial review checked the wildcard configuration and header edge case beyond the normal browser-origin path.
- **Prevention rule:** Reject wildcard entries before exact Origin matching and keep a regression test for both ordinary and literal wildcard headers.

## 2026-08-16 — Preserve display normalization semantics

- **Failure mode:** Applying NFKC to the full question text changed display punctuation such as the fullwidth Chinese question mark into ASCII, breaking the canonical poll fixture's wire-visible text.
- **Detection signal:** The executable contract fixture failed an exact normalized-output assertion even though duplicate comparison still behaved correctly.
- **Prevention rule:** Use NFC plus whitespace trim/collapse for persisted display text; reserve NFKC/case folding for comparison keys such as duplicate option detection, and keep a punctuation-preservation regression test.

## 2026-08-17 — Batch validate/confirm: two-layer `FIELD_FORBIDDEN`, not a single pipe bug

- **Failure mode:** The original block-point note attributed the batch e2e 400 `FIELD_FORBIDDEN field=clientRef` solely to Nest's global `ValidationPipe` (`forbidNonWhitelisted: true`) mishandling nested `@ValidateNested`/`@Type` arrays. That was only the surface layer. The real root cause was the service layer: after domain `validateBatch` (which strips `clientRef`) returned `valid=true`, the code called `normalizeQuestion(q)` on the **original** payload that still contained `clientRef`, and `validateQuestion` rejects any unknown top-level key with `FIELD_FORBIDDEN`. So even after fixing the pipe, validate still 400'd. Diagnostic tell: the error `field` was bare `clientRef` with no `questions[0].` prefix — domain `validateBatch` always prefixes with `questions[i].`, so a prefix-less `clientRef` error could not have come from the batch validator.
- **Detection signal:** 400 response body `{ code: "FIELD_FORBIDDEN", field: "clientRef" }` (no array prefix) after the controller pipe override was already applied; tracing the code path showed `normalizeQuestion` is fed un-stripped questions.
- **Prevention rule:** When a domain validator/normalizer forbids unknown fields, every caller that feeds it a superset payload must strip the extra fields at the boundary — not just the aggregation path. Centralize the strip in one exported helper (`stripClientRef`) and reuse it in both `validateBatch` and `normalizeQuestion` call sites. Distinguish which layer produced an error by its `field` shape (bare vs prefixed) before assigning root cause. Verify the full happy path end-to-end after each layer fix, not just the isolated layer.

## 2026-08-17 — Socket.IO handshake bypasses express middleware (cookie-parser)

- **Failure mode:** `socket.request.cookies` is `undefined` inside a `@WebSocketGateway.handleConnection`, so teacher handshake auth via the Web session cookie silently failed (fell through to the participant path → `UNAUTHORIZED`).
- **Detection signal:** `hasCookieHeader=true hasCookieJar=false` — the raw `Cookie` header reached the handshake request, but `cookie-parser` never populated `request.cookies`.
- **Root cause:** Socket.IO's engine intercepts its handshake requests (`GET /socket.io/...`) before they reach the express middleware stack, so `cookie-parser` (registered via `app.use(cookieParser(...))`) never runs on them.
- **Prevention rule:** In a Socket.IO gateway, parse the cookie header manually (`cookie.parse(socket.request.headers.cookie)`) rather than relying on `request.cookies`. The `__Host-session` token is opaque/unsigned, so no secret is needed; for signed cookies you'd pass the same secret to `cookie.parse`-equivalent.

## 2026-08-17 — Post-commit socket emit races the REST response

- **Failure mode:** A service publishes a realtime signal synchronously after its transaction commits; the gateway fans out to the room within the same tick — so the socket event can reach the client _before_ the test's `nextEvent(listener)` is registered, and the event is lost (test times out).
- **Detection signal:** Server log shows `roomHas=true roomSize=1 sockCount=1` at emit time (socket IS in the room, emit IS targeted correctly), yet the client never receives the event.
- **Root cause:** The listener was registered _after_ `await restCall`, but the emit fires during/right after the REST response — the listener attaches too late.
- **Prevention rule:** In realtime e2e, pre-register the event-listener promise (`const p = nextEvent(socket, name)`) _before_ performing the mutation that triggers the emit, then `await p` after. Applies to every signal-driven event test (open/submit/close/cancel).

## 2026-08-17 — DomainError.code vs .message

- **Failure mode:** Mapping a rejected Socket.IO connection to a stable error code used `error.message === 'SESSION_NOT_JOINABLE'`, but `DomainError.message` is the human description ("LiveSession cannot be joined."), not the stable code → unknown session-code rejections collapsed to `UNAUTHORIZED`.
- **Detection signal:** Test expected `SESSION_NOT_JOINABLE` for an unknown code, received `UNAUTHORIZED`.
- **Prevention rule:** Read the stable code from `DomainError.code` (`error instanceof DomainError && error.code === '...'`), never from `.message`. Other error classes collapse to a fail-closed default.

## 2026-08-18 — PostgreSQL CHECK constraints cannot contain subqueries

- **Failure mode:** A migration `ADD CONSTRAINT ... CHECK (NOT EXISTS (SELECT 1 FROM jsonb_array_elements(...)))` failed at apply time with `ERROR: cannot use subquery in check constraint` (SQLState 0A000), leaving the DB in Prisma P3018 (migration marked failed; no further migrations can apply until resolved).
- **Detection signal:** `prisma migrate deploy` reports `P3018` + `0A000 cannot use subquery in check constraint`.
- **Root cause:** PostgreSQL forbids subqueries (including set-returning functions in a FROM clause inside `NOT EXISTS(...)`) inside CHECK constraints. CHECK only accepts immutable scalar expressions.
- **Prevention rule:** For JSONB element-type/length validation in a CHECK, use the SQL/JSON path predicate functions `jsonb_path_exists` / `jsonb_path_match` (IMMUTABLE, allowed in CHECK) plus `jsonb_array_length` for non-empty. Probe with a throwaway `CREATE TEMP TABLE ... CONSTRAINT ... CHECK(...)` before writing the migration. When a migration fails mid-apply, recover with `prisma migrate resolve --rolled-back <name>` (requires DB-state authorization, separate from migrate deploy) then fix and re-deploy.

## 2026-08-18 — Prisma JsonNull vs DbNull for nullable JSONB columns

- **Failure mode:** Persisting `selectedOptionRefs: Prisma.JsonNull` on a `Json?` column guarded by a CHECK `selected_option_refs IS NULL OR (...)` raised `PrismaClientKnownRequestError P2039` (value not allowed for a Json field) at runtime, surfacing as an opaque 500.
- **Detection signal:** Debug log in the service catch showed `prismaCode: 'P2039'` on the open_text submission path; option-answer path (array value) worked.
- **Root cause:** `Prisma.JsonNull` writes a JSON `null` _value_ (not SQL NULL), so the CHECK `IS NULL` branch is false and the array branch evaluates `jsonb_typeof(null::jsonb)`. `Prisma.DbNull` writes an actual SQL NULL, which satisfies `IS NULL`. The two are not interchangeable.
- **Prevention rule:** For a `Json?` column that must read as SQL NULL (e.g. to satisfy a `IS NULL OR ...` CHECK), write `Prisma.DbNull`, not `Prisma.JsonNull`. Use `Prisma.JsonNull` only when you want the JSON value `null` stored. When a Prisma write fails opaquely, add a temporary `PrismaClientKnownRequestError` log (code + message) in the service catch to surface the exact code, then remove it.

## 2026-08-18 — Account-bound authorization must share lock order

- **Failure mode:** Participant creation or submission could pass an active-enrollment/account check and commit after a concurrent enrollment removal or account disable committed.
- **Detection signal:** The authorization read and the revocation mutation locked different rows, so a check-then-create/submit interleaving remained possible.
- **Prevention rule:** For account-bound live-session operations, lock the shared rows before the final authorization read in one documented order (`liveSession → course → account`), and revalidate role, status, and enrollment inside the same transaction.

## 2026-08-18 — Socket.IO `fetchSockets()` uses `RemoteSocket`

- **Failure mode:** Casting `RemoteSocket[]` to `Socket[]`, or typing a helper as `Pick<Socket, ...>`, caused TypeScript errors because `RemoteSocket.disconnect()` returns its own `this` type.
- **Detection signal:** `TS2352`/`TS2345` during typecheck/build at the gateway's `fetchSockets()` paths.
- **Prevention rule:** Keep the inferred remote-socket collection, describe only the members the helper uses (`id` and `disconnect(close?)`), and isolate any Socket-specific cast to the narrow call site that genuinely requires it.

## 2026-08-19 — Prisma 7 generated client is ESM-TS; breaks `tsc` CJS compilation

- **Failure mode:** Building the backend for Docker (`nest build` → `node dist/src/main`) crashed at startup with `ReferenceError: exports is not defined in ES module scope` at `dist/generated/prisma/client.js:38`, or `Cannot find module './internal/class.ts'`. The app ran fine in dev via `nest start` because the host `generated/prisma` was stale (from an older Prisma 7.x patch with extensionless imports).
- **Detection signal:** Comparing host `generated/prisma/client.ts` (extensionless imports, no `import.meta`) vs a fresh `npx prisma generate` in the image (imports `./internal/class.ts`, has `import { fileURLToPath } from 'node:url'` + `globalThis['__dirname'] = ... import.meta.url ...`). Same `prisma@7.9.1`, same schema — the generator's output style changed across 7.x patches.
- **Root cause:** Prisma 7.9.1's `prisma-client` generator emits ESM-flavored TS with explicit `.ts` import extensions and an `import.meta.url`-based `__dirname` shim. `tsc` with `module: commonjs` preserves the `.ts` suffix in the emitted `require("./internal/class.ts")`, but only `.js` files land in `dist/` → Node can't resolve them. The `import.meta` usage also confuses Node's CJS/ESM detection.
- **Prevention rule:** After `prisma generate` in any build pipeline (Docker, CI), normalize the generated client to CJS-safe TS: strip `.ts` extensions from _relative_ specifiers and drop the `import.meta.url` shim (CJS has a real `__dirname`). The repo's `scripts/normalize-prisma-client.mjs` does this idempotently. Do NOT rely on the host's stale `generated/` — a fresh clone regenerates the ESM-style output and breaks `node dist/...`. Verify with `node dist/src/main` (note: `nest build` emits `dist/src/main.js`, not `dist/main.js`, because tsconfig `rootDir=src` is preserved under `outDir`).

## 2026-08-19 — `ConfigService.get<number>()` does NOT convert env strings to numbers

- **Failure mode:** The login rate limiter read `LOGIN_RATE_LIMIT_*_WINDOW_MS` from `ConfigService.get<number>(...)` and used the value as `expiresAt = nowMs() + windowMs`. The env value is always a **string** (`"1000"`), and `ConfigService.get<number>` is only a TypeScript hint — no runtime coercion. `number + string` string-concatenated, so `expiresAt` became `~1.78e16` (≈ `String(nowMs()) + "1000"`) instead of `nowMs + 1000`. Buckets then never expired (`"17871546525501000" > 1787154653893` coerces the string to a huge number), turning the rate limit into a **permanent lockout** — the exact anti-pattern R-F7-7 forbids. The unit tests missed it because they passed plain numbers via a fake `ConfigService`; only the real-env e2e exposed it.
- **Detection signal:** e2e "login works after the window elapses" failed with `429` after a real 1100ms wait, while the isolated `SystemClock` unit test passed. A diagnostic `console.log` of `expiresAt` vs `now` showed `expiresAt` ~10000× too large and `acctMax` printed as `"3"` (a string).
- **Prevention rule:** Never trust `ConfigService.get<number>(key)` to yield a number — env values are strings. Coerce explicitly (`Number(raw)` + `Number.isFinite` guard) at the read site, or validate+convert in `env.validation.ts` and read the typed `EnvConfig` object. **Tripwire:** any module that does arithmetic on a `ConfigService.get` value must unit-test with a **string** env value (mirror real env), not just numbers, and must have an e2e/real-clock test that exercises expiry. The rate-limit e2e (`test/auth-rate-limit.e2e-spec.ts`) is now that tripwire.

## 2026-08-20 — Password policy must cover bootstrap writes

- **Failure mode:** Adding common-password rejection to `AccountService` left the first-admin bootstrap path able to hash a common password directly in `BootstrapService.createFirstAdmin`.
- **Detection signal:** A review of every `hashPassword` call found `bootstrap.service.ts` validated length in `bootstrapFromEnv` but hashed directly in the transaction method; the normal account/reset paths already called the shared policy.
- **Prevention rule:** Treat every password-to-hash sink, including bootstrap and test-only provisioning paths, as a policy boundary. Centralize the full validation helper and call it immediately before hashing.
- **Tripwire:** `grep -R "hashPassword" src/modules/identity` and verify each call site is preceded by length + common-password validation; retain an integration assertion for bootstrap and account temp-password rejection.

## 2026-08-22 — Compose commands and override ports need explicit working directory/merge checks

- **Failure mode:** A background Compose command started from the UI repository because the shell directory change was omitted; a later isolated Compose override appended the base `5433:5432` port instead of replacing it, causing a port-allocation failure.
- **Detection signal:** The first command reported `./.env.production` and Compose config missing; the isolated stack failed with `Bind for :::5433 failed`, and `docker compose config --format json` showed two DB port mappings.
- **Prevention rule:** Put `cd /home/user/projects/smartLearning/smartLearning-backend` inside every background command, pass `--env-file .env.production` for Compose interpolation, and inspect the fully merged config before lifecycle actions. Use Compose `!override`/`!reset` tags when an override must replace a list such as `ports`.
- **Tripwire:** Before `up`, assert the merged JSON contains exactly one backend `3000` mapping and one isolated DB mapping; after `up`, verify migration exit `0`, health `200`, and the runtime CORS value.

## 2026-08-23 — Isolated bootstrap must use the runtime artifact

- **Failure mode:** Running the host `npm run bootstrap:admin` through the available `tsx` toolchain failed before application startup because `PrismaService` received an undefined `ConfigService`; the Docker runtime itself was healthy.
- **Detection signal:** Bootstrap log failed at `src/prisma/prisma.service.ts` constructor injection before any account write, while the compiled bootstrap artifact inside the current-source runtime image succeeded against the isolated database.
- **Prevention rule:** For Docker-backed fixture provisioning, use the compiled bootstrap entrypoint from the exact image built from the checked-out source, pass secrets through process environment only, and verify the one-shot exit code before API fixture setup.
- **Tripwire:** Run `docker compose run --rm --no-deps backend node dist/src/bootstrap/bootstrap-admin.js`, require exit `0`, then probe `/auth/login` and the resulting account projection before proceeding; do not infer runtime failure from the host `tsx` path.

## 2026-08-23 — Compose config projections must accept string ports

- **Failure mode:** A sanitized `docker compose config --format json` assertion assumed every `ports` entry was an object; Compose emitted a string form for at least one entry, causing the jq projection to fail before reporting the safe port scope.
- **Detection signal:** `jq` reported `Cannot index string with string ("target")` while the lifecycle/runtime checks themselves remained read-only and unaffected.
- **Prevention rule:** When inspecting merged Compose JSON, normalize both string and object port representations before asserting published/target ports; keep the projection output limited to non-secret scope fields.
- **Tripwire:** Run the safe projection against both base and isolated config forms and require exactly one backend `3000:3000` and one isolated DB mapping before any `up`/`stop` action.

## 2026-08-28 — Keep hand-written migrations aligned with Prisma indexes

- **Failure mode:** The Prisma model declared a durable outbox target-routing index, but the hand-written migration initially omitted its `CREATE INDEX`; `prisma validate` still passed because it validates the schema, not migration completeness.
- **Detection signal:** Comparing the `LiveSessionEvent` model's `@@index` declarations with the migration DDL exposed the missing `idx_live_session_event_target` before deployment.
- **Prevention rule:** For every hand-written migration, diff model-level indexes/constraints against the SQL and inspect the migration file directly; use a read-only `prisma migrate diff`/schema review before requesting deployment.
- **Tripwire:** Require each new `@@index`, unique constraint, and CHECK constraint to have a corresponding migration assertion or explicit documented rationale, then rerun `prisma validate` plus `git diff --check`.

## 2026-08-29 — Durable realtime maintenance must stay bounded

- **Failure mode:** Publisher maintenance scans for expired, dead, or coalescible rows without a cap, so a backlog can starve normal event claims and overload socket recovery enumeration.
- **Detection signal:** Code review found unbounded `findMany`/global `UPDATE` maintenance before the already bounded `BATCH_SIZE` claim query.
- **Prevention rule:** Bound every maintenance selection/update/delete by a deterministic batch of IDs or a SQL CTE `LIMIT`; preserve retry/recovery fences when a batch cannot be notified.
- **Tripwire:** Unit assertions must verify `take: BATCH_SIZE` or equivalent `LIMIT` on expiry/dead/coalescing paths, and the publisher must still reach the claim query after a maintenance batch.

## 2026-08-29 — Realtime authorization and governance share commit boundaries

- **Failure mode:** Actor reads or archived participant rows can observe or retain identity state across a revocation/close boundary when authorization or anonymization runs as an unlocked/separate operation.
- **Detection signal:** Lock-order/privacy review identified anonymous reads that skipped the LiveSession lock and close/archive that left `Participant.accountId`, displayName, and token lookup fields attached to retained submissions.
- **Prevention rule:** Lock `liveSession` before anonymous realtime reads and use `READ COMMITTED` for lock-first authorization; atomically anonymize participant identity fields when creating the archive while keeping only anonymous submission linkage.
- **Tripwire:** Add lock-hold tests for anonymous read versus close and archive assertions that retained submissions point only to sanitized participant rows.

## 2026-08-29 — Reject wildcard origins at every credentialed transport boundary

- **Failure mode:** HTTP CSRF matching could be strict while Socket.IO CORS still translated configured `*` into `origin: true`, allowing credentialed cross-origin handshake attempts.
- **Detection signal:** WebSocket adapter construction accepted wildcard origins independently of the environment validation path.
- **Prevention rule:** Reject wildcard entries in validated `CORS_ORIGIN` and pass only explicit origin arrays to both HTTP and Socket.IO CORS configuration.
- **Tripwire:** Keep an environment-validation test for a wildcard in a comma-separated list and a websocket adapter test for the explicit-origin array.

## 2026-08-29 — Shutdown cleanup must not assume a new migration is deployed

- **Failure mode:** A newly wired publisher cleanup query ran during an AppModule unit-test teardown against a database that predated the durable outbox migration, causing module close to fail even though no lease had been claimed.
- **Detection signal:** Full unit verification failed with Prisma `P2021` (`public.live_session_event` does not exist) from `onModuleDestroy`.
- **Prevention rule:** Track outstanding leases and perform graceful lease release only when this process has actually claimed rows; schema-required runtime paths must still fail loudly when exercised.
- **Tripwire:** Keep an un-migrated AppModule compile/close test and assert the publisher does not issue cleanup writes without an outstanding claim.

## 2026-08-29 — Redis adapter binding must follow availability

- **Failure mode:** Selecting the Redis adapter only during Socket.IO startup left optional-mode traffic on a broken adapter after a runtime Redis outage, despite readiness reporting local fallback.
- **Detection signal:** Realtime review compared the advertised `optional` policy with the one-time adapter installation in the WebSocket bootstrap.
- **Prevention rule:** Rebind the active `/live` namespace to a local adapter on outage, preserve room membership synchronously, and reconnect Redis with bounded backoff; rebind Redis after both clients are ready.
- **Tripwire:** Add adapter transition tests that cover startup-unavailable, runtime outage, room preservation, recovery, and shutdown timer cleanup.

## 2026-08-29 — Account revocation enumeration failures need retry

- **Failure mode:** A post-commit account-disabled signal could be swallowed when Socket.IO adapter enumeration failed, leaving matching sockets connected without a retry path.
- **Detection signal:** Realtime authorization review found `fetchSockets()` failure logged as a successful return from the revocation handler.
- **Prevention rule:** Propagate enumeration failure, schedule bounded-backoff retries until enumeration succeeds, and retain per-delivery PostgreSQL authorization checks as the safety net.
- **Tripwire:** Unit-test rejected `fetchSockets()` with a retry timer and verify shutdown clears the pending timer.

## 2026-08-29 — Close replaced Socket.IO adapters

- **Failure mode:** Dynamically switching `/live` from Redis to the local adapter without closing the previous Redis adapter retained its subscriber listeners across Redis outages and recoveries.
- **Detection signal:** Realtime review found `applyAdapter()` replacing the namespace adapter while never invoking the prior adapter's lifecycle cleanup.
- **Prevention rule:** Capture and close the previous namespace adapter before every actual adapter transition; isolate cleanup failures so failover still completes, and preserve room membership during the replacement.
- **Tripwire:** Exercise local → Redis → local → Redis transitions and assert the replaced adapter is closed exactly once while all socket rooms are restored.

## 2026-08-29 — Quiesce background publishers before destructive test cleanup

- **Failure mode:** A long-lived E2E application let `LiveSessionPublisher` continue projection, acknowledgement, or retry work while the next test's `truncateAll()` issued schema-wide `TRUNCATE ... CASCADE`, intermittently deadlocking PostgreSQL.
- **Detection signal:** Combined Checkpoint C execution failed in `test/setup/db.ts::truncateAll()` with SQLSTATE `40P01`, while isolated reruns could pass and publisher retry/dispatch warnings appeared around cleanup.
- **Prevention rule:** Treat destructive fixture cleanup as a lifecycle boundary: stop wake sources, await the active publisher drain, release only the instance's outstanding leases, run cleanup, then restart exactly one subscription/timer/startup scan for realtime tests.
- **Tripwire:** Keep deterministic deferred/fake-timer unit tests proving shutdown waits for in-flight work, restart performs a startup scan, duplicate init creates no duplicate wake sources, and repeated destroy performs lease cleanup at most once.

## 2026-08-30 — Prisma client normalizer requires its generated-directory argument

- **Failure mode:** Running `npm run prisma:generate && node scripts/normalize-prisma-client.mjs && npm run prisma:validate` stopped after generation because the normalizer requires an explicit generated-client directory.
- **Detection signal:** The script printed `Usage: node scripts/normalize-prisma-client.mjs <generated-dir>` and exited 1 before schema validation.
- **Prevention rule:** Invoke the repository normalizer with the generated output path: `node scripts/normalize-prisma-client.mjs generated/prisma`.
- **Tripwire:** Keep the generate → normalize-with-argument → validate sequence in CP3/CI verification instructions and require a zero exit code from each command.

## 2026-08-30 — Manual verification specs still cross static quality gates

- **Failure mode:** The full automated bundle failed its lint and format gates because the pre-existing `test/manual-cp2-verify.e2e-spec.ts` was unformatted and contained two unused login locals, even though all behavioral suites passed.
- **Detection signal:** `npm run format:check` reported the manual CP2 file, while `npm run lint:check` reported eight Prettier diagnostics and two unused-variable errors.
- **Prevention rule:** Keep manual verification specs formatted and lint-clean even when they are not part of the automated behavioral run; fix static-only failures before recording the bundle as green.
- **Tripwire:** Run `npm run lint:check` and `npm run format:check` after adding or editing any manual E2E spec, without executing the manual database scenario.

## 2026-09-01 — Bind local test PostgreSQL to loopback only

- **Failure mode:** Creating the test database with Docker's shorthand `--publish 5432:5432` exposed PostgreSQL on all host interfaces instead of only the required localhost endpoint.
- **Detection signal:** `docker ps` reported `0.0.0.0:5432->5432/tcp` and `[::]:5432->5432/tcp` despite the task's localhost-only requirement.
- **Prevention rule:** For local-only database services, always use an explicit loopback mapping (`127.0.0.1:5432:5432`) and verify the rendered mapping after startup.
- **Tripwire:** Reject any test database startup whose `docker ps` mapping is not exactly `127.0.0.1:<host-port>->5432/tcp`.

## 2026-09-01 — Adapter replacement must invoke close synchronously

- **Failure mode:** `RealtimeRedisService.closeAdapter()` deferred `adapter.close()` to a promise microtask, so the lifecycle unit assertion observed the replacement before `close()` had been invoked.
- **Detection signal:** `npm test -- --runInBand` failed `src/modules/realtime/realtime-redis.service.spec.ts` with expected `redisAdapters[0].close` once, received 0 calls at line 76; a temporary synchronous-invocation patch made the isolated test pass.
- **Prevention rule:** Invoke Socket.IO adapter cleanup synchronously when an adapter is actually retired, track its returned promise for shutdown draining, and retain the Redis adapter across availability-only failover so shared-client unsubscribe work cannot race recovery.
- **Tripwire:** Keep the room-preserving Redis→local→Redis reuse test, shutdown-drain coverage, and require the full unit suite to pass before release evidence proceeds.

## 2026-09-02 — Adapter lifecycle test doubles must model availability transitions

- **Failure mode:** A strengthened adapter test double always returned a Redis factory, so the simulated outage never switched the namespace back to the local adapter; a weak assertion had hidden the invalid fixture.
- **Detection signal:** Replacing a weak `toBeDefined()` assertion with identity verification exposed the test helper's unconditional Redis factory.
- **Prevention rule:** Test doubles for availability-driven failover must derive adapter selection from the same availability state as production, and assertions must verify the concrete replacement target.
- **Tripwire:** In adapter transition tests, assert both Redis→local and local→Redis identity after toggling availability; do not use presence-only assertions for lifecycle state.

## 2026-09-10 — Use dedicated file tools instead of shell truncation helpers

- **Failure mode:** A repository search command piped `rg` output through `head`, despite the available dedicated search/read tools and harness guidance to avoid shell output-truncation helpers.
- **Detection signal:** Command text contained `| head -20`; the result happened to work but bypassed the preferred structured file/search workflow.
- **Prevention rule:** Use `rg` with a sufficiently narrow query and read exact files with the Read tool; do not append `head`, `tail`, `cat`, `sed`, or `awk` merely to constrain output when dedicated tools fit.
- **Tripwire:** Before issuing a read-only Bash pipeline, check whether the same lookup can be expressed as a narrow `rg` query plus targeted Read; if yes, use those tools instead.

## 2026-09-11 — live_session_event CHECK ties target_participant_id to participant_after_submit visibility

- **Failure mode:** A BE-5.2 retention dry-run e2e fixture wrote a `teacher`-visibility `live_session_event` with a non-null `targetParticipantId`, expecting to create an out-of-scope event the executor must not delete; the INSERT was rejected with `23514` (`live_session_event_check`).
- **Detection signal:** `PrismaClientKnownRequestError ... 23514 New row for relation "live_session_event" violates check constraint "live_session_event_check"` at create time.
- **Root cause:** The durable-realtime migration
  (`20260828110000_add_durable_realtime`) adds `CHECK (("visibility" = 'participant_after_submit') = ("target_participant_id" IS NOT NULL))`. Only a `participant_after_submit` event may carry a target; a `teacher`/`session` event must leave it NULL.
- **Prevention rule:** When seeding mixed-visibility realtime events for deletion/scope tests, set `targetParticipantId` only on `participant_after_submit` events and omit it (NULL) on `teacher`, `session`, and `participant` events.
- **Tripwire:** Before inserting a hand-authored `live_session_event`, grep the durable-realtime migration for `visibility`-related CHECK constraints, especially any `(visibility = X) = (y IS NOT NULL)` pairing.

## 2026-09-10 — Commands must target the relevant independent repository

- **Failure mode:** Ran `npx prettier --write src/...` from the UI repository while editing backend files; the command failed with `No files matching the pattern were found` because this multi-project root is not a workspace.
- **Detection signal:** Tool output named the intended backend-relative paths but found none under the active UI working directory.
- **Prevention rule:** Before every npm/npx command, identify the owning project and use an explicit project-local binary with absolute target paths (or an explicitly approved project working directory); never assume the session CWD matches the edited repository.
- **Tripwire:** Compare each command's target file path with the nearest project `package.json`; if they belong to different repositories, rewrite the command with an explicit backend/UI path before execution.

## 2026-09-11 — Retention purge: `next_purge_attempt_at` must gate retry rows only, not pending rows

- **Failure mode:** Checkpoint D claim/scan queries gated **all** eligible rows on `next_purge_attempt_at <= now`. Because archive creation sets `next_purge_attempt_at = purge_at` (Checkpoint B backfill), a pending row whose fixture/data rewrites only `purge_at` backward stayed ineligible, so `purgeDue` claimed 0 rows and skipped legitimate due archives.
- **Detection signal:** Guarded e2e `purges a bounded oldest-first batch`, `serializes concurrent purgeDue`, and `reclaims an expired processing lease` all reported `deleted: 0 / selected: 0` after the fixture moved a pending archive's `purge_at` into the past.
- **Root cause:** Backoff/cooldown is only meaningful for **retry** rows. A pending (first-attempt) row is due purely on `purge_at`; a `processing` row is reclaimable on lease expiry; only a `retry` row should honor `next_purge_attempt_at`.
- **Prevention rule:** In a durable retention claim, branch the eligibility by state so `next_purge_attempt_at` constrains only `retry`, `purge_at` constrains pending, and lease expiry constrains `processing`. Do not add an unconditional `next_purge_attempt_at` filter.
- **Tripwire:** When adding a purge-eligibility predicate, assert separately that (a) pending, (b) ready retry, (c) backoff-gated retry, and (d) expired-processing rows each have the intended eligibility, and keep pending rows driven purely by `purge_at`.

## 2026-09-15 — Keep runtime-only credentials in one continuous execution

- **Failure mode:** A generated W1 teacher password was created in one shell, then the staged load loop ran in a later shell without that password; provisioning succeeded but every fixture login failed with `AUTH_INVALID_CREDENTIALS`.
- **Detection signal:** Provisioning output was successful, but the harness emitted `Teacher login failed (AUTH_INVALID_CREDENTIALS)` and no report file was produced.
- **Prevention rule:** Generate the password and run provisioning plus every gated stage in one continuous shell; never reconstruct, print, persist, or replace the runtime-only password between stages.
- **Tripwire:** Assert the provisioning command succeeds and immediately run a credential smoke/login before creating any W1 fixture; abort on any harness login failure and do not advance stages.

## 2026-09-15 — W1 orchestration must preserve existing guard variable names

- **Failure mode:** The first W1 orchestrator used `LOCAL_W1_PROVISION_TARGET`, but the existing provisioning guard and documented command require `LOCAL_PROVISION_TARGET`; provisioning failed before account creation.
- **Detection signal:** The child provisioning command returned `LOCAL_PROVISION_TARGET=disposable is required.` and no teacher was created.
- **Prevention rule:** Before wrapping an existing CLI, copy its exact environment contract from the authoritative implementation and docs; do not derive new variable names from the feature prefix.
- **Tripwire:** Execute the orchestrator's smoke-only path with the documented environment and require the child provisioning command to pass before any fixture or participant operation.

## 2026-09-12 — Automation scripts must use an available interpreter

- **Failure mode:** A task-record append invoked `python`, but this environment exposes only `python3`, so the command failed before changing the file.
- **Detection signal:** The shell returned `zsh: command not found: python` with exit code 127.
- **Prevention rule:** Check `command -v python3` or use the repository runtime before invoking an ad hoc interpreter; do not assume a `python` alias exists.
- **Tripwire:** For future shell-based file transforms, select an interpreter only after a read-only availability check and require exit code 0 before continuing.

## 2026-09-12 — Do not format the historical task ledger during a focused change

- **Failure mode:** A focused verification command included `tasks/todo.md` in Prettier input, producing large alignment-only rewrites across historical tables and mixing review noise with the scheduler safety change.
- **Detection signal:** `git diff --numstat -- tasks/todo.md` showed 154 insertions / 99 deletions although the intended task update was append-only.
- **Prevention rule:** Never run repository formatters over the historical task ledger for a focused checkpoint; append/edit only the current section and exclude `tasks/todo.md` from formatter file lists.
- **Tripwire:** Before final review, inspect `git diff --numstat -- tasks/todo.md`; unexpected historical churn must be removed before delivery or explicitly reported if environment protection blocks restoration.

## 2026-09-13 — Checkpoint G step 5: secret exposure via unmasked tool output

- **Failure mode:** `grep "^S3_" .env.staging | sed 's/\(KEY_ID\|SECRET\)=.*/\1=<set>/'` 只遮罩了 KEY_ID/SECRET 兩個字尾，但實際欄位名是 `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`（`S3_ACCESS_KEY_ID` 未含 "SECRET" 字尾）→ write-only secret 以明文進入 shell 輸出。
- **Detection signal:** 讀回 tool 輸出時發現 `S3_SECRET_ACCESS_KEY=kSkD...` 以明文顯示。
- **Prevention rule:** 對含 secrets 的 env 檔做任何展示前，用「先輸出到臨時檔再 sed」或逐行白名單遮罩（`sed -E 's/(KEY|TOKEN|SECRET|PASSWORD)=.*/\1=<set>/'`），且優先使用 `grep -c` 之類不出值的斷言；一旦洩漏立即旋換憑證。
- **Tripwire:** 任何讀取 `.env.*`/credentials 檔的命令，輸出經 `grep -cE '=(GENERATE_ME|FILLED_BY_SETUP)$'` 之類斷言確認，或先跑 `grep -E 'SECRET|TOKEN|PASSWORD|KEY' file | sed 's/=.*/=<set>/'` 複核無明文。

## 2026-09-18 — Gate3 background samplers need exported Compose inputs

- **Failure mode:** The remediation heartbeat ran in a background subshell before Compose interpolation variables were exported, so service resolution silently produced `absent` rows even while containers were healthy.
- **Detection signal:** `heartbeat.tsv` contained repeated `absent` records; direct Compose resolution failed with missing `GATE3_SECRET_HOST_DIR`/image/port interpolation variables.
- **Prevention rule:** Export or explicitly pass every Compose interpolation variable before starting background lifecycle samplers; prefer a wrapper that supplies variables on every Compose invocation instead of relying on ambient shell state.
- **Tripwire:** Render the exact Compose config before startup and require heartbeat samples to contain resolved container IDs, running state, and health before reporting `UP PASS`.

## 2026-09-18 — Rancher Desktop port publication needs a non-internal ingress network

- **Failure mode:** Gate3 attached qa-a/qa-b only to an `internal: true` bridge; the services were healthy in-container, but Rancher Desktop did not materialize usable loopback-published ports.
- **Detection signal:** Container inspect showed `NetworkSettings.Ports={"3000/tcp":null}` and `docker compose port` failed; a controlled bridge experiment published successfully only after the container also joined a non-internal bridge.
- **Prevention rule:** Separate dependency isolation from host ingress: keep Redis, secret initialization, and the temporary test-DB attachment on the internal network, and attach only qa-a/qa-b to a disposable non-internal ingress network.
- **Tripwire:** Before reporting Gate A PASS, require both QA port mappings to be non-null and HTTP-reachable, prove Redis and the protected DB are absent from the ingress network, then prove both per-run networks are absent after `down` and the DB's original network-name set is restored exactly.

## 2026-09-19 — Cross-boundary identity, port state, and disposable infrastructure

- **Failure mode:** Treating localhost as the application's source identity, equating `HostConfig.PortBindings` with an active published port, trusting stale Rancher Desktop mount paths or containers, or proceeding without verifying the target database/Redis/network/environment could misclassify infrastructure failures or mutate the wrong resource; backup evidence was also accepted without a restore proof.
- **Detection signal:** Container inspection and runtime connectivity disagreed with assumed host identity or port publication; minimal-container reproduction was not established before considering Rancher Desktop, WSL, firewall, or daemon changes; stale `/mnt/wsl/rancher-desktop/run/docker-mounts/...` paths and unknown disposable state were treated as authoritative; destructive-test target identity or backup restoration was unverified.
- **Prevention rule:** Never assume localhost identity across Windows/WSL/Docker boundaries. Never equate `HostConfig.PortBindings` with an active published port: verify `NetworkSettings.Ports` and actual Windows/WSL connectivity. Reproduce infrastructure failures with a minimal standalone container before changing Rancher Desktop, WSL, firewall, or daemon settings. Treat Rancher Desktop materialized mount paths as runtime-only, recreate disposable containers from source-controlled configuration, verify database/Redis/network/`NODE_ENV`/backend identity before destructive tests, and call a backup proven only after a successful restore.
- **Tripwire:** For every important disposable run, record runtime-observed source identity, rendered port mappings, and an actual connectivity probe; require a minimal-container reproduction before host/runtime changes; reject non-reproducible mount paths and stale resources; perform exact identity checks before destructive operations; and require a restore test with verified data before declaring backup success.

## 2026-09-19 — Mock subprocess fixtures need explicit environment propagation

- **Failure mode:** A Gate3 lifecycle fixture invoked a generated mock script as a child process but kept its output-path variable shell-local, so the child expanded an empty path and the mocked suite stopped before exercising the lifecycle assertions.
- **Detection signal:** The no-Docker test failed with `source-evidence.sh: line 2: : No such file or directory` while shell syntax and earlier in-process fixtures passed.
- **Prevention rule:** Export or explicitly pass every variable consumed by generated child-process fixtures; do not assume a variable assigned in the parent shell is inherited.
- **Tripwire:** For each generated executable fixture, enumerate its referenced variables and assert they are exported or provided inline before invocation; the fail-closed mock suite must reach its final PASS marker.

## 2026-09-19 — Restore real shell functions after phase-order mocks

- **Failure mode:** A lifecycle-order fixture replaced `attach_qa_publish_network` with a logging stub, then a later fixture attempted to test the real helper without re-sourcing it, so the test observed the stale stub instead of production behavior.
- **Detection signal:** The mocked suite reached the attachment fixture but failed its expected `ensure → boundaries → qa-a → qa-b` call sequence with an empty attachment log.
- **Prevention rule:** Treat Bash function overrides as shared mutable fixture state; isolate them in subshells or explicitly re-source/save-and-restore the production definition before the next fixture.
- **Tripwire:** Before a fixture claims to exercise a real helper, assert `declare -f <helper>` contains a production-only marker or re-source the library immediately before installing that fixture's dependency mocks.

## 2026-09-19 — Test `errexit`-dependent helpers under production shell semantics

- **Failure mode:** A fixture called a helper under `set +e` to capture its status, but the production helper relies on `set -e` to stop immediately when `docker network connect` fails; the test therefore continued and returned a later command's status.
- **Detection signal:** The injected connect operation returned 9, but the outer fixture observed a different status and continued beyond the intended failure point.
- **Prevention rule:** When testing Bash helpers whose control flow depends on `errexit`, invoke them in a subshell with `set -e` and capture the subshell status from a parent temporarily using `set +e`.
- **Tripwire:** Every injected-failure fixture must assert both the original failure status and absence of calls after the failure boundary.

## 2026-09-19 — TSV `printf` formats must match schema arity

- **Failure mode:** A ten-column source-evidence row used only nine `%s` conversions. Bash `printf` reused the format for the extra argument, splitting one logical row and violating the declared TSV schema.
- **Detection signal:** Header field-count assertions passed syntax checks but the first aggregate data row did not contain the declared ten columns.
- **Prevention rule:** Keep each TSV header, format string, and argument list at the same explicit arity; never rely on Bash `printf` format reuse.
- **Tripwire:** Mocked evidence tests must assert field counts for both header and first data row of every TSV artifact.

## 2026-09-19 Gate3 publish network cleanup flag not authoritative
- Failure mode: `gate3:down` skipped `remove_publish_network` whenever `PUBLISH_NETWORK_CREATED != 1`, but Compose can materialize the project-scoped `gate3-publish` network independently of the harness's explicit `ensure_publish_network`, leaving the network behind with state flag = 0.
- Detection signal: post-down verification `publish_network_present=YES` while all other resources were already removed.
- Prevention rule: cleanup removal decisions must be verified from the resource's own identity labels, never from a harness state flag; absent resources must be treated as idempotent success; attached-container states must fail closed with a container listing.
- Tripwire: `tools/gate3/tests/run.sh` publish-network removal contract fixtures (absent / empty / attached / identity-mismatch).

## 2026-09-19 Gate A: source-correlation parse fails on real pino-pretty logs
- Failure mode: `source-evidence.sh` probes HTTP successfully but correlation always fails against real logs — the extracted JSON is the pino object, while `request completed` appears as pretty-printed message text before the JSON, so `.msg` does not exist in real records; mock fixtures embed `msg` inside the JSON object and therefore cannot catch this.
- Detection signal: `matches=0 reason=msg mismatch` for every attempt while `marker_present=YES` and the record is visually present in Compose logs.
- Prevention rule: source-correlation extraction must be validated against a real captured log line fixture (not only synthetic mocks); correlate on fields inside the JSON (`req.url`, `req.headers`, `res.statusCode`) rather than the pretty-printed message text, or parse pino JSON transport output directly.
- Tripwire: one real-log fixture test in `tools/gate3/tests/run.sh` using a captured pino-pretty line with the message outside the JSON.

## 2026-09-19 — Gate3 parser fix follow-ups (fixture traps)
- Failure mode: three fixture-authoring traps surfaced while fixing the source-correlation parser: (1) a mock `docker logs` fixture reused the qa-a marker record for qa-b, so the qa-b probe could never correlate; (2) a global `sed "s/$marker/wrong-id/g"` removed every marker occurrence, turning an ID-mismatch case into "marker not found" instead; (3) a Bash string-substitution line with mismatched quoting silently shifted parsing and produced a downstream "unbound variable" at an unrelated line.
- Detection signal: FAILs attributed to wrong rejection reasons or to line numbers that did not correspond to the visible code.
- Prevention rule: build each rejection-reason fixture by mutating exactly the field it tests (keep all other marker occurrences intact); give every fixture case a unique run id so its diagnostics survive; after any Bash quoting-heavy fixture edit, run `bash -n` plus a smoke of the fixture string before the suite.
- Tripwire: the mocked suite asserts each rejection reason by exact string in the per-case `source-correlation.tsv`, and the container-free parser fixtures assert both exit status and `SOURCE_IDENTITY` value for the real captured-format line.

## 2026-09-20 — Guarded full-table test cleanup can conflict with retained-resource exclusions

- **Failure mode:** Authorized DB-backed suites were allowed to call `truncateAll()` on `smartlearning_test` even though the same task required a historically retained W1 candidate to remain untouched. The candidate's exact IDs were not checked immediately before the first truncating suite, so later absence cannot be attributed: it may have been absent beforehand or removed by suite cleanup.
- **Detection signal:** Post-W1 exact cleanup verification found retained candidate LiveSession `01a0bacc-83f9-7417-a52e-481d2fbd3e8c` absent, but no pre-suite row-existence artifact had been captured.
- **Prevention rule:** Before authorizing any suite whose setup performs full-table TRUNCATE, reconcile every retained-resource exclusion against the target database. If any excluded row exists, do not run the suite against that database; create a fresh disposable database or use non-truncating targeted setup. Record before/after exact-ID existence even when the expected result is zero.
- **Tripwire:** A pre-DB-test script must list only counts for every protected exact ID and fail closed if any count is nonzero; preserve that output before migration/truncation begins.

## 2026-09-20 — Freeze verified W1 performance baselines before further diagnosis

- **Failure mode:** A performance experiment can be incorrectly treated as a new acceptance result, allowing an effective-but-insufficient improvement to overwrite the prior comparison baseline or invite another tuning round before governance status is recorded.
- **Detection signal:** W1-300 C+B correctness was exact, but Join p95 remained 1280.57 ms against the 1000 ms formal threshold; the remaining contention location was not directly proven.
- **Prevention rule:** Freeze the verified `W1 PERFORMANCE BASELINE — C+B` in `tasks/todo.md`, preserve the accepted lock/sequence/response-path architecture, classify Formal W1 as FAIL solely on latency, and record unresolved bottlenecks only as hypotheses until direct evidence exists.
- **Tripwire:** Before any future optimization, compare against client p50/p95/p99/max `922.52/1280.57/1311.13/1318.49` ms, transaction p95 `774.21` ms, service p95 `1037.24` ms, and `postCommitSnapshot` response-path = NO; reject any report that omits correctness and formal-threshold verdicts.

## 2026-09-20 — W2 harness: fixture option ids must be SessionQuestion snapshot ids

- **Failure mode:** W2 fixture provisioning wrote QuestionDefinition option ids; the submit API validates against the SessionQuestion snapshot option ids (different UUIDs). 300/300 submissions failed with `OPTION_REF_INVALID` while the fixture file looked complete.
- **Detection signal:** every submit returns 400 `OPTION_REF_INVALID` with valid-looking option UUIDs; `session_question_option.id` ≠ `question_option.id` for the same optionRef.
- **Prevention rule:** capture fixture options from the SessionQuestion snapshot (teacher snapshot re-read after `startLiveSession`), and take quiz `isCorrect` from the teacher results projection (the session DTO does not expose it).
- **Tripwire:** create-fixture must fail if snapshot options are missing or all-false for a quiz; targeted smoke (20) before any 300 gate.

## 2026-09-20 — W2 harness: run-once guards are mandatory for load drivers

- **Failure mode:** `run-w2.ts` was accidentally executed twice against one fixture: two join waves (80 participants) and two submission waves (40 successful) while only the last artifact survived. Anonymous join does not dedupe by displayName, so both waves "succeeded" and the first artifact was lost.
- **Detection signal:** duplicate display names with `n=4`; 40 server-side 201s for a 20-participant smoke; missing first-wave artifact.
- **Prevention rule:** load drivers must refuse to overwrite an existing artifact and must not run twice against the same fixture; every run requires a fresh fixture/runId.
- **Tripwire:** artifact-overwrite refusal in the driver (implemented).

## 2026-09-20 — W2: premature socket disconnect caused apparent broadcast loss

- **Failure mode:** the driver disconnected realtime sockets immediately after the DB reconcile; the durable publisher drains sequentially (≈1 event/sec; 625/625 claims were `claimedCount=1`), so most targeted `RESULT_UPDATED` emissions happened after sockets were dropped — observed receipts ≈50% of expected.
- **Detection signal:** client receipts ~half of DB-delivered events across runs; delivery_state='delivered' in DB with no client receipt.
- **Prevention rule:** settle on the DB outbox drain (all `result.updated` delivered, bounded) before closing sockets; report commit-to-broadcast from DB correlation (submitted_at → delivered_at by participantId/event_seq) and mark client receipts as auxiliary with the documented `COMMIT TIMING EVIDENCE GAP`.
- **Tripwire:** a targeted-socket probe (solo receipt) before the 300 gates; drain-settle before disconnect.

## 2026-09-20 — Protected-ID preflight must precede any truncating suite (revalidated)

- **Failure mode:** (prior lesson) truncating suites ran without checking the protected W1 candidate. This session re-verified: protected teacher `local-w1-1789840353701-82cd63fa` and LiveSession `01a0bacc-83f9-7417-a52e-481d2fbd3e8c` are absent from `smartlearning_test`; pre-existing `cp3-*` rows were left untouched (no truncate used at any point in W2).
- **Detection signal:** exact-ID existence query recorded before any cleanup (protected-check.mjs).
- **Prevention rule:** every DB-backed W2 run begins with the exact protected-ID existence artifact; cleanup is exact-ID FK-traceable deletes only.
