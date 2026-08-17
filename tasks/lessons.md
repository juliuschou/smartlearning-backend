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
