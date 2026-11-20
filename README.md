# smartLearning-backend

Private NestJS 11 / TypeScript backend for the SmartLearning platform. PostgreSQL access is via Prisma 7 with the `@prisma/adapter-pg` driver adapter; the API contract is exposed as an OpenAPI document at `/openapi.json`.

This document records how the backend was hardened to fail fast when PostgreSQL is unavailable, and how to operate the same checks. It does not contain any database connection strings, hostnames of secret-bearing services, usernames, passwords, or tokens.

## Fail-fast database startup

### Problem

Running `NODE_ENV=development npm run start:dev` while the PostgreSQL container was stopped printed module-initialization and route-mapping logs, and the process appeared to have started successfully. In reality the startup probe was hanging, the server was never listening, and the process could not serve any request.

Two root causes were found:

1. Merely calling Prisma client `$connect()` did not prove that a real PostgreSQL connection could be established. The installed `@prisma/adapter-pg` (7.10.1) initializes a lazy connection pool, so the startup path needs an actual query to prove database reachability.
2. When an endpoint silently accepts TCP but never completes the PostgreSQL handshake (a behavior a stopped container can exhibit), the `pg` connection pool waits forever by default. A probe that waits forever is indistinguishable from a successful start from the operator's point of view — the process simply never reports either success or failure.

Also note: Nest 11 emits route-mapping logs *before* it awaits module `onModuleInit()` hooks. Visible route lines therefore do not prove that the application has started listening, and they also do not prove that those hooks have succeeded yet.

### Fix

`src/database/prisma.service.ts` now performs, in order:

1. `await client.$connect()`
2. `await client.$queryRaw`SELECT 1`` — a real query that forces the pool to check out an actual connection.

Either step failing aborts module initialization with a sanitized error:

```text
Database connection failed during startup. Check database availability and DATABASE_URL configuration.
```

The original connection string and credentials are never included in the error message. On failure the service attempts `$disconnect()` and ignores secondary cleanup errors so they cannot hide the startup failure.

A bounded connection timeout is also applied when the `pg` adapter is created, so an unresponsive endpoint cannot hang the startup probe indefinitely:

```ts
export const DATABASE_CONNECTION_TIMEOUT_MS = 5000;

export function createPgAdapterFactory(connectionString: string): PrismaPg {
  return new PrismaPg({
    connectionString,
    connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MS,
  });
}
```

### Verification performed

Reproduction without touching any real or shared database:

1. Point `DATABASE_URL` at a loopback port that has no listener, then run the built `dist/src/main.js`.
   - Before the fix: process did not exit on its own (observed only via an external 60-second timeout, no error logged).
   - After the fix: process exits non-zero within seconds and logs only the sanitized failure message above. The `Nest application successfully started` line is absent.
2. Focused unit tests plus quality checks all pass:
   - `npm test -- --runInBand src/database/prisma.service.spec.ts` (6 tests)
   - `npm run typecheck`
   - `npm run lint:check`
   - `npx prettier --check <changed files>`
   - `npm run build`
   - `git diff --check`

These commits landed on `main`:

- `fix(auth): move password reset token to URL fragment` (one-time reset tokens no longer travel in HTTP request URLs or referrers)
- `fix(db): fail startup promptly when PostgreSQL is unreachable`

## Operator guide

### Common commands

```bash
npm run build
npm run typecheck
npm run lint:check          # read-only; do not use "npm run lint" to verify
npm run format:check
npm test                    # unit tests (src/**/*.spec.ts)
npm test -- --runInBand src/database/prisma.service.spec.ts
npm run start:dev           # nest start --watch
```

### Environment selection

`ConfigModule` uses `.env.${NODE_ENV}` when `NODE_ENV` is set, otherwise `.env` (see `src/app.module.ts`). Variables already present in the shell environment take precedence over the env file, so an inherited `DATABASE_URL` silently overrides the file-based configuration. `NODE_ENV=development npm run start:dev` therefore does not by itself guarantee which database endpoint will be contacted.

### Expected behavior when the database is down

With the configured database endpoint unreachable, startup now exits non-zero within seconds and prints only the sanitized diagnostic above. No success log and no listening port should be observed. To confirm, run a read-only check against the configured API port (for example with `curl -sS`) only after the process reports an explicit success; absence of a response is expected when the database is down.

Do not enable any behavior that would let the app start in a degraded mode while the database is unavailable; readiness must reflect actual database availability.

## Related contract changes

- Reset links now place the one-time token in a URL fragment (`#token=...`), never in the query string. `PASSWORD_RESET_URL` must be a clean HTTP(S) page URL with no query, fragment, or credentials. Consumers that relied on `?token=...` links are not supported; a new reset request is required.
- See `docs/openapi.md` for the maintained OpenAPI workflow and the auth module contract.
