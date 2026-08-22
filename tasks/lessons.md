# Lessons learned

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

- **Failure mode:** A service publishes a realtime signal synchronously after its transaction commits; the gateway fans out to the room within the same tick — so the socket event can reach the client *before* the test's `nextEvent(listener)` is registered, and the event is lost (test times out).
- **Detection signal:** Server log shows `roomHas=true roomSize=1 sockCount=1` at emit time (socket IS in the room, emit IS targeted correctly), yet the client never receives the event.
- **Root cause:** The listener was registered *after* `await restCall`, but the emit fires during/right after the REST response — the listener attaches too late.
- **Prevention rule:** In realtime e2e, pre-register the event-listener promise (`const p = nextEvent(socket, name)`) *before* performing the mutation that triggers the emit, then `await p` after. Applies to every signal-driven event test (open/submit/close/cancel).

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
- **Root cause:** `Prisma.JsonNull` writes a JSON `null` *value* (not SQL NULL), so the CHECK `IS NULL` branch is false and the array branch evaluates `jsonb_typeof(null::jsonb)`. `Prisma.DbNull` writes an actual SQL NULL, which satisfies `IS NULL`. The two are not interchangeable.
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
- **Prevention rule:** After `prisma generate` in any build pipeline (Docker, CI), normalize the generated client to CJS-safe TS: strip `.ts` extensions from *relative* specifiers and drop the `import.meta.url` shim (CJS has a real `__dirname`). The repo's `scripts/normalize-prisma-client.mjs` does this idempotently. Do NOT rely on the host's stale `generated/` — a fresh clone regenerates the ESM-style output and breaks `node dist/...`. Verify with `node dist/src/main` (note: `nest build` emits `dist/src/main.js`, not `dist/main.js`, because tsconfig `rootDir=src` is preserved under `outDir`).

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
