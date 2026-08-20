# SmartLearning Backend

A NestJS 11 backend service for the 智學互動平台 — a production-oriented baseline
with configuration validation, structured logging (Pino), Prisma/PostgreSQL,
security headers, request ID, error envelope, health probes, and a shared
bootstrap for production and tests.

Design premise: follow the project design documentation for the M2 technical decisions when that documentation is available in the checkout.

## Prerequisites

- Node.js **24+** — the Prisma 7 generated client emits ESM-flavored TS that
  needs Node 24's CJS/ESM interop; older Node fails at runtime (see
  [Prisma 7 generated-client normalization](#prisma-7-generated-client-normalization)).
- npm
- PostgreSQL 14+ (dev: see `docker-postgresql-setup.md`; or use the
  [Docker deployment](#docker-deployment-uat--staging) stack which bundles PG)

## Quick start

```bash
# 1. Configure environment (copy the template, then fill in secrets)
cp .env.example .env.development      # dev loads .env.development (see Configuration below)

# 2. Install dependencies
npm install

# 3. Generate the Prisma client
npm run prisma:generate

# 4. Apply migrations to your database
npm run prisma:migrate:deploy

# 5. Run in dev mode (hot reload)
npm run start:dev
```

The server boots on **port 3000** (configurable via `PORT`). On a successful boot:

```
Application is running on port 3000
```

Health probes (outside the `/api/v1` prefix):

```
curl http://localhost:3000/health/live   # liveness (no DB dependency)
curl http://localhost:3000/health/ready  # readiness (DB SELECT 1)
```

API docs (Swagger UI + OpenAPI JSON):

```
http://localhost:3000/api/docs        # Swagger UI
http://localhost:3000/api/docs-json   # OpenAPI document
```

> Prefer Docker for a full stack (app + Postgres)? Jump to
> [Docker deployment](#docker-deployment-uat--staging).

## Current feature slices

- **B1 identity:** admins can provision `admin`, `teacher`, or `student` accounts. Students use the existing Web Session/password lifecycle but cannot create Courses or author teacher-owned resources; `canCreateCourse` is always false.
- **B2 enrollment:** teacher owners/admins manage persistent CourseEnrollment roster rows (`active`/`removed`), and students can list active courses through `GET /api/v1/me/courses`.
- **B3 HTTP participants:** enrolled students can use their Web Session cookie as an account-bound Participant. Anonymous session-code join plus `X-Participant-Token` remains supported.
- **B4 realtime:** student Socket.IO clients join participant scope only and receive participant-safe snapshots/results; teacher-only counts remain in the teacher room.

The B1–B4 migrations are additive and must be applied before database-backed verification. The isolated test setup refuses databases other than `smartlearning_test`; migration deployment is intentionally separate from code-only checks.

## Configuration

Environment files are selected by `NODE_ENV` and shared between the
application and the Prisma CLI (`prisma.config.ts`):

| `NODE_ENV`    | file loaded                |
| ------------- | -------------------------- |
| `development` | `.env.development`, `.env` |
| `test`        | `.env.test`, `.env`        |
| `production`  | `.env.production`, `.env`  |

Required variables (validated at bootstrap; missing values fail fast):

| Variable        | Default       | Description                                                             |
| --------------- | ------------- | ----------------------------------------------------------------------- |
| `PORT`          | `3000`        | HTTP listen port (1–65535)                                              |
| `NODE_ENV`      | `development` | `development` \| `test` \| `production`                                 |
| `DATABASE_URL`  | —             | PostgreSQL connection string                                            |
| `CORS_ORIGIN`   | —             | Comma-separated origins, or `*` (dev only)                              |
| `COOKIE_SECRET` | —             | Cookie/session signing secret (generate with `openssl rand -base64 32`) |
| `REDIS_URL`     | (optional)    | Redis for rate limit + Socket adapter (Phase 7/9)                       |

Generate secrets: `openssl rand -base64 32`

## Docker deployment (UAT / staging)

The repo ships a multi-stage `Dockerfile` + `docker-compose.yml` that bring up
PostgreSQL, a one-shot Prisma migrate service, and the NestJS API.

```bash
# 1. Configure env (UAT values; .env.production is gitignored)
cp .env.production.example .env.production
#   fill in DB_PASSWORD and COOKIE_SECRET, e.g.:
#   openssl rand -hex 18        # DB_PASSWORD
#   openssl rand -base64 32     # COOKIE_SECRET

# 2. Build + start the stack (DB → migrate → backend)
docker compose up -d --build

# 3. Verify
curl http://localhost:3000/health/live   # {"status":"ok",...}
curl http://localhost:3000/health/ready  # {"status":"ok","checks":{"db":{"healthy":true,...}}}

# Logs / status / teardown
docker compose logs -f backend
docker compose ps
docker compose down          # add -v to also drop the DB volume
```

The compose file interpolates `${DB_*}` / `${PORT}` from `.env.production` for
both the container environment and the YAML itself, so **source it in your
shell before any `docker compose` command**:

```bash
set -a; . ./.env.production; set +a
docker compose up -d --build
```

Layout & ports:

| Service   | Image stage   | Port (host→container)   | Notes                                                                  |
| --------- | ------------- | ----------------------- | ---------------------------------------------------------------------- |
| `db`      | `postgres:16` | `${DB_PORT:-5433}→5432` | Persistent volume `pgdata_smartlearning`; healthcheck via `pg_isready` |
| `migrate` | `migrate`     | —                       | One-shot `prisma migrate deploy`; `backend` waits for it to exit 0     |
| `backend` | `runtime`     | `${PORT:-3000}→3000`    | Healthcheck on `/health/ready`; non-root `nodejs` user; `tini` PID 1   |

The DB publishes on host **5433** by default so it coexists with the dev PG
container (bound to 5432, see `docker-postgresql-setup.md`).

### Prisma 7 generated-client normalization

Prisma 7.9.1's `prisma-client` generator emits ESM-flavored TypeScript
(explicit `.ts` import extensions + an `import.meta.url` `__dirname` shim).
Compiled with `tsc` (`module: commonjs`), the emitted `require("./internal/class.ts")`
preserves the `.ts` suffix but only `.js` files land in `dist/` — Node then
fails with `Cannot find module './internal/class.ts'`.

The builder stage runs `scripts/normalize-prisma-client.mjs` after
`prisma generate` to strip `.ts` extensions from relative specifiers and drop
the `import.meta` shim, so `nest build` → `node dist/src/main` runs on plain
Node (no `tsx` / TS-aware loader needed at runtime). The script is idempotent
and only touches relative (`./`, `../`) specifiers.

> **`start:prod` note**: `package.json` defines `start:prod` as `node dist/main`,
> but `nest build` actually emits `dist/src/main.js` (tsconfig `rootDir=src` is
> preserved under `outDir`). The Docker `CMD` uses `node dist/src/main`. If you
> run `npm run start:prod` directly, use `node dist/src/main` instead.

## Available scripts

| Script                          | Purpose                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run build`                 | Compile via `nest build` → `dist/`                                                                                                                                       |
| `npm run start:dev`             | Dev mode with `--watch`                                                                                                                                                  |
| `npm run start:prod`            | Run compiled output — note `nest build` emits `dist/src/main.js` (tsconfig `rootDir=src` is preserved under `outDir`), so run `node dist/src/main`, not `node dist/main` |
| `npm run typecheck`             | `tsc --noEmit`                                                                                                                                                           |
| `npm run lint`                  | ESLint with auto-fix                                                                                                                                                     |
| `npm run lint:check`            | ESLint, no fix (CI)                                                                                                                                                      |
| `npm run format`                | Prettier write                                                                                                                                                           |
| `npm run format:check`          | Prettier check (CI)                                                                                                                                                      |
| `npm run prisma:generate`       | Generate Prisma client                                                                                                                                                   |
| `npm run prisma:validate`       | Validate schema                                                                                                                                                          |
| `npm run prisma:migrate:deploy` | Apply pending migrations                                                                                                                                                 |
| `npm run prisma:migrate:status` | Show migration status                                                                                                                                                    |
| `npm run prisma:seed`           | Run `prisma/seed.ts` via tsx                                                                                                                                             |
| `npm test`                      | Jest unit tests (`src/**/*.spec.ts`)                                                                                                                                     |
| `npm run test:integration`      | Jest integration tests (DB-backed; `*.integration-spec.ts`)                                                                                                              |
| `npm run test:e2e`              | Jest e2e tests (`*.e2e-spec.ts`)                                                                                                                                         |
| `npm run test:cov`              | Coverage report                                                                                                                                                          |

## Project layout

```
src/
  main.ts                      # Bootstrap: logger + configureApplication
  app.module.ts                # Root module: ConfigModule + Logger + Prisma + Health
  bootstrap/configure-app.ts   # Shared app setup (prefix, versioning, pipes, filters, helmet, CORS)
  config/                      # env validation + typed configuration
  common/
    errors/                     # domain errors + stable error codes + envelope
    http/                       # global exception filter + request ID middleware
    observability/              # Pino redaction paths
    clock/                      # Clock abstraction (System/Fake)
    crypto/                     # token hash, constant-time compare, UUID v7
    security/                   # cookie options, CSRF/Origin helpers (skeleton)
    pagination/                 # pagination types/helpers
  prisma/                       # PrismaService + TransactionService (lock/error helpers)
  modules/
    health/                     # /health/live + /health/ready
    identity/                   # Web accounts, sessions, admin lifecycle
    courses/                    # Course ownership and lifecycle
    enrollments/                # CourseEnrollment roster and /me/courses
    participants/               # Anonymous and account-bound live identities
    submissions/                # Idempotent answer writes
    realtime/                   # /live Socket.IO notification gateway
prisma/
  schema.prisma                 # Current identity, course, live, enrollment, and submission models
  migrations/                   # additive migrations (hand-written CHECK/raw SQL allowed)
  seed.ts                       # seed script
test/
  setup/                        # app-factory.ts (reuses production bootstrap) + db.ts
  *.e2e-spec.ts                 # e2e tests
  *.integration-spec.ts         # DB integration tests
generated/                      # Prisma client output (gitignored)
```

## Verification

```bash
npm ci                         # restore full deps (incl. ts-jest, eslint, @nestjs/testing)
npm run prisma:generate
npm run prisma:validate
npm run typecheck
npm run lint:check
npm run format:check
npm run build
npm test                       # unit
npm run test:e2e               # e2e (health probes)
npm run test:integration       # DB-backed (skips when DB unreachable)
npm run prisma:migrate:status
```

Docker end-to-end (app + DB):

```bash
set -a; . ./.env.production; set +a
docker compose up -d --build
curl http://localhost:3000/health/ready   # expect {"status":"ok","checks":{"db":{"healthy":true,...}}}
```

Integration tests require a migrated test database:

```bash
NODE_ENV=test npm run prisma:migrate:deploy   # applies to smartlearning_test
npm run test:integration
```

## Architecture notes

- **Shared bootstrap**: `configureApplication(app)` is used by both `main.ts`
  and the e2e app factory, so production and tests configure identically.
- **Error envelope**: all errors return `{ error: { code, message, field?, blocking, nextStep? } }`
  via `GlobalExceptionFilter`; domain code throws `DomainError` subclasses, never
  shapes HTTP itself.
- **Identity**: UUID v7 (app-generated) per `M2 關鍵技術決策 §1`.
- **State columns**: `TEXT + CHECK` via hand-written migration SQL.
- **Locks**: `TransactionService` provides `FOR UPDATE` and advisory-lock helpers
  (consumed in Phase 3/6; submit/close linearization).
- Database-backed integration/e2e verification is intentionally separate from code changes: apply additive migrations to the isolated test database only when authorized, then run the targeted Phase B suites.
