# SmartLearning Backend

A NestJS 11 backend service for the 智學互動平台 — a production-oriented baseline
with configuration validation, structured logging (Pino), Prisma/PostgreSQL,
security headers, request ID, error envelope, health probes, and a shared
bootstrap for production and tests.

Design premise: see `docs/智學互動平台/30_系統設計/M2 關鍵技術決策.md`.

## Prerequisites

- Node.js (see `@types/node` major version)
- npm
- PostgreSQL 14+ (dev: see `docker-postgresql-setup.md`)

## Quick start

```bash
# 1. Configure environment (copy the template, then fill in secrets)
cp .env.example .env      # or use .env.<NODE_ENV> (see Configuration below)

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

## Configuration

Environment files are selected by `NODE_ENV` and shared between the
application and the Prisma CLI (`prisma.config.ts`):

| `NODE_ENV`     | file loaded                  |
|----------------|------------------------------|
| `development`  | `.env.development`, `.env`    |
| `test`         | `.env.test`, `.env`          |
| `production`   | `.env.production`, `.env`    |

Required variables (validated at bootstrap; missing values fail fast):

| Variable        | Default       | Description |
|-----------------|---------------|-------------|
| `PORT`          | `3000`        | HTTP listen port (1–65535) |
| `NODE_ENV`      | `development` | `development` \| `test` \| `production` |
| `DATABASE_URL`  | —             | PostgreSQL connection string |
| `CORS_ORIGIN`   | —             | Comma-separated origins, or `*` (dev only) |
| `COOKIE_SECRET` | —             | Cookie/session signing secret (generate with `openssl rand -base64 32`) |
| `REDIS_URL`     | (optional)    | Redis for rate limit + Socket adapter (Phase 7/9) |

Generate secrets: `openssl rand -base64 32`

## Available scripts

| Script | Purpose |
|---|---|
| `npm run build` | Compile via `nest build` → `dist/` |
| `npm run start:dev` | Dev mode with `--watch` |
| `npm run start:prod` | Run compiled output (`node dist/main`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint with auto-fix |
| `npm run lint:check` | ESLint, no fix (CI) |
| `npm run format` | Prettier write |
| `npm run format:check` | Prettier check (CI) |
| `npm run prisma:generate` | Generate Prisma client |
| `npm run prisma:validate` | Validate schema |
| `npm run prisma:migrate:deploy` | Apply pending migrations |
| `npm run prisma:migrate:status` | Show migration status |
| `npm run prisma:seed` | Run `prisma/seed.ts` via tsx |
| `npm test` | Jest unit tests (`src/**/*.spec.ts`) |
| `npm run test:integration` | Jest integration tests (DB-backed; `*.integration-spec.ts`) |
| `npm run test:e2e` | Jest e2e tests (`*.e2e-spec.ts`) |
| `npm run test:cov` | Coverage report |

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
prisma/
  schema.prisma                 # Prisma schema (Phase 1: SystemSetting only)
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
npm ci
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

Integration tests require a migrated test database:

```bash
NODE_ENV=test npm run prisma:migrate:deploy   # applies to smartlearning_test
npm run test:integration
```

## Architecture notes (Phase 1 baseline)

- **Shared bootstrap**: `configureApplication(app)` is used by both `main.ts`
  and the e2e app factory, so production and tests configure identically.
- **Error envelope**: all errors return `{ error: { code, message, field?, blocking, nextStep? } }`
  via `GlobalExceptionFilter`; domain code throws `DomainError` subclasses, never
  shapes HTTP itself.
- **Identity**: UUID v7 (app-generated) per `M2 關鍵技術決策 §1`.
- **State columns**: `TEXT + CHECK` via hand-written migration SQL.
- **Locks**: `TransactionService` provides `FOR UPDATE` and advisory-lock helpers
  (consumed in Phase 3/6; submit/close linearization).
- Phase 2+ feature modules (identity/auth/courses/…) are not yet implemented.