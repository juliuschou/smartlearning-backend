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

## 2026-09-21 — Realtime trace run isolation uses empty 200 responses

- **Failure mode:** The first W3-DIAG-20 preflight treated a mismatched `runId` returning HTTP 200 with zero records as an isolation failure, so the diagnostic stopped before fixture creation.
- **Detection signal:** The trace endpoint returned `enabled=true` for the active run and an empty record set for the mismatched run; repository trace-client semantics define mismatches as unavailable/empty evidence, not a non-200 response.
- **Prevention rule:** Validate trace isolation by asserting that a mismatched run cannot expose active-run records, not by requiring a rejection status; preserve the endpoint's established 200-empty behavior.
- **Tripwire:** Preflight must compare active versus mismatched snapshots and require mismatched records to be empty while never interpreting that response as workload evidence.

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

## 2026-09-20 — W3: DB `delivered` does not imply client receipt; log absence is not proof

- **Failure mode:** In W3-SMOKE-20, every durable `live_session_event` row reached `delivery_state='delivered'` (`attempt_count=1`, `coalesced=false`) while client sockets on a demonstrably connected, snapshot-receiving transport observed only a subset (vote-to-reveal 5/10 and 3/10; run 2 final broadcast 0/21). The backend dispatch log was lossy (15 `dispatching event` lines for 35 rows), so log absence could not establish that the server failed to emit.
- **Detection signal:** `delivered_at` set on 100% of rows + per-socket `session.snapshot` received + zero disconnects + missing `result.updated` receipts. DB-side "delivered" and client-side receipt disagree.
- **Prevention rule:** Treat `delivery_state='delivered'` as *server dispatch completed*, never as *client received*. For any realtime correctness gate, require client-receipt evidence correlated by `event_seq`; classify a miss as `HARNESS EVIDENCE GAP` (not `CLIENT NOT RECEIVED`) whenever the server-emit leg cannot be proven — and never conclude "server did not emit" from log absence alone.
- **Tripwire:** before asserting non-emission, confirm the log line count for the event equals the durable row count; if it does not, the log is lossy and absence is not evidence.

## 2026-09-20 — Harness bug: mixing `performance.now()` with wall-clock timestamps

- **Failure mode:** The W3 publish-proxy latency subtracted `performance.now()`-relative receipt times from `Date.parse(server_timestamp)`, producing values near −1.79e12 ms.
- **Prevention rule:** Compute any delta from two clocks of the same kind — either both monotonic (`performance.now()`) or both wall-clock (`Date.parse`). Assert latency samples are non-negative before reporting.
- **Tripwire:** a latency summary containing a large-magnitude negative number is a harness bug, not a measurement.

## 2026-09-25 — Tool timeout is not W3 driver failure evidence

- **Failure mode:** A shell/tool or background-execution timeout can be mistaken for driver termination, leading an operator to stop a still-running W3 process or attribute stale stderr from another invocation to the current run.
- **Detection signal:** The driver PID remains live, no numeric exit-code artifact exists, or stderr lacks matching run ID / PID / timestamp / invocation evidence.
- **Prevention rule:** Before stopping or classifying a W3 driver, check PID liveness, the exit-code artifact, current phase/run state, formal-report state, and run-correlated stderr. Never use `TaskStop` solely because a shell/tool/poll timed out or output is temporarily silent.
- **Tripwire:** Every fresh W3 invocation must use run-exclusive stdout/stderr plus a controlled wrapper that records wrapper PID, child PID, start/finish timestamps, signal state, and numeric exit code.

## 2026-09-25 — Backend attribution requires listener and trace identity proof

- **Failure mode:** A PID artifact and a backend log can describe different process attempts; a later `EADDRINUSE` observation does not by itself prove which backend served earlier workload traffic or that a second publisher existed.
- **Detection signal:** Recorded PID, log PID, port-owner PID, trace `processId`, run ID, backend instance, or publisher instance do not form one consistent identity chain.
- **Prevention rule:** Preserve discrepancies neutrally, then require `child PID = listener PID = trace processId` plus matching cwd, command, process start, run ID, backend instance, and publisher instance before fixture creation.
- **Tripwire:** Any identity mismatch, duplicate candidate backend/publisher, or uncorrelated stderr is a hard stop; do not launch a replacement backend in the same authorized attempt.

## 2026-09-25 — Size the W3 trace buffer before backend start

- **Failure mode:** A fresh 300-participant diagnostics backend was started with the default trace buffer of 5,000 records even though the immediately preceding comparable run retained 5,451 records. Continuing would risk dropped attribution evidence, while the once-only backend rule prohibited restarting with a larger buffer.
- **Detection signal:** Trace preflight reports `bufferSize=5000`; prior run evidence exceeds that capacity before considering variation or additional lifecycle records.
- **Prevention rule:** Derive and record the required trace capacity from the largest comparable retained trace plus safety margin, then set `REALTIME_TRACE_BUFFER_SIZE` before the first backend spawn. Treat buffer capacity as part of the backend execution contract, not a post-start check.
- **Tripwire:** Before spawning a fresh W3-300 backend, require the execution contract and command metadata to state `REALTIME_TRACE_BUFFER_SIZE>=20000`; after readiness, require trace preflight to report the same capacity before fixture provisioning.

### 2026-09-25 — W3 fresh rerun: two environment-contract gaps masked attribution

- **Failure mode:** (1) The diagnostics backend was started without `REALTIME_TRACE_RUN_ID`, so the trace service's internal runId defaulted to its instanceId; the driver queried by runId and received 0 records, causing the formal report to classify all 150 delivered votes as `UNRESOLVED_DELIVERED_NO_PUBLISHER_RECORD` even though the full trace proved publisher+emit coverage. (2) Both the fixture provisioning and the driver invocation were launched without repo-required env vars (`LOAD_CORS_ORIGIN`, `W3_FIXTURE_PATH`/`W3_OUTPUT_PATH`) and failed pre-flight with exit 2 — one authorized invocation consumed before any traffic.
- **Detection signal:** Report `serverTrace.phaseB.unavailableReason=RUN_ID_MISMATCH`; fixture/driver exit 2 with "… is required" before any DB writes or socket connects.
- **Prevention rule:** Backend start contract for W3 diagnostics must include `REALTIME_TRACE_RUN_ID=<runId>` alongside buffer size; before spawning fixture or driver, verify all repo-required env vars from `scripts/load-harness/{config,fixture,http-client}.ts` and `run-w3.ts` against a written launch checklist.
- **Tripwire:** `grep -n "process.env.W3_\|process.env.LOAD_" scripts/load-harness/w3/run-w3.ts scripts/load-harness/w3/create-fixture.ts` — every required var in that list must appear in the launch metadata before `started=1` is recorded.

### 2026-10-01 — Protected baseline must not treat expired rows as immutable

- **Failure mode:** Protected-baseline evidence in a shared test database counted expired/delivered `live_session_event` rows as immutable, so legitimate production-side expiry/purge (retention) read as a baseline violation.
- **Detection signal:** Baseline comparison fails on protected-event counts even though the protected run's evidence window is over and the rows have exceeded their retention window.
- **Prevention rule:** Protected-baseline evidence in a shared test database must distinguish rows that production is legitimately allowed to expire/purge. Expired delivered-event rows must not be treated as immutable protected baseline.
- **Tripwire:** Baseline assertions over `live_session_event` must exclude delivered rows past the retention window (or compare only against the run-owned scope) instead of asserting immutability over the whole table.

## 2026-10-13 — Bound diagnostic reads and match shell commands as tokens

- Failure mode: an initial task-history read returned excessive output; a mock safety assertion also matched `rm` inside `--format` and rejected allowed inspection commands.
- Detection signal: truncated history output; successful mock doctor rejected by the command-audit assertion.
- Prevention rule: read recent task sections with bounded output; match forbidden command names at token boundaries.
- Tripwire: run the container-free doctor success case alongside negative identity cases; review exact recorded commands if the audit fails.

## 2026-10-13 — Verify Windows ACL application before writing backups

- Failure mode: PowerShell launched from WSL could not auto-load the security module for Set-Acl after creating an empty backup directory.
- Detection signal: CouldNotAutoloadMatchingModule; ACL setup exited nonzero before any backup data was written.
- Prevention rule: use explicit .NET directory ACL APIs where available, verify protected inheritance and SID allowlist, and gate all sensitive writes on success. Repair only the exact empty directory left by the failed setup.
- Tripwire: ACL failure must leave data operations blocked; existing nonempty destinations must never be reused or overwritten.

## 2026-10-13 — Fail closed inside Bash manifest command substitution

- Failure mode: review found that default Bash clears errexit inside command substitution; manifest precondition tests could fail and still return a hash. Upstream hash failures also require pipefail.
- Detection signal: minimal shell repro returned PASS after a failed test; corrected symlink regression exits nonzero before copy/start.
- Prevention rule: use explicit failure exits for manifest preconditions, set pipefail and inherit_errexit, and verify forbidden input in the actual command-substitution context.
- Tripwire: container-free symlink manifest test must fail safely; inspect named-volume ownership after Docker's idempotent volume-create API before use.

## 2026-10-13 — Parse complete psql JSON values, not output lines

- Failure mode: C SQL inventory assumed one physical output line per JSON value; PostgreSQL json_agg(record) emitted a multiline JSON array, blocking after the working copy started successfully.
- Detection signal: Unexpected SQL result shape; lifecycle evidence shows successful SQL exec and intentional stop, no source mutation or backup write.
- Prevention rule: use psql -qAt to suppress status output and parse the joined complete JSON result; do not strip a fixed number of command tags.
- Tripwire: regression fixture must contain a multiline array with both postgres and application databases; continuation validates exact owned IDs, stopped state, mounts and isolation before restarting the intentionally stopped C working copy.

## 2026-10-13 — Stop owned PostgreSQL before offline verification helper

- Failure mode: final preservation helper mounted the owned working/restore volumes while their PostgreSQL servers were still running; the intended running-consumer guard correctly blocked finalization after restore comparisons passed.
- Detection signal: New volume already has a running consumer; finally stopped the exact owned servers successfully.
- Prevention rule: finish SQL comparisons and stop owned servers before offline helpers; never relax the consumer guard to permit concurrent mounts.
- Tripwire: finalization must prove both owned servers stopped before starting the read-only source manifest helper. Keep lifecycle JSON fields escaped using Docker's json formatter.

## 2026-10-13 — Apply bounded-read lesson before combining documents

- Failure mode: combining task-history excerpts, runtime rules, README and lessons exceeded the output budget despite each input being targeted.
- Detection signal: tool returned truncated output during checkpoint entry.
- Prevention rule: read the exact next-scope gate first; budget the total combined output and inspect rule sections selectively.
- Tripwire: avoid combining full rule files with multi-hundred-line history reads; retry only the missing authoritative sections after truncation.


## 2026-10-13 — Apply entry read budgets and record plan before edits

- Failure mode: E entry combined the complete task/lesson history despite the handoff's bounded-read instruction; the preparation checklist was also recorded after initial tooling edits.
- Detection signal: terminal output truncated at 196461 tokens; task plan absent when the first file patch ran.
- Prevention rule: first read the handoff alone, then only its cited ranges; append the scoped checklist before any implementation patch.
- Tripwire: inspect bounded current checkpoint and confirm its unchecked plan exists before the first edit; never cat full tasks/todo.md or lessons.md.

## 2026-10-13 — Bind rollback and post-write verification to observed state

- Failure mode: executor review found helper rollback omitted the retained PG consumer of the same secret volume; post-update TCP originally used memory without verifying written env assignments.
- Detection signal: exact consumer-set analysis rejects the valid retained PG; retained credentials alone cannot prove environment-file routing.
- Prevention rule: allow only both recorded run IDs on their shared volume; validate protected written bytes/hash/assignments before authenticating the fixed target.
- Tripwire: container-free retained-helper/PG consumer regression and written-target mismatch regression; revalidate runtime identity at mutation gates.

## 2026-10-13 — Budget combined checkpoint-entry reads

- Failure mode: G combined complete rule/spec files with history excerpts and exceeded output budget.
- Detection signal: terminal output was truncated.
- Prevention rule: read each authoritative specification separately and select rule ranges by headings.
- Tripwire: total estimated output must fit the tool budget before batching document reads.

### G continuation tripwire refinement

- Detection: combining several bounded excerpts with full rule/code files still truncated output.
- Prevention: read each specification separately; limit history excerpts to the current checkpoint (about 40 lines) and code reads to about 150 lines per result.

## 2026-10-13 — Role separation SQL and simulation boundaries

- Failure modes: psql boolean text is not JSON; comma-separated privilege inquiries prove any privilege rather than all; new full-runtime fixture initially indexed Docker filter arguments incorrectly and reused credential strings as container IDs.
- Detection: code review and failing full RecordedExecutor regression; failures were corrected before extending scope.
- Prevention: return `to_json` from SQL, check every required grant individually, distinguish simulated credentials from IDs, and snapshot journal inputs rather than retaining mutable references.
- Tripwires: strict full-runtime success/privilege-failure sequence; reject elevated app URLs before backup; preserve bounded assertion diagnostics without dumping whole event journals.

## 2026-10-13 — H entry must locate handoff before history reads

- Failure mode: entry read combined full todo/lessons and truncated the output before locating the /tmp handoff.
- Detection signal: 199527-token source output truncated.
- Prevention rule: locate named handoff in workspace and /tmp first; read it alone, then only cited final sections.
- Tripwire: never cat tasks/todo.md or tasks/lessons.md; use bounded tail or heading-specific ranges before checkpoint review.

## 2026-10-13 — Stock image VOLUME applies to secret helpers too

- Failure mode: PG image secret helper received an implicit anonymous PGDATA volume despite overriding entrypoint, so strict expected-mount verification blocked before helper start and guarded rollback stop.
- Detection signal: live exact-ID inspect shows additional /var/lib/postgresql/data mount; helper state created/nonrunning, Mount mismatch.
- Prevention rule: model image-declared VOLUME behavior in container-free runtime fixtures and explicitly review helper mount topology before fresh live authorization; preserve strict mount checks and retained resources.
- Tripwire: secret-helper simulated inspect must include stock image automatic mount behavior unless the reviewed creation command explicitly prevents it; success fixtures cannot silently omit image volumes.

## 2026-10-14 — I bounded entry output budget

- Failure mode: combined rule/history entry reads exceeded the output budget.
- Detection: tool output truncation, despite targeted paths.
- Prevention: read rule and history excerpts separately; budget each returned result.
- Tripwire: avoid full runtime-rule reads alongside task/lesson excerpts.

## 2026-10-14 — J entry output budget enforcement

- Failure mode: batching full runtime rules with proposal/history exceeded combined output budget again.
- Detection: truncated tool result.
- Prevention: each rules/proposal/history read uses its own call and bounded output; never combine complete runtime rules with history.
- Tripwire: read AGENTS.md alone and only current checkpoint history; recover omitted authoritative sections before work.

## 2026-10-14 — L entry bounded-read violation

- Failure mode: initial read included complete todo/lessons despite the handoff's explicit bounded-read requirement.
- Detection signal: 205055-token source output was truncated.
- Prevention rule: read the named handoff alone first; inspect only its cited final sections in separate bounded results.
- Tripwire: no full cat of tasks/todo.md or tasks/lessons.md at checkpoint entry.

## 2026-10-14 — M aggregate output budget

- Failure mode: independent bounded entry reads were combined in one exec and exceeded its aggregate output budget; runtime rules were also larger than their individual cap.
- Detection: aggregate and individual truncation warnings.
- Prevention: use separate exec calls for authoritative documents and heading-selected runtime rule ranges, even when individual shell outputs are bounded.
- Tripwire: inspect result token estimate before batching; recover relevant omitted sections before implementing.

## 2026-10-14 — N entry must enforce handoff read limits
- Failure mode: initial entry combined the handoff with broad task/lesson reads and truncated output despite explicit instructions.
- Detection: aggregate output truncation.
- Prevention: read handoff alone, then exact final checkpoint and final lesson entries with separate bounded calls.
- Tripwire: reject entry commands containing full cat of tasks history or more than one complete authoritative document.

## 2026-10-14 — N bind loaded code and report every recorder failure
- Failure modes: disk-derived approval hashes could describe different code from the imported implementation; inherited guards checked actual mounts but omitted complete configured Binds/Mounts; a transient evidence append failure could recover without setting recordingFailed.
- Detection: independent adapter review and targeted simulated failure checks.
- Prevention: bind loaded source snapshots, compare immutable operation plan at every guard, validate configured and actual mounts, track recording failure independently of later successful writes.
- Tripwires: source/plan/configured-mount drift must stop before mutation; transient initialized-event failure must persist recordingFailed=true in complete evidence.

## 2026-10-14 — O recover bounded entry reads
- Failure mode: initial command combined handoff with early historical task/lesson ranges, violating the handoff read order and truncating output.
- Detection signal: aggregate and per-command truncation warnings.
- Prevention rule: finish a standalone handoff read before constructing any subsequent reads; use only the named checkpoint tail, one authoritative document per call.
- Tripwire: never use first-220-line task/lesson reads for an after-checkpoint handoff; confirm the requested final section is present before proceeding.

## 2026-10-14 — Q aggregate read budget enforcement
- Failure mode: batched individually bounded source/history reads exceeded the aggregate exec output budget; a combined test read also exceeded its per-command cap.
- Detection signal: tool truncation warning.
- Prevention rule: keep authoritative history and test/source excerpts in separate calls with narrower ranges; recover omitted current sections before relying on them.
- Tripwire: total requested output budgets must fit the exec budget, and each source excerpt must fit its own command cap.

## 2026-10-14 — R distinguish evidence policy from evidence existence
- Failure mode: initial new probe inherited retained=true reporting even when authorization/evidence initialization failed before a usable recorder existed.
- Detection signal: focused subagent review identified ambiguous evidence guarantees.
- Prevention rule: report retentionPolicy separately from evidenceStarted/recordingFailed; do not imply successful evidence creation from a no-deletion policy.
- Tripwire: mock begin/initialization failures and incomplete CLI gates; assert evidenceStarted=false and sanitized blocked output.

## 2026-10-14 — R inject callables captured in default parameters
- Failure mode: patching subprocess.run/shutil.which after import does not replace callables already captured by Probe.__init__ defaults, so initial CLI tests did not fully fence accidental runtime calls.
- Detection signal: final test review compared mocked module attributes with constructor default bindings.
- Prevention rule: CLI tests inject the real Probe class with explicit failing runner/lookup callables and a temporary evidence root.
- Tripwire: incomplete CLI gates must leave the temporary root empty; never rely solely on module patches for import-time default callables.

## 2026-10-14 — S entry repeated unbounded history read
- Failure mode: initial entry combined the handoff with a full lessons read and broad todo tail, repeating an existing bounded-read mistake.
- Detection signal: 31825-token output truncated before authoritative review was read.
- Prevention rule: read the named handoff alone before constructing further commands; then read only the exact final checkpoint section and final relevant lesson entries.
- Tripwire: reject checkpoint-entry commands containing cat tasks/lessons.md or a historical todo tail; recover authoritative documents in bounded reads before decisions.


## 2026-10-14 — U checkpoint entry read guard
- Failure mode: combined handoff with complete task/lesson history despite explicit narrow-read order.
- Detection signal: 214192-token source output truncated.
- Prevention rule: first tool read must contain only the named handoff; subsequent reads use named section ranges, one bounded authoritative document at a time.
- Tripwire: reject entry commands containing full cat of tasks/todo.md or tasks/lessons.md before execution.

## 2026-10-14 — W enforce handoff-first reads before execution
- Failure mode: initial entry combined the handoff with broad todo/complete lessons reads; a subsequent broad heading search also truncated output.
- Detection signal: tool truncation warnings despite the handoff's explicit read order.
- Prevention rule: execute a standalone handoff read first, then one named section/document per bounded call; select explicit filenames and line ranges rather than global historical heading matches.
- Tripwire: before submitting the entry command, reject full task/lesson reads and combined handoff/history reads; recover each authoritative section separately before making decisions.

## 2026-10-14 — X reject combined full-history entry commands
- Failure mode: initial command combined handoff and full task/lesson histories despite the explicit read order; output truncated.
- Detection signal: 216577-token source output and truncation warning.
- Prevention rule: read handoff alone before constructing later commands; use one authoritative document or exact named section per result.
- Tripwire: reject any entry command containing full cat of tasks/todo.md or tasks/lessons.md; recover omitted authority before decisions.

## 2026-10-14 — Y strict approval values and verifier mutation
- Failure mode: Python equality accepts 1 as True; an injected verifier may mutate manifest inputs after their initial digest comparison.
- Detection signal: local gate review identified both before final verification.
- Prevention rule: compare approval/bootstrap values canonically, freeze caller inputs, and repeat manifest digest validation after external verification.
- Tripwire: injected tests must reject integer approval values and a verifier that changes closure hashes.

## 2026-10-14 — Y interruption fixture classification
- Failure mode: exception fixture used isinstance(value, Exception), returning KeyboardInterrupt as an invalid result rather than raising it.
- Detection signal: test_outcome_classifications expected UNKNOWN but observed INVALID_RESULT for KeyboardInterrupt.
- Prevention rule: when testing interruption handling, fixture raising logic must recognize BaseException.
- Tripwire: include a KeyboardInterrupt fixture and verify sanitized UNKNOWN plus retained completed evidence.

## 2026-10-14 — AB entry violated explicit bounded-read order
- Failure mode: initial call combined handoff, historical todo tail and complete lessons despite the handoff's one-document entry order.
- Detection signal: tool output truncation; authoritative documents had not yet been read separately.
- Prevention rule: construct the first command using only the supplied handoff path; subsequent history reads must select the exact named section.
- Tripwire: reject any entry command containing a full lessons read or historical todo tail; recover required documents separately before implementation.

## 2026-10-14 — AB fixture reuse must preserve super() ancestry
- Failure mode: assigning BindingTests.setUp to an unrelated TestCase failed because its zero-argument super() requires BindingTests ancestry.
- Detection signal: AB fixture suite failed six setup cases with TypeError before executing assertions.
- Prevention rule: subclass fixtures that use super(); report inherited cases separately from new coverage.
- Tripwire: inspect reused fixture setup for super() before selecting method aliasing versus inheritance; run the focused fixture suite first.

## 2026-10-14 — AD entry command must enforce the supplied handoff boundary
- Failure mode: the initial command read full task/lesson histories despite the supplied handoff's exact entry order.
- Detection signal: 220875-token source output was truncated.
- Prevention rule: construct the first tool command from the handoff path alone; inspect the command before submission for full history reads. Recover authority through exact named sections before deciding scope.
- Tripwire: reject commands containing cat tasks/todo.md or cat tasks/lessons.md; use heading-selected extraction for the current checkpoint only.

## 2026-10-14 — After-AD entry repeated full-history read
- Failure mode: initial tool call combined the handoff with complete todo/lessons reads before applying its entry limits.
- Detection signal: 219976-token history result truncated.
- Prevention rule: submit and inspect the handoff-only result before constructing any further read commands; then use separate exact-heading extraction.
- Tripwire: reject entry commands containing full history cat; recover named authority before scope decisions. Recovery completed through separate bounded reads in this session.

## 2026-10-14 — Runtime checkpoint entry repeated historical read
- Failure mode: initial command combined handoff with complete task/lesson histories, violating the supplied bounded-read order.
- Detection signal: 225840-token source output truncated.
- Prevention rule: first command must read only the named handoff; construct subsequent commands only after reviewing it.
- Tripwire: reject full task/lesson cat in command text before execution; use exact-heading extraction. Recovered required sections separately before any runtime decision.

## 2026-10-14 — Compiled liveness startup includes background data mutations
- Failure mode: recommended test-environment startup scope before completing initialization review; connection and /health/live alone do not describe startup data effects.
- Detection signal: auto-close scheduler immediately runs and publisher processes/cleans durable DB events even with Redis off. No launch occurred.
- Prevention rule: inspect immediate initialization hooks and downstream mutations before describing a launch as connection-only; require data-safe target scope for background updates/deletions.
- Tripwire: targeted onModuleInit/onApplicationBootstrap/timer search plus follow-through to DB writes; Redis off is not evidence that database background jobs are disabled.

## 2026-10-14 — Endpoint rechecks did not close development readiness gap
- Failure mode: repeated blocked runtime socket checks without tracing service lifecycle and distinguishing test smoke scope from the user's development-environment objective.
- Detection signal: user challenged wasted checkpoints; exact metadata and K record show stopped test service and failed dev provisioning before environment publication.
- Prevention rule: after endpoint refusal, use bounded read-only listener/container/config evidence to trace the failed prerequisite; align acceptance to the requested environment and propose a concrete recovery deliverable.
- Tripwire: compare env target host/port/database with container port/state and latest live provisioning result before recommending another runtime-only checkpoint.

## 2026-10-14 — Preserve the user goal across handoff requests
- Failure mode: fulfilled the handoff artifact request without clearly explaining that this paused progress toward the user's compiled runtime verification goal.
- Detection signal: user explicitly requested goal alignment and notification when actions deviate from that goal.
- Prevention rule: carry the ultimate goal across turns; explain when an intermediate request pauses or changes progress, and state the concrete next step and any actual authorization boundary. Do not interpret handoff as cancellation of the goal or as new execution/lifecycle approval.
- Tripwire: before responding to a handoff or checkpoint gate, check the active runtime acceptance criteria and distinguish artifact completion, checkpoint completion and overall goal completion.

## 2026-10-14 — Inspect search results before recording negative provenance
- Failure mode: drafted a no-match provenance result before inspecting the expanded search output, which contained a positive match and a nonexistent path error.
- Detection signal: rg returned scripts/run-w3.ts and exit 2 for missing .github.
- Prevention rule: inspect every search result and exit status before writing conclusions; distinguish partial search errors from clean negatives.
- Tripwire: confirm targeted paths exist and inspect positive matches before final task-record verification.

## 2026-10-14 — Verify mount rejection semantics before declaring a blocker
- Failure mode: described doctor as requiring a pure-volume layout and treated an extra read-only secret bind as unsupported without checking the actual mount predicate.
- Detection signal: tools/dev/env-doctor.sh filters only /var/lib/postgresql/data and never rejects extra mounts.
- Prevention rule: distinguish an unreviewed additional mount from an explicit tool rejection or unsafe configuration; review the predicate before stopping useful bounded evidence collection.
- Tripwire: read the exact destination/type/RW check and inspect only the additional mount role before calling it a launch blocker.

## 2026-10-14 — Retain sanitized lifecycle failure categories on first failure
- Failure mode: initial lifecycle wrapper discarded captured Docker stderr before classification; State.Error was empty, requiring one unchanged startup reproduction to obtain a useful cause.
- Detection signal: start returned nonzero but generic wrapper message and State.Error provided no cause.
- Prevention rule: classify captured diagnostics into a strict safe category before discarding them, never print raw diagnostics or source paths. Preserve actionable evidence on the first failure.
- Tripwire: ensure lifecycle wrappers emit an allowlisted failure category and command exit status before running authorized mutations.

## 2026-10-14 — Distinguish rejected credentials from nonexistent login role
- Failure mode: treated 28P01 as a password-only problem before proving the configured login role exists; also initially assumed a postgres database role exists because the image OS user is postgres.
- Detection signal: local SQL reports both assumed/default and configured app roles absent; recorded initializer identity succeeds and verifies target database ownership.
- Prevention rule: before credential rotation, verify actual cluster/database/role through a recorded existing admin identity. OS user names are not evidence of database role names; 28P01 alone does not establish role existence.
- Tripwire: explicit role-existence/login/CONNECT predicates before any ALTER ROLE, plus sanitized local-role-absent/password-required categories on the first local SQL failure. Never silently replace app credentials with superuser identity.

## 2026-10-14 — Bound planning discovery output before batching
- Failure mode: combined Compose/docs/package/lesson-heading reads exceeded the output budget and were truncated during local DB planning.
- Detection signal: tool output reported truncation; no lifecycle operation occurred.
- Prevention rule: query only relevant service/script keys and targeted lesson sections; avoid batching complete discovery documents.
- Tripwire: estimate aggregate output before execution and keep each discovery result below its token budget.

## 2026-10-15 — Bound latest-state recovery reads
- Failure mode: combined 150-line task tail, lesson tail and intake read exceeded the output budget during next-step discovery.
- Detection signal: tool reported truncated output; latest plan was reread separately before implementation.
- Prevention rule: read latest task headings first, then only the final relevant section; keep lesson/intake reads separate.
- Tripwire: avoid batching historical task tails with other documents; inspect truncation before drawing conclusions.

## 2026-10-15 — Docker inspect optional health field
- Failure mode: direct .State.Health lookup in a composite Docker Go template failed on the retained original container without healthcheck.
- Detection signal: template error map has no entry for key Health; the same container identity/state query succeeded.
- Prevention rule: use index for optional map fields, and verify templates against both healthchecked and non-healthchecked containers before lifecycle mutations.
- Tripwire: no direct .State.Health optional lookup; container-free regression checks the safe optional field access, and real original-container preflight must pass.

## 2026-10-15 — Next-checkpoint entry recovery
- Failure mode: initial command combined handoff with full task/lesson histories, violating the handoff bounded-read instruction.
- Detection signal: tool output truncated.
- Prevention rule: read handoff alone; then extract only its exact named final result section before deciding scope.
- Tripwire: reject entry commands containing full task/lesson cat. Recovered named final authority before any runtime operation.

## 2026-10-15 — Bound recovery-entry searches and single-line JSON reads
- Failure: broad heading search and rg on a one-line build receipt exceeded output budgets.
- Signal: truncated terminal output.
- Prevention/tripwire: search only exact named headings; parse JSON and print selected scalar fields, never matched manifest lines. Use bounded sections for recovery history.

## 2026-10-15 — Empty postgres dump TOCs need not contain DATABASE entries
- Failure: restore precheck required a DATABASE TOC entry even for an empty postgres database archive.
- Signal: fresh backup/hash/ACL passed, pg_restore --list succeeded, executor rejected listing before import.
- Prevention: use successful pg_restore parsing plus custom archive/version header; permit zero application objects. Add empty-archive regression.
- Recovery: retain backup and stopped owned cluster; exact-failure resume skips already-applied globals and revalidates identities/hashes/ACL before restore.

## 2026-10-15 — One-shot init commands cannot restart an initialized cluster
- Failure: restarting the initial restore container reran its empty-directory init precondition and safely exited.
- Signal: resume restore exited before data import; original remains stopped and backups unchanged.
- Prevention: separate initialization lifecycle from server lifecycle; continuation uses a fresh direct-postgres container against the exact owned volume only after proving the original stopped and no running consumers. Never rerun initdb over retained data.

## 2026-10-15 — Published Docker connections may use a forwarding peer
- Failure: isolated restore pg_hba allowed only its dedicated bridge gateway, but Rancher forwarded the localhost client under another private address (SQLSTATE 28000).
- Prevention: independently pin restore identity/loopback publication, inspect only structured error peer, permit only observed RFC1918 IPv4 /32 for the exact restored database/app role, reload only restore HBA and verify the resulting connection identity. Reject public addresses before configuration writes.

## 2026-10-15 — Budget aggregate discovery output before calling tools
- Failure mode: combined heading searches and excerpts exceeded the tool output budget during daily-backup planning.
- Detection signal: truncated output, including a 33717-token combined result.
- Prevention rule: locate only exact cited headings first; read each authoritative section separately with a calculated line budget.
- Tripwire: do not combine full AGENTS, all task headings and implementation symbol searches in one output; limit each result to the specific next decision.

## 2026-10-15 — Backup publication review must cover identity and cleanup
- Failure mode: first draft used an invalid trailing-backslash raw string; review also found absent TOC database mapping, published ACL recheck and interrupted-cleanup kill guarantee.
- Detection: immediate AST parse failed before execution; focused review identified three safety gaps.
- Prevention: syntax-check before live operations, validate archive database headers, recheck published ACLs, and use finally for Popen kill/wait cleanup even if deadline interrupts communicate.
- Tripwire: offline tests include empty/wrong DB TOC, snapshot cleanup interruption, imported snapshot equality and publish/index failure boundaries.

## 2026-10-15 — Exact handoff headings only
- Failure: broad heading query across historical task ledger exceeded output budget.
- Signal: truncated discovery output.
- Prevention/tripwire: query exact named headings or bounded final sections; never enumerate all historical headings during checkpoint entry.

## 2026-10-15 — Native launcher ACL module availability
- Failure: Get-Acl autoload failed because Windows Security type-data entries were duplicated in the local environment.
- Signal: native safe-failure launcher exited before creating control state; explicit Import-Module reported duplicate type members.
- Prevention/tripwire: use the existing Windows .NET ACL API pattern rather than assuming PowerShell Security module autoload; verify native launcher before task registration.

## 2026-10-15 — PowerShell native-state edge cases
- Failure: script-scope foreach $sid overwrote $script:Sid (case-insensitive); passing $null to File.Replace string argument bound as an invalid empty path.
- Signal: ACL identity rejection, then atomic-state replace ArgumentException during safe-failure acceptance.
- Prevention/tripwire: use distinct allowedSid loop variable and [NullString]::Value; exercise real native ACL creation and two consecutive writes before claiming launcher readiness.

## 2026-10-15 — Independent monitoring must survive backup-drive loss
- Failure: initial scheduler state/script design shared D with backups, so drive loss could also remove its notification path.
- Signal: failure-domain review before deployment; fixed C AppData state and native installed script path.
- Prevention/tripwire: place watchdog state/executable outside monitored backup storage and WSL; use a nonexistent backup-root fixture to verify durable notification.
- Additional regression checks: no ACL mutation before reparse checks, guard corrupt prior-state JSON, validate every per-DB snapshot timestamp, and construct both scheduler tasks disabled before final activation.

## 2026-10-15 — Enforce handoff-first tool dependency
- Failure mode: queued full todo/lessons reads before inspecting the handoff; output truncated.
- Detection signal: 260176-token historical output.
- Prevention rule: complete and inspect the handoff-only tool call before constructing any repository-history reads.
- Tripwire: reject commands containing full todo/lessons cat; extract only exact named sections. Recovered bounded authority before any deployment.

## 2026-10-15 — Validate effective task values and export encoding
- Failure mode: parsed UTF-8 export bytes declaring UTF-16, then required XML nodes omitted for default task settings; verbose CIM serialization also exceeded output budget.
- Detection: XML encoding error, absent Enabled node, truncated CIM output. No deployment mutations were retried.
- Prevention/tripwire: decode known PowerShell UTF-8 exports first; normalize declaration in derived evidence; select scalar CIM properties and validate effective defaults alongside XML triggers/actions. Never serialize complete CIM class metadata.

## 2026-10-15 — Second-copy entry bounded-read failure
- Failure mode: initial call combined named handoff with historical todo tail and full lessons; output truncated.
- Detection signal: tool truncation before authoritative context recovery.
- Prevention rule: first call reads the named handoff alone; subsequent reads select exact named sections and bounded outputs.
- Tripwire: reject entry command text containing full lessons reads or historical todo tails before submission. Recovered plan sections 3–6 and latest deployment section separately before any lifecycle action.

## 2026-10-15 — User cancellation supersedes second-copy prerequisite
- Failure mode to prevent: continuing destination intake or requiring a second copy after user cancels it.
- Detection signal: explicit user statement that no second copy is needed and fresh daily runtime is the goal.
- Prevention/tripwire: mark destination/copy tasks superseded before next execution; every preflight must resolve a concrete integrity/isolation/runtime blocker. Warn explicitly if repeated metadata checks do not advance runtime.

## 2026-10-15 — Fresh daily entry full-history mistake
- Failure: entry combined handoff with full task/lesson reads, causing truncation.
- Prevention/tripwire: first inspect handoff alone before composing subsequent calls; forbid full history reads. Recovered exact authority before lifecycle operations.

## 2026-10-15 — Policy-update native verification pitfalls
- Failure: dot-sourced library replaced caller $repo; preflight stopped before mutations. Explicit ExecutionPolicy Default then selected Restricted despite actual installed no-override execution working. JSON evidence also required utf-8-sig and list-aware parsing.
- Signal: baseline path mismatch, SecurityError, BOM/type parser errors.
- Prevention/tripwire: use task-specific caller variable names across dot-source, match actual task invocation exactly for final acceptance, inspect JSON types and decode PowerShell UTF-8 BOM explicitly. Preserve failed probes separately from final evidence.

## 2026-10-15 — Mutation-guard entry bounded-read recovery
- Failure: queued complete history reads before inspecting handoff instructions; output truncated.
- Prevention/tripwire: handoff call must finish before constructing subsequent commands; prohibit full todo/lessons cat. Use named bounded sections.

## 2026-10-15 — Offline guard mock module lifecycle
- Failure: resetModules recreated mocked fs/pg/CLI modules, leaving imported fixture references stale; positive path failed despite valid fixture.
- Detection: rejection cases passed while positive contract load failed.
- Prevention/tripwire: explicitly reuse mock objects via doMock after resetModules; always include a positive mutation-spy path alongside fail-closed cases.

## 2026-10-15 — Isolated-runtime entry bounded-read recurrence
- Failure: constructed full todo/lessons reads before inspecting handoff; output truncated.
- Detection: 268087-token output before any runtime action.
- Prevention/tripwire: submit handoff alone, inspect it, then read AGENTS and exact named sections in a separate call. No full-history cat. Recovered authority before changes.

## 2026-10-15 — Match dotenv populate types in behavioral regressions
- Failure: used config-only quiet option in populate options; ts-jest rejected TS2353.
- Detection: offline suite compile failed before any test or database action.
- Prevention/tripwire: check the specific API option type; mock module instances must survive resetModules. Use actual populate behavior to prove launcher URL precedence.

## 2026-10-15 — Role-runtime entry bounded-read recurrence
- Failure: combined handoff and historical tails before inspecting entry constraints; output truncated.
- Detection: first tool returned truncation.
- Prevention/tripwire: first invocation must contain only the named handoff read; inspect before constructing any history command. Bound migration review output by parsed summary rather than matching every DDL line.

## 2026-10-15 — Runtime sentinel must follow migration schema
- Failure: draft sentinel assumed created_at/updated_at columns absent from system_setting.
- Detection: direct review of authoritative initial migration before live execution.
- Prevention/tripwire: read the exact fixture table DDL before writing raw SQL; use its quoted updatedAt column. Typecheck alone cannot validate SQL strings.

## 2026-10-15 — Detached worker soft-signal cleanup
- Failure: first launcher draft handled timeout but default SIGTERM could bypass finally.
- Detection: independent lifecycle review of detached process group.
- Prevention/tripwire: install controlled SIGTERM/SIGINT unwinding, ignore repeats during cleanup, and keep worker-group cleanup in outer finally; offline regression asserts signal masking. SIGKILL remains an operational limitation.

## 2026-10-15 — Cold recovery entry read ordering
- Failure mode: entry call bundled the named handoff with status/discovery before reading its ordering constraint.
- Detection: handoff requires its own first read, then AGENTS.md.
- Prevention/tripwire: when a user supplies a continuation document, make the first call only that document; construct discovery calls after reading it.

## 2026-10-15 — Recovery DB URL query override
- Failure mode: validating URL authority alone allowed pg connection-string query keys to override the isolated host/port.
- Detection: independent review followed runtime DATABASE_URL into PrismaPg connectionString.
- Prevention/tripwire: recovery inputs accept only postgres/postgresql URLs with no query or fragment; regress query host/port override, scheme and fragment before any app writer can start.

## 2026-10-15 — npm configuration double load
- Failure mode: cold rebuild used /dev/null as both npm userconfig and globalconfig; real npm rejected configuration before dependency installation, despite mocked build tests passing.
- Detection: single authorized live run failed at install; sanitized npm --version with identical configuration paths deterministically reproduced double-loading config.
- Prevention/tripwire: distinct empty private config files for user/global configuration; assert paths differ, files are empty/mode0600, and run a real no-install npm config/version probe before approving a future fresh live run. Preserve failed run and never replay consumed identity.

## 2026-10-15 — External CLI configuration verification gap
- Failure mode: mocked install success and parent-environment npm version pin did not exercise npm parsing the actual isolated environment.
- Detection: real no-install CLI probe reproduced a parser error despite green orchestration tests.
- Prevention/tripwire: share environment constructor with a real side-effect-free CLI regression and production preflight; keep intentional failure assertions. Every external build stage must preserve sanitized status/exit/duration on failure, without relying on raw logs or secret-bearing error messages.

## 2026-10-15 — Actual escrow configuration compatibility gap
- Failure mode: blanket database URL query rejection prevented safe schema=public in actual private .env.test; fixture-only offline validation missed it until after real install/generate/build.
- Detection: consumed02 run stopped at config subprocess; no-connect diagnosis emitted only predicate booleans/query key names and validator line, proving sole public schema query without routing parameters.
- Prevention/tripwire: before future live approval, exercise actual private configuration in memory without connection or raw error/value output. Canonicalize explicitly permitted public schema only before any connection-string consumer; reject unknown/duplicate/routing queries. Capture sanitized config-specific failure receipt instead of only CalledProcessError; no widening live scope or consumed-run replay.

## 2026-10-15 — Continuation entry repeated full-history read
- Failure: initial call combined handoff with complete todo/lessons, truncating output.
- Detection: tool output reported 280334 tokens.
- Prevention/tripwire: first continuation command contains only supplied handoff; defer every other read until it is inspected. Recovered AGENTS and exact latest sections before changes or lifecycle actions.

## 2026-10-15 — Canonical URL changes require target assertions
- Failure: runtime consumer used normalized port55433 while retaining a source-port5432 assertion.
- Detection: positive offline runtime regression failed before app launch.
- Prevention/tripwire: when switching consumers to shared isolatedURL, audit all local source-authority assertions and run schema-query positive paths through runtime and credentials.

## 2026-10-15 — Post-stop bind confuses TIME_WAIT with listeners
- Failure: run03 service-ready and owned shutdown passed, but final strict bind reported ports-not-closed.
- Detection: same-host independent checks showed ECONNREFUSED and kernel TIME_WAIT (no LISTEN) on both ports; isolated container exited and source healthy.
- Prevention/tripwire: retain strict bind for preflight collisions, but post-stop require owned process/container shutdown plus explicitly refused connections. Never accept timeouts or unexpected network errors as closure; never rewrite consumed-run result to PASS.
- Regression: refused/TIME_WAIT accepted, accepting listener rejected, timeout rejected. Sandbox network namespaces can differ; kernel socket diagnosis must use the same execution context as live.

## 2026-10-15 — Cleanup diagnostics must not short-circuit independent checks
- Failure: shared try around both post-stop port probes hid55433 after3001 failure; a cleanup-only failure also left reason null.
- Detection: new lifecycle regression expected both probes but observed only3001; historical run03 result had reason=null.
- Prevention/tripwire: check each endpoint independently, retain sanitized per-endpoint result and explicit cleanup reason. Closed ports must never override a failed owned-container stop. Regression covers first-port failure plus second probe and stop failure with refused ports.

## 2026-10-16 — Temporary TypeScript configuration input scope
- Failure: a tsconfig placed in /tmp with extends/exclude but no include used /tmp as its default input root and scanned unrelated retained workspaces.
- Detection: diagnostic paths referenced /tmp copies rather than repository sources.
- Prevention/tripwire: temporary configs must explicitly include absolute repository inputs and exclude artifacts/node_modules/dist; disable incremental output for read-only checks. Keep the unmodified npm typecheck failure visible separately.
