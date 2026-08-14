---
name: init-nest-project
description: Initialize or normalize a NestJS backend project with a production-oriented project baseline, including configuration, validation, structured logging, environment handling, project structure, and verification. Use when starting a new NestJS backend project or preparing an existing NestJS skeleton before implementing business features.
---

# init-nest-project

Initialize a NestJS backend project and establish a clean, production-oriented backend foundation.

This skill is responsible for **project initialization and infrastructure baseline only**.

Do not implement domain-specific features such as:

- users
- authentication
- products
- orders
- checkout
- payment
- WebSocket business events

unless explicitly requested by the user.

The expected result is a NestJS project that is ready for subsequent feature development.

---

# Goals

Establish the following baseline:

1. Valid NestJS project structure
2. Environment-based configuration
3. Global request validation
4. Structured application logging
5. Safe environment-variable handling
6. Predictable startup configuration
7. Clean TypeScript configuration
8. Basic test/build/lint verification
9. Clear separation between infrastructure and business modules

The project should remain minimal.

Do not introduce infrastructure that is not currently required.

---

# When to Use

Use this skill when the user asks to:

- initialize a NestJS backend
- create a NestJS backend project
- prepare a NestJS project baseline
- set up a NestJS backend
- bootstrap a NestJS service
- normalize an existing NestJS starter project
- prepare a backend before adding feature modules
- create the initial backend architecture

Examples:

```text
Initialize the NestJS backend.
```

```text
Set up the backend project before implementing user registration.
```

```text
Create a production-ready NestJS project baseline.
```

```text
Prepare this repository for NestJS backend development.
```

---

# Scope

This skill may configure:

```text
NestJS
├── application bootstrap
├── AppModule
├── ConfigModule
├── ValidationPipe
├── structured logging
├── environment variables
├── TypeScript configuration
├── package scripts
├── linting
├── formatting
└── baseline testing
```

This skill must normally stop before:

```text
Domain Features
├── UsersModule
├── AuthModule
├── ProductsModule
├── OrdersModule
├── CheckoutModule
├── PaymentModule
└── domain-specific WebSocket gateways
```

Those belong to separate feature implementation skills.

---

# Operating Principles

Follow these principles throughout the task.

## 1. Inspect Before Modifying

Never assume the repository is empty.

Before making changes, inspect:

```text
package.json
nest-cli.json
tsconfig.json
tsconfig.build.json
src/
test/
.env*
.gitignore
README.md
```

Also inspect the package manager lock file when present:

```text
pnpm-lock.yaml
package-lock.json
yarn.lock
bun.lock
bun.lockb
```

Determine whether the project is:

```text
A. Empty repository
B. Existing NestJS skeleton
C. Existing NestJS application
D. Non-NestJS project
```

Do not overwrite existing application behavior without evidence that it is necessary.

---

## 2. Detect the Existing Package Manager

Prefer the package manager already used by the repository.

Detection order:

```text
pnpm-lock.yaml
→ pnpm

yarn.lock
→ yarn

package-lock.json
→ npm

bun.lock / bun.lockb
→ bun
```

If no lock file exists, inspect:

```json
"packageManager"
```

inside `package.json`.

Do not switch package managers unless explicitly requested.

---

## 3. Preserve Existing Versions

If NestJS is already installed, preserve the current major versions unless:

- the user explicitly requests an upgrade
- the current versions are incompatible with the required setup
- the repository cannot build without updating them

Do not perform unrelated dependency upgrades.

Avoid commands such as:

```bash
npm update
pnpm update --latest
```

unless explicitly required.

---

# Workflow

Execute the workflow in the following order.

---

# Phase 1 — Repository Assessment

Inspect the current repository before making changes.

Identify:

- repository root
- current framework
- NestJS version
- Node.js expectations
- package manager
- existing modules
- current bootstrap logic
- existing configuration approach
- existing logging
- existing validation
- environment files
- existing tests
- build/lint/test commands

Produce an internal assessment equivalent to:

```text
Project type:
Package manager:
NestJS version:
Existing AppModule:
Existing main.ts:
Config present:
Validation present:
Logging present:
Tests present:
Risk of destructive changes:
```

Do not create duplicate infrastructure.

---

# Phase 2 — Initialize NestJS When Necessary

If the repository does not yet contain a NestJS project, initialize one using the detected package manager.

Prefer Nest CLI or the standard NestJS project structure.

Expected baseline:

```text
project/
├── src/
│   ├── app.module.ts
│   └── main.ts
├── test/
├── package.json
├── nest-cli.json
├── tsconfig.json
├── tsconfig.build.json
├── .gitignore
└── README.md
```

Remove generated demo files when they have no purpose, for example:

```text
app.controller.ts
app.controller.spec.ts
app.service.ts
```

but only if nothing depends on them.

The baseline AppModule may intentionally contain no controllers or providers.

Example target:

```typescript
import { Module } from '@nestjs/common';

@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class AppModule {}
```

Do not delete useful existing functionality simply to match this example.

---

# Phase 3 — Environment Configuration

Use NestJS configuration support.

Preferred dependency:

```text
@nestjs/config
```

Configure `ConfigModule`.

For a simple backend:

```typescript
ConfigModule.forRoot({
  isGlobal: true,
})
```

is preferred unless the existing architecture deliberately uses module-local configuration.

Environment-specific values must not be hard-coded into application code.

Typical environment values include:

```text
PORT
NODE_ENV
DATABASE_URL
JWT_SECRET
JWT_EXPIRATION
STRIPE_SECRET_KEY
```

However:

**Only define variables actually needed by the current project.**

For initialization, usually only:

```env
PORT=3000
NODE_ENV=development
```

is necessary.

---

# Phase 4 — Environment File Safety

Never commit production secrets.

Ensure `.gitignore` excludes:

```text
.env
.env.local
.env.development.local
.env.test.local
.env.production.local
```

Prefer committing:

```text
.env.example
```

instead.

Example:

```env
PORT=3000
NODE_ENV=development
```

Rules:

- `.env.example` contains variable names and safe example values
- `.env.example` must not contain credentials
- `.env` must not contain real production secrets in Git
- never invent real API keys or passwords

If an existing tracked `.env` contains secrets:

1. Do not expose the secret in the response.
2. Report the security risk.
3. Recommend rotating the secret.
4. Ensure future secrets are ignored.
5. Do not rewrite Git history unless explicitly requested.

---

# Phase 5 — Global Validation

Install and configure:

```text
class-validator
class-transformer
```

when not already present.

Configure a global `ValidationPipe`.

Preferred baseline:

```typescript
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
  }),
);
```

Purpose:

```text
whitelist
→ remove properties not declared by DTO validation rules

transform
→ transform incoming values to declared DTO types where supported
```

Do not use:

```typescript
forbidNonWhitelisted: true
```

by default unless the repository or user requires strict rejection behavior.

DTO validation itself belongs to feature implementation.

---

# Phase 6 — Structured Logging

Prefer structured logging over scattered `console.log()` calls.

If the repository already has a logging solution, preserve it.

Otherwise prefer:

```text
nestjs-pino
pino-http
```

and optionally:

```text
pino-pretty
```

for development output.

Recommended behavior:

```text
development
→ readable pretty logs
→ debug level

production
→ structured JSON logs
→ info level
```

Example architecture:

```text
ConfigModule
     │
     ▼
LoggerModule
     │
     ├── development → pino-pretty
     └── production  → JSON
```

The bootstrap should use the application logger instead of raw console logging.

Example:

```typescript
const app = await NestFactory.create(AppModule);

app.useLogger(app.get(Logger));
```

Do not add multiple competing logging frameworks.

---

# Phase 7 — Application Bootstrap

Keep `src/main.ts` small and focused on application-wide infrastructure.

Recommended responsibilities:

```text
bootstrap()
├── create Nest application
├── configure logger
├── configure global validation
├── configure global middleware if required
├── read PORT from configuration
└── start server
```

Example structure:

```typescript
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useLogger(app.get(Logger));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);

  await app.listen(port);
}

bootstrap();
```

Adapt this example to the existing project instead of copying it blindly.

---

# Phase 8 — AppModule Composition

Keep infrastructure registration centralized and readable.

A baseline may look conceptually like:

```text
AppModule
├── ConfigModule
└── LoggerModule
```

Feature modules should later be added separately:

```text
AppModule
├── ConfigModule
├── LoggerModule
│
├── UsersModule
├── AuthModule
├── ProductsModule
└── ...
```

Do not implement those feature modules during initialization unless explicitly requested.

---

# Phase 9 — TypeScript Configuration

Inspect existing TypeScript settings before changing them.

Preserve working project configuration.

Only modify TypeScript options when required for the application.

Do not casually enable strict settings across an existing codebase if that creates unrelated compilation failures.

For new projects, prefer sensible modern TypeScript defaults compatible with the installed NestJS version.

Avoid unnecessary path aliases during initial setup.

Keep imports straightforward unless the repository already defines an alias strategy.

---

# Phase 10 — Package Scripts

Ensure the project provides useful commands equivalent to:

```json
{
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "start:debug": "nest start --debug --watch",
    "start:prod": "node dist/main",
    "lint": "...",
    "test": "jest",
    "test:watch": "jest --watch",
    "test:cov": "jest --coverage",
    "test:e2e": "jest --config ./test/jest-e2e.json"
  }
}
```

Preserve existing working commands.

Do not rename scripts unnecessarily.

---

# Phase 11 — Project Structure

Do not create speculative directories.

At initialization time, a minimal structure is preferred:

```text
src/
├── app.module.ts
└── main.ts
```

Infrastructure directories may be added when needed:

```text
src/
├── config/
├── common/
└── health/
```

but only when they have actual content and purpose.

Avoid empty architecture scaffolding such as:

```text
controllers/
services/
repositories/
entities/
interfaces/
utils/
helpers/
```

unless the project genuinely uses that architecture.

NestJS should normally be organized by feature rather than by technical layer.

Preferred future structure:

```text
src/
├── users/
│   ├── dto/
│   ├── users.controller.ts
│   ├── users.service.ts
│   └── users.module.ts
│
├── auth/
│   ├── guards/
│   ├── strategies/
│   ├── auth.controller.ts
│   ├── auth.service.ts
│   └── auth.module.ts
│
└── products/
    ├── dto/
    ├── products.controller.ts
    ├── products.service.ts
    └── products.module.ts
```

Do not create these modules until their features are requested.

---

# Phase 12 — Dependency Discipline

Every new dependency must have a concrete reason.

For baseline initialization, acceptable additions may include:

```text
@nestjs/config
class-validator
class-transformer
nestjs-pino
pino-http
pino-pretty
```

Do not automatically install:

```text
Prisma
TypeORM
Passport
JWT
bcrypt
Socket.IO
Stripe
Redis
BullMQ
Swagger
GraphQL
Kafka
RabbitMQ
```

unless those capabilities are explicitly required.

Initialization must not become architecture speculation.

---

# Phase 13 — Verification

After modifications, verify the project.

Run the narrowest relevant checks first.

Recommended sequence:

```text
1. install dependencies if needed
2. format check / formatting
3. TypeScript build
4. lint
5. unit tests
6. e2e tests if already configured and practical
```

Typical commands:

```bash
pnpm build
pnpm lint
pnpm test
```

or the repository-equivalent commands.

Do not assume commands succeeded.

Inspect actual exit status and relevant output.

If a command fails:

1. identify whether the failure was introduced by the current changes
2. fix current-change failures
3. do not silently fix unrelated legacy issues
4. report unrelated pre-existing failures separately

---

# Phase 14 — Diff Review

Before completing the task, inspect the final diff.

Check for:

- accidental secret exposure
- unrelated dependency upgrades
- lock-file churn
- deleted business functionality
- duplicate configuration
- unused dependencies
- unused imports
- commented-out code
- debug statements
- generated files that should not be committed

The final diff should contain only changes required for the initialization task.

---

# Security Guardrails

Always enforce the following.

## Secrets

Never:

```text
commit real secrets
print secrets in summaries
invent production secrets
disable .env ignore rules
```

Prefer:

```text
.env.example
environment injection
secret manager in deployed environments
```

---

## CORS

Do not automatically configure:

```typescript
origin: '*'
```

for production applications.

Only configure CORS when required.

If CORS is needed, prefer environment-configurable allowed origins.

---

## Validation

External input should eventually pass through DTO validation.

Do not trust arbitrary request bodies.

---

## Error Handling

Do not expose stack traces, database credentials, or internal configuration through HTTP responses.

Use NestJS exceptions and existing application error conventions.

---

# Do Not

Do not:

- implement business features during initialization
- create speculative architecture
- replace a working package manager
- mass-upgrade dependencies
- commit `.env` secrets
- disable lint or tests to make verification pass
- use `any` to suppress TypeScript problems without justification
- add repositories/services/controllers that have no immediate use
- introduce Docker, Kubernetes, Redis, Kafka, Swagger, ORM, or authentication unless requested
- rewrite unrelated files
- run broad destructive commands without need

---

# Expected Deliverables

At completion, the repository should contain or preserve an equivalent baseline:

```text
.
├── src/
│   ├── app.module.ts
│   └── main.ts
│
├── test/
├── .env.example
├── .gitignore
├── nest-cli.json
├── package.json
├── tsconfig.json
└── tsconfig.build.json
```

Depending on the existing repository, the exact files may differ.

---

# Completion Criteria

The task is complete when all applicable conditions are true:

- [ ] NestJS application can build successfully
- [ ] application can start using configured PORT
- [ ] environment configuration is available
- [ ] `.env` secrets are excluded from Git
- [ ] `.env.example` documents required baseline variables
- [ ] global validation is configured
- [ ] structured logging is configured or an existing logger is preserved
- [ ] no business-specific feature was added without request
- [ ] no unnecessary dependency was added
- [ ] no unrelated application behavior was changed
- [ ] lint/build/tests were executed where available
- [ ] final diff was reviewed

---

# Final Response Format

After execution, report the result concisely.

Use this structure:

```markdown
## Initialized

- NestJS project baseline established
- Environment configuration added
- Global validation enabled
- Structured logging configured

## Files Changed

- `src/main.ts`
- `src/app.module.ts`
- `.env.example`
- `.gitignore`
- `package.json`

## Dependencies Added

- `@nestjs/config`
- `class-validator`
- `class-transformer`
- `nestjs-pino`
- `pino-http`
- `pino-pretty`

## Verification

- Build: PASS
- Lint: PASS
- Tests: PASS

## Notes

- Business modules were intentionally not created.
- The project is ready for the next feature implementation.
```

Only list files, dependencies, and verification results that actually apply.

Never claim a check passed unless it was executed successfully.

---

# Example Target State

A newly initialized backend may conceptually look like:

```text
Client
  │
  ▼
NestJS
  │
  ├── Global Validation
  ├── Structured Logging
  ├── Environment Config
  │
  ▼
AppModule
  │
  └── Future Feature Modules
```

The purpose of this skill is to establish this foundation.

Feature-specific skills should build on top of it.

---

# Guiding Rule

Prefer:

> the smallest clean backend foundation that makes the next feature easy to implement

over:

> predicting every technology the application may eventually need.
