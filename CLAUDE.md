# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this repository.

## Project snapshot

- Private NestJS 11 / TypeScript backend using the Express platform adapter. `nest-cli.json` sets `src` as the source root and enables the `@nestjs/swagger` compiler plugin with class-validator and comment introspection.
- PostgreSQL data access is defined with Prisma 7. `prisma/schema.prisma` maps the application schema (`app`); versioned SQL migrations live under `prisma/migrations/`.
- Development and test PostgreSQL environments have separate Compose files (`compose.dev-db.yml`, `compose.test-db.yml`) and separate npm script prefixes (`db:dev:*`, `db:test:*`).
- This checkout currently has no `src/` application source, no checked-in test files in `test/`, and no root README. The NestJS app entry point is configured as `src`; do not infer runtime endpoints or behavior from the package scripts or schema alone.
- Operational material is organized under `ops/` by task (for example observability, topology, staging replica, and MinIO rehearsal).

## Common commands

Run from the repository root. These are declared in `package.json`:

```bash
npm run build
npm run start:dev
npm run start:debug
npm run start:prod
npm run lint:check
npm run format:check
npm run typecheck
npm test
npm test -- --runInBand path/to/example.spec.ts
npm run test:e2e
npm run test:integration
```

`npm run lint` and `npm run format` modify files; prefer their `:check` variants for read-only verification. The single-test command is the Jest pattern; use it only when the target test file exists.

Prisma development commands are explicitly scoped to `.env.development` and the `app` schema:

```bash
npm run prisma:dev:validate
npm run prisma:dev:generate
npm run prisma:dev:status
```

`npm run prisma:dev:deploy` changes database schema. Do not run it without explicit authorization and the required environment/database identity checks. Database service lifecycle scripts (`db:dev:up`, `db:test:up`, `db:*:down`) affect containers and must follow `.claude/rules/docker-wsl-agent-rules.md` and repository authorization rules before use. Check a command's call chain before running tests or scripts that may touch a database; do not assume they are offline.

## Architecture and contract sources

- When application source is present, NestJS modules/controllers/services and DTOs belong under the configured `src/` root. Swagger is the API contract surface: use `@nestjs/swagger` decorators and keep the generated frontend client in `packages/api-client` aligned with the exported Swagger document.
- Use the authoritative domain vocabulary at `/home/user/projects/smartLearning/docs/智學互動平台/20_系統分析/GLOSSARY.md` for API, DTO, and documentation names. Keep Swagger examples and responses consistent with the actual contract.
- Prisma schema and migrations are related but distinct sources: schema describes models/enums and `app` namespace mapping; migration SQL records the versioned database changes. Review both before proposing schema changes. The schema contains idempotency and version-related fields, but fields alone do not prove that application-level replay or optimistic-lock behavior exists.
- `compose.dev-db.yml` and `compose.test-db.yml` define distinct DB environments. Confirm the intended target from config and current identity before any database operation; do not treat test/dev resources as interchangeable.

## Repository-specific instructions

- Follow `AGENTS.md` for authorization boundaries, database/migration precautions, task checkpoints, delegation, and evidence requirements.
- Follow `.claude/rules/backend-development-rules.md` for GLOSSARY naming, Swagger/client contract alignment, generic external errors where needed, idempotent side effects, bounded pagination, and version-checked updates.
- Follow `.claude/rules/docker-wsl-agent-rules.md` for Docker, Compose, database, migration, container, image, volume, and network operations. It requires read-only preflight and explicit approval for the listed mutating/high-risk actions.
- Do not claim a feature or test exists based solely on package scripts, generated artifacts, schema fields, or configuration. Verify the maintained source and test path first.
