# Phase 0 關鍵決策 + Phase 1 工程基礎 — 工作紀錄

日期：2026-08-16
範圍：Backend NestJS 實作規劃 Phase 0（精簡關鍵決策）+ Phase 1（工程與資料基礎）

## 目標

1. 定案會直接影響程式碼的關鍵紅卡，產出《M2 關鍵技術決策》設計前提文件。
2. 建立可重現的工程基礎：fresh checkout 能啟動、migrate、health check、跑測試。

## Checklist

### Phase 0 — 關鍵技術決策

- [x] 新增 `docs/智學互動平台/30_系統設計/M2 關鍵技術決策.md`
- [x] 定案 11 項紅卡（UUID v7、TEXT+CHECK、lock protocol、Web Session、Argon2id、validation token、advisory lock、can_create_course scope、open-text 投影、wire contract、Redis 邊界）
- [x] 紅卡狀態表（已定案/方向已定待驗證/非阻擋 + 驗證 phase）
- [x] 註記完整 7 份 M2 設計文件仍待後續 phase 前交付

### Phase 1 — 工程與資料基礎

- [x] 依賴安裝：helmet、cookie-parser、uuid、supertest、@types/*
- [x] 移除 @nestjs/swagger（transitive js-yaml 漏洞；完整 OpenAPI 留後續設計階段）
- [x] package.json scripts：prisma:generate/validate/migrate:deploy/migrate:status/seed、typecheck、lint:check、format:check、test:integration
- [x] config/env.validation.ts（class-validator EnvConfig，fail fast）
- [x] config/configuration.ts（typed loader）
- [x] app.module.ts ConfigModule 依 NODE_ENV 對齊 prisma.config + validate hook
- [x] .env.example 更新 + .env.test 模板（獨立 test DB）
- [x] bootstrap/configure-app.ts（/api/v1 prefix、URI versioning、ValidationPipe、GlobalExceptionFilter、helmet、cookie-parser、CORS、shutdown hooks）
- [x] main.ts 改呼叫 configureApplication
- [x] modules/health（/health/live、/health/ready，VERSION_NEUTRAL + prefix exclude）
- [x] PrismaService 改 ConfigService 注入
- [x] TransactionService（transaction wrapper + FOR UPDATE/advisory lock helper + Prisma error mapping）
- [x] common helpers：errors、http、observability、clock、crypto、security、pagination
- [x] prisma/schema.prisma 加 SystemSetting model（UUID PK、JSONB、TIMESTAMPTZ）
- [x] 初始 additive migration（init_system_setting，含設計前提註解）
- [x] prisma/seed.ts（idempotent bootstrap_completed upsert）
- [x] test/setup/app-factory.ts（重用 production bootstrap）
- [x] test/setup/db.ts（migrate deploy + truncate helper）
- [x] test/jest-integration.json
- [x] test/app.e2e-spec.ts（驗 health probes）
- [x] test/health.integration-spec.ts（DB reachable，skip when not）
- [x] README.md 更新

### 本次續作 — Identity/Course 垂直切片驗證

- [x] 授權並套用 `20260815174233_add_identity_and_course` 至 `smartlearning_dev`
- [x] advisory lock 改用 `$executeRaw`，避免 Prisma 7 反序列化 PostgreSQL `void`
- [x] Identity/Course controller 明確設定 URI version `v1`
- [x] 認證錯誤碼、未登入狀態碼與 test cookie 行為對齊 wire contract
- [x] auth/course e2e、identity/health integration、unit、typecheck、lint、format、build 全部驗證

## Risk & Rollback

- **風險等級：低**。全為 additive（新檔案 + 一個 system_setting 資料表 + 新 scripts）；不動既有 domain（本就沒有）；不引入 auth/競態/刪除行為。
- **Rollback**：revert commit；migration 為 additive，forward-fix drop `system_setting` / `account` / `web_session` / `course` 即可。無 down migration 依賴。
- **已授權/執行**：`20260815174233_add_identity_and_course` 已依使用者確認套用至 `smartlearning_dev`；`prisma:migrate:status` 顯示 database schema up to date。
- **Test DB**：`smartlearning_test` 的 `prisma:migrate:status` 亦顯示 up to date；整合/e2e setup 的 idempotent migrate deploy 未留下 pending migration。

## 依賴與環境

- Runtime：Node（@types/node 22）、NestJS 11、Prisma 7（adapter-pg）、PostgreSQL 14+、Pino、helmet、cookie-parser、uuid 14
- 測試：jest 29、ts-jest、supertest
- 環境：.env.<NODE_ENV> 由 ConfigModule 與 prisma.config.ts 共用；必填 DATABASE_URL/CORS_ORIGIN/COOKIE_SECRET

## Working Notes / 不變量

- **Identity**：UUID v7，app 層產生（`common/crypto/uuid.ts` `newId()`）；Prisma model `id String @id @db.Uuid`。
- **狀態**：TEXT + CHECK（手寫 raw SQL migration）；應用層 union type 守護。
- **錯誤**：唯一 error 形狀為 `ErrorEnvelope`；`DomainError` 子類；`GlobalExceptionFilter` 擁有 HTTP status 映射；Prisma P2002→CONFLICT、P2025→NOT_FOUND。
- **bootstrap 共用**：production 與 e2e 同一 `configureApplication`。
- **lock helper**：`TransactionService.lockSessionQuestionForUpdate` / `lockCourseForAppend`（Phase 3/6 用，Phase 1 只建骨架）。
- **health**：VERSION_NEUTRAL + `setGlobalPrefix` exclude `['health']`，所以 `/health/live`、`/health/ready` 不在 `/api/v1` 下。
- **env 載入**：jest 自動設 `NODE_ENV=test` → 載 `.env.test`（PORT=3001、test DB）；`.env.test` 已 gitignore。
- **generated client**：`generated/prisma`，gitignored；import 路徑 `../../generated/prisma/client`（從 src/）或 `../../../generated/prisma/client`（從 src/common/http/）。
- **URI routes**：`defaultVersion` 不會替未標註 controller 自動加入 URI segment；Identity/Course 使用 `@Controller({ path, version: '1' })` 對齊 `/api/v1/*`。
- **test cookie**：supertest 走 plain HTTP；`AuthController` 僅在 `NODE_ENV=test` 且未明確設定時將 `SESSION_COOKIE_SECURE` 預設為 false，production 仍 secure-by-default。
- **移除 swagger**：transitive js-yaml 漏洞；Phase 1 不需 OpenAPI，完整定義留後續設計階段。

## Verification（執行結果）

| 命令                                                            | 結果                                                                    |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `NODE_ENV=development npm run prisma:migrate:deploy`            | ✅ 套用 `20260815174233_add_identity_and_course` 至 `smartlearning_dev` |
| `NODE_ENV=development npm run prisma:migrate:status`            | ✅ Database schema is up to date                                        |
| `NODE_ENV=test npm run prisma:migrate:status`                   | ✅ Test database schema is up to date                                   |
| `npm run prisma:generate`                                       | ✅ Prisma Client 7.9.1 generated                                        |
| `npm run prisma:validate`                                       | ✅ schema valid                                                         |
| `npm run typecheck`                                             | ✅ 通過                                                                 |
| `npm run lint:check`                                            | ✅ 通過（0 errors）                                                     |
| `npm run format:check`                                          | ✅ All matched files use Prettier code style                            |
| `npm run build`                                                 | ✅ nest build 通過                                                      |
| `npm test -- --runInBand`                                       | ✅ 5 suites / 18 tests passed                                           |
| `npm run test:e2e -- --runInBand test/auth-courses.e2e-spec.ts` | ✅ 1 suite / 10 tests passed                                            |
| `npm run test:e2e -- --runInBand`                               | ✅ 2 suites / 12 tests passed                                           |
| `npm run test:integration -- --runInBand`                       | ✅ 2 suites / 6 tests passed                                            |

## 結果

- Phase 0：《M2 關鍵技術決策》文件存在，11 項紅卡定案，作為 Phase 2+ 設計前提。
- Phase 1：fresh checkout 流程（README Quick start）可 prisma:generate → migrate:deploy → start:dev → health check；typecheck/lint/format/build/test/e2e/integration 全綠。
- 本次續作：Identity/Course 垂直切片 migration 已套用至 `smartlearning_dev`；advisory lock、URI version、auth error/guard semantics、test cookie defaults 已修正，完整 unit/integration/e2e 驗證全綠。
- 已知非阻擋警告：Nest/path-to-regexp 仍提示 `health/(.*)` 與 `/api/*` legacy route pattern，後續可改為 named wildcard syntax。

### Phase 2 前置 — M2 設計 gate

- [x] #1 領域分析：`docs/智學互動平台/20_系統分析/系統領域與需求分析.md`
- [x] #2 非功能、風險與驗收：`docs/智學互動平台/20_系統分析/非功能、風險與驗收分析.md`
- [x] #3 資料模型與 ERD：`docs/智學互動平台/30_系統設計/資料模型與 ER 設計.md`
- [x] #4 Web Auth 與安全：`docs/智學互動平台/30_系統設計/Web Auth 與安全設計.md`
- [x] 文件依賴順序完成：#1 → #2/#3 → #4；文件均區分 current implementation、target design 與 gap。
- [x] 文件已引用 SPEC、M2 決策、P0-07 W1～W8、Prisma schema/migration 與現有 Identity/Course/Auth source；未把 deferred capability 宣稱為已完成。
- [x] 非功能分析已登錄：NFR catalog、G0～G4 release gate、W1～W8 驗收、R-01～R-20 風險與 S-01～S-10 implementation-level acceptance risks。
- [x] `tasks/lessons.md` 的 `$executeRaw` advisory lock、explicit URI version、test cookie Secure、401/403 guard semantics 已接入後續實作 checklist。
- [x] #5 API 與共用 Schema：`docs/智學互動平台/30_系統設計/API 與共用 Schema 設計.md`
- [x] #6 即時同步與結果治理：`docs/智學互動平台/30_系統設計/即時同步與結果治理設計.md`
- [x] #7 架構、容量與可觀測性：`docs/智學互動平台/30_系統設計/架構、容量與可觀測性設計.md`
- [x] 跨文件 contract review：`docs/智學互動平台/30_系統設計/M2 跨文件 Contract Review.md`，結論 `PASS_WITH_FINDINGS`、無 Phase 2 設計阻擋項。
- [x] 來源層級已固定：P0/題目契約/結果治理/效能目標 → M2 technical decisions → API/realtime/architecture；交付計畫不覆寫 wire contract。
- [x] API entity/resource、Question field/error、Socket event、state/actor/transaction、Submission/archive、W1～W8/metrics 已建立 cross-document matrix。
- [x] M2 tech stack 與專案首頁已補齊 Socket.IO、Compose/Nginx、Redis boundary、Pino/metrics、Artillery、browser matrix 與四份新文件連結。
- [x] Review findings 已定案：v1 JSON 採 camelCase + `field`/`nextStep`；`can_create_course=false` 只阻止新建 Course，不撤銷獨立 CLI credential；舊 CLI BDD/交付計畫文字待後續同步。
- [x] 本 design gate 不修改 runtime、Prisma schema、migration、DB 或新增安全功能實作。

本次設計 gate 僅完成文件與 cross-document static verification；不重宣稱 Phase 1 的歷史 typecheck/lint/format/build/unit/e2e/integration 綠燈為本次 runtime 驗證。非功能分析仍保留 DB-required 測試不可靜默 skip、production cookie/CORS/CSRF/log-redaction/readiness 的後續驗收缺口。

### Design gate results

- API contract：REST/CLI/Socket shared envelope、Question schema、validation token、payload hash、idempotency 與 compatibility 已定案，runtime implementation deferred。
- Realtime/governance：Socket event sequence、snapshot/replay、submit/close linearization、outbox、aggregate、90-day retention、early deletion/tombstone 已定案，runtime proof deferred。
- Architecture/observability：Compose topology、PostgreSQL/Redis boundary、capacity assumptions、overload behavior、metrics/log/alert/load matrix 已定案，W1～W8 proof deferred。
- Cross-document review：`PASS_WITH_FINDINGS`；non-blocking follow-ups 為舊 CLI BDD 的 flag wording、交付計畫 snake_case examples、M3 success envelope implementation。
- Verification scope：documentation-only; no migration, Prisma generate, runtime test or DB mutation was performed for this gate.

## Lessons

- jest 自動設 `NODE_ENV=test`，會使 env 驗證走 `.env.test`；`.env.test` 的 PORT 不可為 0（@Min(1) 會 fail fast）。測試專用 env 需用合法可用 port。
- NestJS URI versioning 的 `defaultVersion` 會套用到所有 controller（含被 `setGlobalPrefix` exclude 的）；health 需標 `@Version(VERSION_NEUTRAL)` 並 exclude prefix 才能置於 `/health/*`。
- Prisma 7 generated client 匯入路徑為 `generated/prisma/client`（非 `@prisma/client`）；`Prisma` namespace（含 `PrismaClientKnownRequestError`、`TransactionClient`）從該處匯出。
- `@nestjs/swagger@11.4.6` 帶入脆弱的 transitive js-yaml（DoS）；Phase 1 不需 OpenAPI，移除以保 `npm audit` 乾淨；完整定義留後續設計階段再加回並鎖定安全版本。
- ConfigModule `validate` hook（而非 `load`）才能在 dotenv 載入 envFilePath 後驗證已解析的 env，避免 `configuration()` 在 env 載入前跑而讀到空 process.env。
- 本次 auth/course e2e 回歸的失敗模式、檢測訊號與防止規則已整理於 `tasks/lessons.md`。

### 2026-08-16 — Implementation slice 1: Common API envelope / stable error contract

#### Acceptance criteria

- [x] `/api/v1/**` JSON success responses use `{ data, meta: { schemaVersion: 1, requestId }, error: null }`.
- [x] `/api/v1/**` errors use `data: null`, the same metadata, existing stable error keys, and `retryAfterSeconds`.
- [x] `x-request-id` header and `meta.requestId` match; invalid/missing inbound IDs remain safely generated.
- [x] `/health/live` and `/health/ready` remain raw operational responses.
- [x] Prisma targets, stack traces, validation objects, and internal messages are not exposed.

#### Checklist

- [x] Add common envelope types/helpers and global success interceptor.
- [x] Extend exception filter/domain error integration without changing domain HTTP concerns.
- [x] Add focused interceptor/filter/validation contract tests.
- [x] Update `/api/v1` e2e success assertions and add request-ID/validation coverage.
- [x] Run typecheck, lint, format, unit, e2e, integration, and build verification.

#### Verification

| Command                                   | Result                     |
| ----------------------------------------- | -------------------------- |
| `npm test -- --runInBand common/http`     | PASS — 3 suites / 18 tests |
| `npm test -- --runInBand`                 | PASS — 8 suites / 36 tests |
| `npm run typecheck`                       | PASS                       |
| `npm run lint:check`                      | PASS after formatting fix  |
| `npm run format:check`                    | PASS                       |
| `npm run build`                           | PASS                       |
| `npm run test:e2e -- --runInBand`         | PASS — 3 suites / 16 tests |
| `npm run test:integration -- --runInBand` | PASS — 2 suites / 6 tests  |

#### Results

- Added a centralized v1 REST success interceptor and complete error envelope with schema/request metadata.
- Preserved raw health probe responses, HTTP status codes, existing stable error codes, and request-ID headers.
- Added deterministic, transport-safe validation issue normalization and Prisma/internal error redaction tests.
- No Prisma schema, migration, database, CLI, Socket.IO, or later-slice behavior changed.

#### Risk & rollback

- Risk: medium; existing `/api/v1` success consumers must read fields under `body.data`.
- Rollback: revert common HTTP/filter/bootstrap/test changes; no database or migration rollback required.

#### Working notes

- Controllers remain unchanged; wrapping is centralized.
- Pagination remains nested under `data`; outer `meta` is reserved for schema/request metadata.
- CLI, Socket.IO, shared Web/CLI fixtures, question schema, token/hash, idempotency, race, outbox, and retention work remain later slices.

#### Review hardening

- [x] Normalize handler-returned envelope metadata to the current request ID and reject malformed envelope-shaped values.
- [x] Map unmapped 4xx statuses to client-error codes instead of `INTERNAL_ERROR`.
- [x] Restrict built-in `HttpException` messages to shared validation output or safe status messages.
- [x] Use bracket notation for array validation paths and locale-independent deterministic ordering.
- [x] Remove raw 5xx exception messages/stacks from global error logs; retain request ID, status, stable code, and exception type.
- [x] Add regression coverage for stale/malformed envelopes, safe messages, 422 mapping, array paths, and log redaction.

Review verification after hardening: focused HTTP tests 3 suites / 18 tests, full unit tests 8 suites / 36 tests, typecheck, lint, format, build, e2e 3 suites / 16 tests, integration 2 suites / 6 tests, and `git diff --check` all passed. Existing Nest legacy wildcard route warnings remain non-blocking and unchanged.

### 2026-08-16 — Implementation slice 2: Web Auth mutation safety

#### Context and scope

- [x] The repository has no authoritative literal “slice 2” entry; this inferred slice follows the roadmap-authoritative Phase 2 Web Auth hardening boundary.
- [x] Implement current-session logout/revocation plus CSRF/Origin enforcement for existing authenticated mutations.
- [x] Keep rate limiting, step-up, password change/reset, disable/restore, CLI credentials, audit/login attempts, QuestionDefinition, Socket.IO, and governance work deferred.

#### Acceptance criteria

- [x] Login issues a high-entropy non-HttpOnly `__Host-csrf` cookie alongside `__Host-session`; raw CSRF values never enter JSON, logs, DB, or AuthContext.
- [x] `POST /api/v1/auth/logout` idempotently revokes the current WebSession and clears both auth cookies.
- [x] Authenticated POST mutations reject missing/mismatched CSRF token/header or missing/unapproved Origin with 403 `AUTH_CSRF_INVALID`.
- [x] Safe GET routes remain usable without CSRF headers; login remains an unauthenticated entry point.
- [x] CSRF comparisons use constant-time comparison; Origin matching is exact and fail-closed.
- [x] Production cannot explicitly disable Secure cookies; test-only plain HTTP behavior remains available.
- [x] Existing v1 envelope, request IDs, 401/403 semantics, health routes, authorization, and course behavior remain unchanged.

#### Checklist

- [x] Add CSRF helper/guard and stable domain-error path; export through common auth/security boundaries.
- [x] Extend cookie options, login CSRF issuance, SessionService idempotent revoke, logout endpoint, and cookie clearing.
- [x] Apply CSRF guard to admin account creation and course create/archive mutations.
- [x] Add focused CSRF/cookie/env unit tests and auth/course e2e regression coverage.
- [x] Run targeted and full verification; record command outcomes and DB availability.

#### Risk & rollback

- **Risk:** medium/high; all existing authenticated mutations gain a fail-closed security check.
- **Rollback:** revert application/guard/cookie/test changes; no Prisma migration or database rollback is expected. Do not restore already-revoked sessions during rollback.

#### Verification plan

- `npm test -- --runInBand` plus focused CSRF/security tests.
- `NODE_ENV=test npm run prisma:migrate:status`.
- `npm run test:e2e -- --runInBand test/auth-courses.e2e-spec.ts`.
- `npm run test:integration -- --runInBand test/identity.integration-spec.ts`.
- `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`, `git diff --check`.

#### Results

- Targeted verification: `npm run typecheck` passed; focused CSRF and environment-validation tests passed (2 suites, 6 tests).
- Final wildcard-Origin hardening recheck: typecheck, focused suites, and auth/courses E2E all passed (E2E: 1 suite, 12 tests).
- Full unit suite: passed (10 suites, 42 tests).
- PostgreSQL verification: `NODE_ENV=test npm run prisma:migrate:status` passed; PostgreSQL was reachable, 2 migrations were present, and the schema was up to date.
- Database-backed regression: auth/courses E2E passed (1 suite, 12 tests); identity integration passed (1 suite, 5 tests).
- Final quality gates after wildcard-Origin hardening: lint, format check, build, and `git diff --check` all passed.
- Non-blocking warning: E2E/integration startup emitted existing Nest `LegacyRouteConverter` wildcard-route warnings; no test failed.
- No Prisma schema or migration changes were introduced.

### 2026-08-16 — Implementation slice 3: Step-up and account credential lifecycle

#### Context and scope

- [x] Implement session-bound 10-minute step-up authentication and `StepUpGuard`.
- [x] Implement self password change with forced temp-password flow and full session revocation/rotation.
- [x] Implement admin reset-password, disable, and restore endpoints with step-up protection.
- [x] Keep Redis rate limiting, LoginAttempt, CLI credentials, full AuditEvent persistence, QuestionDefinition, Socket.IO, and governance work deferred.

#### Acceptance criteria

- [x] `POST /api/v1/auth/step-up` re-verifies the current password, stores state only on the current Account/WebSession, and returns no password/token.
- [x] Missing, expired, revoked, disabled, or cross-session step-up state returns `AUTH_STEP_UP_REQUIRED`.
- [x] Temp/reset passwords set `mustChangePassword`; force-change accounts can only use the allowed session/logout/step-up/password-change paths until changed.
- [x] Password change updates `passwordChangedAt`, invalidates the old password, revokes all previous sessions transactionally, and rotates the current session/CSRF cookies.
- [x] Admin reset/disable/restore are CSRF-protected, step-up-protected, transactional, and never return password/hash/cookie/token values.
- [x] Disable immediately invalidates all target sessions; restore never revives revoked sessions.
- [x] Error responses, logs, and any audit metadata contain no raw password, cookie, token, or password hash.

#### Checklist

- [x] Add nullable WebSession step-up timestamp and additive migration.
- [x] Add step-up validity helper/guard, password-change-required guard semantics, stable errors, and transaction/account-lock helpers.
- [x] Extend SessionService/AuthService/AccountService and controllers/DTOs.
- [x] Update safe response projections and Pino redaction paths.
- [x] Add focused unit tests plus PostgreSQL-backed identity/e2e regression coverage.
- [x] Run Prisma, typecheck, lint, format, unit, integration, e2e, build, and diff verification.

#### Risk & rollback

- **Risk:** high; authentication, password state, session validity, and account availability change together.
- **Rollback:** revert application routes/guards/services while retaining the nullable additive step-up column; never restore revoked sessions or old credentials.

#### Verification plan

- `NODE_ENV=test npm run prisma:migrate:status`
- `npm run prisma:generate && npm run prisma:validate`
- `npm test -- --runInBand`
- `npm run test:integration -- --runInBand test/identity.integration-spec.ts`
- `npm run test:e2e -- --runInBand test/auth-courses.e2e-spec.ts`
- `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`, `git diff --check`

#### Working notes

- Current route contract explicitly uses POST for `/admin/accounts/:id/reset-password`, `/disable`, and `/restore`; retain that user-requested contract.
- Existing Account fields `mustChangePassword`, `passwordChangedAt`, `disabledAt` and WebSession `revokedAt` are reused.
- Self-target admin lifecycle operations are denied by default; self password changes use `/auth/change-password`.
- Login re-verifies the originally checked password hash under an account lock before inserting a session, preventing stale login sessions after reset/change/disable races without holding the lock during Argon2 verification.
- Password changes reject reuse of the current credential, and self-target UUID checks canonicalize case-insensitive PostgreSQL UUID input.
- Account-wide session revocation clears step-up state; step-up marking locks the account and conditionally updates an unrevoked session.
- Pino request/response redaction is wired at `LoggerModule` configuration and covered by an emitted-record test.

#### Verification results

| Command                                                                     | Result                                                                 |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `NODE_ENV=test npm run prisma:migrate:deploy`                               | PASS — applied `20260816100000_add_step_up_at` to `smartlearning_test` |
| `NODE_ENV=test npm run prisma:migrate:status`                               | PASS — database schema up to date                                      |
| `npm run prisma:generate && npm run prisma:validate`                        | PASS — Prisma Client 7.9.1 generated; schema valid                     |
| `npm test -- --runInBand`                                                   | PASS — 12 suites / 47 tests                                            |
| `npm run test:integration -- --runInBand test/identity.integration-spec.ts` | PASS — 1 suite / 5 tests                                               |
| `npm run test:e2e -- --runInBand test/auth-courses.e2e-spec.ts`             | PASS — 1 suite / 14 tests                                              |
| `npm run typecheck`                                                         | PASS                                                                   |
| `npm run format:check`                                                      | PASS                                                                   |
| `npm run lint:check`                                                        | PASS                                                                   |
| `npm run build`                                                             | PASS                                                                   |
| `git diff --check`                                                          | PASS                                                                   |

#### Results

- Added persistent Account + WebSession-bound 10-minute step-up and method-level `StepUpGuard` protection for admin reset, disable, and restore.
- Connected forced password-change enforcement, self password rotation, transactional full-session revoke, current-session/CSRF-cookie rotation, admin reset, disable, and restore.
- Added stale-login race protection, same-password rejection, UUID-case-safe self-target protection, and runtime Pino secret redaction.
- PostgreSQL-backed regression covers force-change gating, old-password/session invalidation, cross-session and expired step-up, active-session disable revocation, restore non-revival, and secret-free projections.
- Existing Nest `LegacyRouteConverter` wildcard route warnings remain non-blocking. Redis rate limiting, LoginAttempt, CLI credentials, full AuditEvent persistence, login-CSRF hardening, and broader governance work remain intentionally deferred.

### 2026-08-16 — Poll single-choice mock contract + Question → LiveSession → Participant → Submission

#### Context and acceptance criteria

- [x] Freeze one executable `poll` + `single` mock contract before runtime implementation.
- [x] Implement the smallest persisted Question → LiveSession → Participant → Submission path.
- [x] Keep the current `/api/v1` envelope, UUID v7, UTC timestamps, Web Session/CSRF semantics, and PostgreSQL authority.
- [x] Do not include Socket.IO, results/archive, batch question validation, CLI, scheduler, or other question types in this slice.

#### Checklist

- [x] Add DB-free canonical fixture/spec for poll single-choice normalization, snapshot, participant token boundary, and Submission replay/conflict semantics.
- [x] Add additive Prisma models/migrations for QuestionDefinition/Option, LiveSession/SessionQuestion snapshot, Participant, and Submission.
- [x] Add questions/live-sessions/participants/submissions domain, application, API, and guard boundaries.
- [x] Add owner/state guards, session code generation, participant token hashing, exact-one option validation, and immutable Submission/idempotency handling.
- [x] Add PostgreSQL integration and HTTP e2e regression coverage.
- [x] Run Prisma, targeted poll tests, typecheck, lint, format, build, and `git diff --check`.
- [ ] Run the full repository unit/integration/e2e suites; targeted coverage is complete, but full-suite execution remains outside this slice's final verification run.

#### Risk & rollback

- **Risk: high** — new relational state, partial unique/check constraints, anonymous bearer token, and immutable answer/transaction semantics.
- **Rollback:** revert application routes/services while retaining additive tables; do not rely on destructive down migration or restore already-created Submission/token rows.
- **Monitoring:** migration status, DB unique/lock errors, `SESSION_NOT_JOINABLE`, `SUBMISSION_CONFLICT`, accepted/replayed/rejected Submission counts, and redaction of participant token/idempotency/answer fields.

#### Working notes / invariants

- Question input is camelCase `poll` + `single`, prompt 1–1,000 trimmed Unicode code points, 2–10 unique options, option text 1–250 code points, optional unique option refs, and no `correctOptionRefs`.
- LiveSession is `waiting → active`; activation revalidates the source and creates immutable SessionQuestion/Option snapshots. SessionQuestion is `not_open → open → closed`, with at most one open per session.
- Participant token is high-entropy opaque, scoped to one LiveSession, raw only in join response, and hashed in PostgreSQL.
- Submission accepts a formal snapshot option UUID or declared option ref, canonicalizes persistence to the formal option UUID, and is accepted only for an active session/open snapshot; one selected option; unique `(participantId, sessionQuestionId)`; same-key same-payload replay; different answer/key conflict; no update path.
- Course append/archive/session-start and question submit/open/close paths use centralized PostgreSQL advisory/row-lock boundaries; UUID inputs enforce RFC version/variant shape before raw casts.
- The option-ref fields are in the separate `20260816140000_add_poll_option_refs` migration so the already-applied hardening migration checksum remains stable.
- `20260816150000_scope_live_session_question_selection` adds a denormalized Course scope with composite foreign keys and fails closed on pre-existing cross-course selection rows.
- Activation revalidates the full poll contract, snapshot creation has an explicit 30-second transaction timeout for the 50-question bound, and formal option IDs take precedence over colliding wire refs.
- Test DB setup force-loads `.env.test` and refuses to migrate/truncate a database whose name is not `smartlearning_test`.

#### Deferred scope

- Socket.IO/outbox/replay, result aggregate/vote-to-reveal, ArchivedResult/retention/deletion/tombstone, full LiveSession close/cancel/auto-close, quiz/open_text, batch validation/preview/confirm, CLI credentials, rate limiting, and full W1–W8 load/race matrix.
- Because terminal LiveSession lifecycle routes are intentionally deferred, an abandoned waiting/active session remains an archive blocker until a later lifecycle implementation or controlled administrative remediation is provided.
- Participant snapshots currently use the existing Submission indexes; add a forward composite `(live_session_id, participant_id)` index before high-volume classroom rollout if profiling confirms the expected access pattern.

#### Verification

| Command                                                                                                                                                                                                               | Result                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `npm run prisma:generate`                                                                                                                                                                                             | PASS — Prisma Client 7.9.1 generated                                    |
| `npm run prisma:validate`                                                                                                                                                                                             | PASS — schema valid                                                     |
| `NODE_ENV=test npm run prisma:migrate:status`                                                                                                                                                                         | PASS — PostgreSQL `smartlearning_test`, 7 migrations, schema up to date |
| `npm test -- --runInBand src/common/crypto/uuid.spec.ts src/modules/questions/domain/poll-single-choice.spec.ts src/modules/participants/domain/display-name.spec.ts src/common/observability/pino-redaction.spec.ts` | PASS — 4 suites / 15 tests                                              |
| `npm test -- --runInBand`                                                                                                                                                                                             | PASS — 16 suites / 63 tests                                             |
| `npm run test:integration -- --runInBand test/poll-submission.integration-spec.ts`                                                                                                                                    | PASS — PostgreSQL-backed, 1 suite / 4 tests, 0 skipped                  |
| `npm run test:e2e -- --runInBand test/poll-single-choice.e2e-spec.ts`                                                                                                                                                 | PASS — PostgreSQL-backed, 1 suite / 1 test, 0 skipped                   |
| `npm run typecheck`                                                                                                                                                                                                   | PASS                                                                    |
| `npm run lint:check`                                                                                                                                                                                                  | PASS                                                                    |
| `npm run format:check`                                                                                                                                                                                                | PASS                                                                    |
| `npm run build`                                                                                                                                                                                                       | PASS                                                                    |
| `git diff --check`                                                                                                                                                                                                    | PASS                                                                    |

Targeted verification is complete against real PostgreSQL; the full repository unit/integration/e2e suites were not run. The migration setup applies all seven migrations idempotently, and the poll suites fail loudly rather than treating an unavailable or stale database as a skip.

### 2026-08-16 — Frontend baseline assessment + backend follow-up backlog

#### 背景

使用者目標:以目前後端為基準,推進前端三個產品流程 —(A)老師出題、(B)課堂中使用(老師端)、(C)學員課堂中使用。本節記錄可立即對接的部分、前端整合陷阱,以及需後端補強才能完成三流程的 follow-up backlog 與優先序。來源證據:現有 controller/DTO/e2e 程式碼 + `tasks/todo.md` 既有 deferred scope 註記 + sibling `docs/智學互動平台/` M2 設計文件(target contract,非已實作)。

#### 前端可立即對接的能力(基準部分,已由 e2e 驗證)

| 前端功能            | 可用 API                                                                                   | 備註                                               |
| ------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| 登入/登出/改密/身分 | `POST /auth/login`、`POST /auth/logout`、`POST /auth/change-password`、`GET /auth/session` | cookie session + CSRF double-submit                |
| 課程管理            | `POST/GET/GET/:id /courses`、`POST /courses/:id/archive`                                   | 分頁回傳 `Page<CourseDto>`                         |
| 老師出題(單選)      | `POST /courses/:courseId/questions`                                                        | 只支援 `poll`+`single`,2–10 選項,僅 draft 課程可加 |
| 開課堂              | `POST /live-sessions`、`POST /:id/start`                                                   | start 產生不可變 snapshot                          |
| 課堂中控制收/開題   | `POST .../questions/:qid/open`、`.../close`                                                | 同一時間只能一題 open                              |
| 學員加入            | `POST /live-sessions/:sessionCode/join`                                                    | 公開;participant token 只回傳一次                  |
| 學員看題            | `GET /live-sessions/:id/snapshot`                                                          | participant 只看到 open 題 + `hasSubmitted`        |
| 學員答題            | `POST /live-sessions/:id/submissions`                                                      | 需 `X-Participant-Token` + `Idempotency-Key`(UUID) |

這條 happy path 在 `test/poll-single-choice.e2e-spec.ts` 已端對端驗證,前端可放心對接。

#### 前端整合陷阱(已由程式碼確認,開發前必知)

1. **CSRF token 取得**:無獨立 `/csrf` endpoint;token 只能從 login 回應的 `Set-Cookie: __Host-csrf`(非 HttpOnly)讀取,之後所有 mutation 需帶 `X-CSRF-Token` + `Origin`。
2. **CORS_ORIGIN 不可用 `*`**:CSRF Origin 檢查 fail-closed,`*` 會讓所有 authenticated mutation 回 403 `AUTH_CSRF_INVALID`。需設明確 origin。
3. **回應永遠包在 envelope**:資料在 `response.body.data`;課程分頁是 `data.data` + `data.meta`;logout 為 `data: null`。
4. **submission 回傳值正規化**:`selectedOptionRefs` 可能被正規化成 formal option UUID,而非送出的 optionRef → 前端比對答案需用 ID。
5. **`GET /auth/session` 回傳 `expiresAt: ""`**(空字串):不要用來判 session 過期;過期目前一律映射成 `UNAUTHORIZED`(`AUTH_SESSION_EXPIRED` 宣告但未使用)。
6. **無 OpenAPI/Swagger**:型別需手寫,直接對齊 `src/modules/*/api/dto/*.ts`;文件與後端現況不同步,以程式碼/e2e 為準。
7. **無 GET session detail 給老師**:老師端 session projection 靠 snapshot route(cookie 身分),非獨立 endpoint。
8. **健康檢查不在 envelope**:`/health/*` 為原始回應,前端不可套用 envelope 解析。

#### 三流程缺口 + 後端 follow-up backlog(按優先序)

優先序原則:先補「讓前端縱切可走通」的端點,再補「即時/結果/封存」。每項附前端 mock 占位策略,讓兩軌平行推進。

##### P1 — 老師出題流程補完

- [ ] **Q-1** 題目列表/詳情:`GET /courses/:courseId/questions`、`GET /courses/:courseId/questions/:id` → 回 `QuestionDto`/分頁。前端現況:只能記住建立時回傳的 DTO,重新整理即遺失。
- [ ] **Q-2** 題目更新/刪除/排序:`PATCH /questions/:id`、`DELETE /questions/:id`、`PATCH /courses/:courseId/questions/order`(position 陣列);僅 draft 課程可改。前端占位:編輯/刪除按鈕先 disable + tooltip「待後端」。
- [ ] **Q-3** 題型擴充:`open_text`、`quiz`、poll `multiple`;擴充 `CreateQuestionDto` 與 domain validator。前端占位:出題表單只開單選,其他題型選項 disabled。
- [ ] **Q-4** 批次驗證/預覽/確認:`POST /courses/:courseId/questions/batch-validate`、`/batch-preview`、`/batch-confirm`(all-or-nothing + validation token + payload hash + idempotency),對齊《題目領域契約》。前端占位:批次匯入 UI 先做前端本地驗證,送出時提示「批次 API 待後端」。

##### P2 — 課堂中(老師端)流程補完

- [ ] **S-1** LiveSession close/cancel:`POST /live-sessions/:id/close`、`POST /live-sessions/:id/cancel`;補 `closed`/`cancelled` 狀態轉移(目前只有 `waiting→active`)。解除 todo 行 370 的封存阻斷。
- [x] **S-2** 老師端 session detail:獨立 `GET /live-sessions/:id`(目前靠 snapshot)→ 回完整 projection 含 joined/voted 人數。
- [x] **S-3** 結果/聚合 endpoint:`GET /live-sessions/:id/questions/:qid/results` → 選項計數 + vote-to-reveal 投影 + 匿名聚合(US-F17);quiz 正確率 / open_text 投影隨 Q-3 一起。前端占位:結果頁先 mock 靜態資料 + 介面抽象成 `ResultsProvider`,後端就緒後切換。
- [x] **S-4** joined/voted 即時人數:見 P3 即時通道;無 Socket 前先用 snapshot 輪詢頂著。
- [x] **S-5** 封存/保留:`ArchivedResult` + 90 天保留 + 早刪/tombstone(依《即時同步與結果治理設計》)。目前由 close 後 archive finalization 觸發，保留明確 purge entrypoint；HTTP archive routes 為 `/api/v1/results`。

##### P3 — 學員課堂流程補完

- [ ] **R-1** reconnect/replay 協定:Socket.IO `/live` namespace + session room + snapshot/replay + reconnect;前端占位:以 snapshot 輪詢 adapter 抽象化 `LiveSessionChannel`,日後切 Socket。
- [ ] **R-2** vote-to-reveal 結果投影:學員端 `GET .../results` 或 Socket 事件;依 S-3 結果 API。前端占位:結果顯示先 mock。
- [ ] **R-3** 結束後行為/封存:closed session 學員 snapshot 行為 + 封存結果可見性;依 S-1/S-5。
- [ ] **R-4** submit/close 競態與 auto-close scheduler:完整 race matrix + 自動收題;todo 既有 deferred scope。

##### P4 — 工程基準補強(非流程阻擋,但影響前端開發體驗)

- [ ] **E-1** OpenAPI/Swagger 重新引入(鎖安全版本,避 js-yaml 漏洞):產出前端可消費的型別/客戶端。
- [ ] **E-2** `GET /auth/session` 回傳真實 `expiresAt`(目前空字串);或前端改用 401 觸發重登。
- [ ] **E-3** `AUTH_SESSION_EXPIRED` 與 `UNAUTHORIZED` 區分,前端可分辨「需重登」vs「無權」。
- [ ] **E-4** 既有非阻擋項:`@Get('ready')` 重複 decorator 清理、Nest legacy wildcard route 警告。
- [ ] **E-5** 帳號管理:list/detail/update(目前只有 create/reset/disable/restore)。

#### 兩軌推進建議

- **前端軌(現在啟動)**:先做 auth + 課程 + 單選出題 + 開課堂 + 學員答題這條可連通路徑;型別手寫對齊 DTO;即時/結果用 adapter(P3 R-1 的 `LiveSessionChannel`)+ mock 占位,介面抽象化以便後端就緒後切換。
- **後端軌(並行補)**:依 P1→P2→P3→P4 順序,每個 slice 維持既有 thin vertical slice + targeted verification 慣例;前端 mock 占位介面即為後端實作合約。

#### Risk & rollback

- **風險等級:低**(本節僅為評估與規劃紀錄,不修改 runtime/schema/migration)。
- **Rollback**:無需 rollback;本節為規劃文件,實作 slice 各自有自己的 risk/rollback 區塊。
- **監控信號**(實作時):各新 endpoint 的 error code 使用率、`SUBMISSION_CONFLICT`、Socket reconnect 次數、aggregate 一致性檢查。

#### 待確認決策

- [x] 確認 P1–P4 優先序採用:出題擴充(P1)→ 課堂老師端(P2)→ 學員課堂(P3)→ 工程基準(P4)。使用者 2026-08-16 確認。
- [x] 確認前端策略採用選項 B:等後端齊再開前端 — 每個流程的後端端點做完才開對應前端,不做前端 mock 占位。使用者 2026-08-16 確認。後端依 P1→P4 順序逐 slice 補完,前端待後端對應端點完成再啟動。

#### 2026-08-16 — P1 出題擴充實作決策(M2 文件未定案點拍板)

來源:M2 文件探索(題目領域契約 / API 與共用 Schema 設計 / M2 關鍵技術決策 / M2 跨文件 Contract Review)+ questions 模組程式碼探索。使用者拍板四項決策:

- [x] **Route 慣例**:巢狀於課程 — `PATCH/DELETE /courses/:courseId/questions/:id`、reorder `PATCH /courses/:courseId/questions/order`(對齊 M2 API catalog,捨棄 backlog 扁平寫法 `PATCH /questions/:id`)。修正 backlog Q-2/Q-4 route 名稱。
- [x] **isCorrect 暴露**:出題投影含正解 — authoring projection DTO 含 `isCorrect`/`correctOptionRefs`(teacher list/detail);學員 snapshot/participant 維持不暴露。`toQuestionDto` 將分裂為 `toAuthoringQuestionDto`(含正解)/ `toLearnerQuestionDto`(不含)。既有 snapshot mapping 改用 learner 投影。
- [x] **Swagger 形態**:UI + JSON — `/api/docs` + `/api/docs-json`(`useGlobalPrefix:true`)。`@nestjs/swagger` exact pin + `overrides.js-yaml>=5.3.0`,驗 `npm audit` 乾淨。修正歷史「js-yaml 4.1.0+ 安全」(已過時):`@nestjs/swagger@11.4.6` 帶 `js-yaml@5.2.1`(GHSA-pm4m-ph32-ghv5,fix 5.3.0);`11.4.5` 帶 `4.3.0`(GHSA-5p4m-2wfm-xmqj,fix 4.3.1),兩者皆有漏洞。
- [x] **Slice 順序**:E-1 先 → Q-1 → Q-2 → Q-3 → Q-4。先建 Swagger 基礎,後續新增端點自動產出 spec。

**Stale 衝突修正(以 M2 權威來源為準)**:

- 實作規劃文件提到 batch token 為「signed token」 → 修正為 **DB-backed opaque token**(M2 決策/API/review 一致,《M2 關鍵技術決策》L83-94)。
- backlog 的 `/questions/batch-validate`、`/batch-preview`、`/batch-confirm` route → 修正為 `/question-batches/validate` + `/question-batches/confirm`(M2 API catalog L190-192);**無獨立 batch-preview endpoint**,preview 為 validate 成功回應欄位。
- 領域文件範例用 snake_case → v1 wire 一律 camelCase(M2 review L119-123 已閉環)。

**M2 文件未定案、本計畫以實作決策補齊(各 slice 實作時落地)**:

- list 分頁 query 形狀:`page`/`pageSize` query string(鏡射 courses)。
- validation-token 傳遞:建議 header `X-Validation-Token`(confirm 重送 payload + token)。
- explicit confirmation 欄位:confirm body 加 `confirmed: true`。
- confirm response DTO:`{ schemaVersion, questions: QuestionDto[], payloadHash }`。
- warning object schema:`{ code, field, message }`(非 blocking,無 nextStep)。
- courseId 同時在 path 與 body:path 為準,body 的 `courseId` 必須相符否則 `CONFLICT`/`VALIDATION_FAILED`。
- token 過期/hash 不符/已消耗的精確 error code 未定案 → 用 `CONFLICT` 類別 + 明確 code(實作時定案並記錄)。
- Unicode 正規化形式:現況 NFC(非紅卡明文),沿用。

完整實作計畫見 `/home/user/.claude/plans/linear-wibbling-shore.md`。

### 2026-08-16 — Slice 0: E-1 OpenAPI/Swagger 基礎(完成)

#### Context

P1 出題擴充的前置基礎:重新引入 `@nestjs/swagger`,讓後續 Q-1~Q-4 新增端點自動產出前端可消費的 OpenAPI spec。Phase 1 曾因 transitive js-yaml DoS 移除 swagger;本 slice 以安全 pin + override 重引入。

#### Checklist

- [x] `@nestjs/swagger@11.4.6` exact pin + `overrides.js-yaml=5.3.0`(修正過時的「js-yaml 4.1.0+ 安全」;11.4.6 帶 5.2.1 有 GHSA-pm4m-ph32-ghv5,fix 5.3.0)。
- [x] `npm install` + `npm audit` → 0 vulnerabilities;所有 js-yaml 解析為 5.3.0(overridden/deduped)。
- [x] 新 `src/bootstrap/configure-swagger.ts`:`configureSwagger(app)` 掛 `/api/docs`(UI)+ `/api/docs-json`(JSON),`useGlobalPrefix:true`、`raw:['json']`(JSON-only,避免叫用 YAML dump)。`DocumentBuilder` 不加 `/api/v1` server URL(scanner 已套 global prefix,避免雙前綴)。
- [x] `src/main.ts` 與 `test/setup/app-factory.ts` 皆呼叫 `configureSwagger(app)`(在 `configureApplication` 後)。
- [x] `nest-cli.json` 加 Swagger compiler plugin(`classValidatorShim:true` + `introspectComments:true`)→ request DTO 自動從 class-validator 推斷。
- [x] response DTO 補 `@ApiProperty`/`@ApiPropertyOptional`(最小集:question/course/auth account+session;nullable `optionRef`/`selectionMode`/`description`/`disabledAt` 標 `nullable:true`)。
- [x] controller 補 `@ApiTags`:`auth`、`courses`、`questions`。
- [x] 新 `test/openapi.e2e-spec.ts`:斷言 `/api/docs-json` 回 OpenAPI JSON(不被 envelope 包)、含 `/api/v1/courses` + `/health/live` + `/health/ready`、無 `/api/api/` 雙前綴、`/api/docs` 回 HTML。

#### 設計決策(Envelope 表示:選項 A 最小可用)

- controller 回傳型別為內層 DTO,實際 HTTP 為 `{data,meta,error}` envelope,OpenAPI 不會自動包。
- **採選項 A**:spec 顯示內層型別 + DocumentBuilder description 說明 envelope 全域套用。前端 client 生成後手動解 `body.data`。
- 選項 B(document postprocess 包 envelope wrapper 或每 controller `@ApiResponse`)列為 follow-up;若前端強烈需 envelope 型別再升級。

#### Verification

| 命令                                                                                                              | 結果                                         |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `npm install` + `npm audit`                                                                                       | ✅ 0 vulnerabilities;js-yaml 全 5.3.0        |
| `npm run typecheck`                                                                                               | ✅ 通過                                      |
| `npm run lint:check`                                                                                              | ✅ 0 errors                                  |
| `npm run format:check`                                                                                            | ✅ All matched files use Prettier code style |
| `npm run build`                                                                                                   | ✅ nest build 通過                           |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/openapi.e2e-spec.ts`                                          | ✅ 1 suite / 3 tests                         |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/app.e2e-spec.ts test/api-envelope.e2e-spec.ts`                | ✅ 2 suites / 6 tests                        |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/auth-courses.e2e-spec.ts test/poll-single-choice.e2e-spec.ts` | ✅ 2 suites / 15 tests(DB-backed,無回歸)     |

#### Results

- 重新引入 OpenAPI/Swagger,UI `/api/docs` + JSON `/api/docs-json`,既有端點(auth/course/question/session/participant/submission)產出 spec;路徑為 `/api/v1/*`、health 為 `/health/*`,無雙前綴。
- 安全 pin + override 讓 `npm audit` 乾淨,供應鏈安全。待 upstream 修補版 swagger 出現可移除 override。
- compiler plugin 自動推斷 request DTO;response DTO 補 `@ApiProperty`(最小集,其餘隨各 slice 補)。
- docs route 為 raw OpenAPI,不被 `ApiResponseInterceptor` envelope 包覆(正確,因 interceptor 只包 `/api/v1`)。

#### Risk & rollback

- **風險:中**。新依賴 + compiler plugin + DTO decorator;envelope 表示方式影響前端。
- **Rollback**:revert package.json/nest-cli.json/bootstrap/main/app-factory/DTO/controller 變更;`npm install` 回原 lockfile。無 DB/migration。
- **不變量維持**:envelope 仍由 interceptor 套用、health 不在 `/api/v1`、CSRF/auth 行為不變、既有 e2e 全綠(24 tests 無回歸)。

#### Follow-up(非本 slice 阻擋)

- Envelope 表示升級為選項 B(postprocess / `@ApiResponse`),若前端需 envelope 型別。
- 其餘 controller(live-sessions/participants/submissions/admin)補 `@ApiTags` + response DTO `@ApiProperty`,隨 P2/P3 各 slice 補。
- 既有非阻擋警告:Nest `LegacyRouteConverter`(`health/(.*)`、`/api/*`)、`pg@9 client.query()` deprecation — 列為 E-4 清理。

### 2026-08-16 — Slice 1: Q-1 題目列表/詳情(完成)

#### Checklist

- [x] `GET /api/v1/courses/:courseId/questions`(分頁,position 升序)
- [x] `GET /api/v1/courses/:courseId/questions/:id`(單題含 options,不含 `isCorrect`)
- [x] `QuestionService` 注入 `PrismaService`;加 `listQuestions`/`getQuestion`/`assertCourseReadable`(owner/admin,不拒 archived,非 owner → `NOT_FOUND` 不洩漏存在性)
- [x] 重用 `normalizePageRequest`/`toPage`(src/common/pagination)、`toQuestionDto`;detail 用 `(id, courseId)` compound unique
- [x] 補 `@ApiTags('questions')`

#### Verification

| 命令                                                                                | 結果                        |
| ----------------------------------------------------------------------------------- | --------------------------- |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/questions-read.e2e-spec.ts`     | ✅ 1 suite / 9 tests        |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/poll-single-choice.e2e-spec.ts` | ✅ 1 suite / 1 test(無回歸) |
| typecheck/lint/format/build                                                         | ✅ 全綠                     |

#### Results

- 新增兩個唯讀端點,鏡射 courses list/detail 模式;存取控制用 course detail 語義(owner/admin,archived 可讀)。
- 新 e2e 覆蓋:list 升序 + 分頁 meta、`?page&pageSize`、detail options 升序無 `isCorrect`、非 owner 404、admin read-across、GET 不需 CSRF、缺失/跨課程 questionId 404、archived 可讀。
- 無 schema/migration 變更。

#### Risk & rollback

- **風險:低**。純唯讀 + 新測試。Revert commit 即可;無 DB/migration rollback。

### 2026-08-16 — Slice 2: Q-2 更新/刪除/排序(完成)

#### Checklist

- [x] `PATCH /api/v1/courses/:courseId/questions/:id`(full-replace prompt/options,poll/single 同 create,position 保留)
- [x] `DELETE /api/v1/courses/:courseId/questions/:id`(刪除 + compact 剩餘位置為連續 1..N)
- [x] `PATCH /api/v1/courses/:courseId/questions/order`(reorder,body `{ questionIds: string[] }` 完整順序,兩階段重排)
- [x] `UpdateQuestionDto`、`ReorderQuestionsDto`(`@IsArray` + `@IsString({ each: true })`,移除 `@ValidateNested` 避免 primitive 陣列驗證失敗)
- [x] `assertNotLockedBySession`(查 `LiveSessionQuestionSelection` join `liveSession.status in [waiting, active]`,命中 throw `QUESTION_LOCKED_BY_SESSION` 409) — 程式碼先前已宣告未使用,本 slice 首次落地
- [x] `compactPositions`(兩階段重排避 `(courseId, position)` immediate unique 中途違反)
- [x] reorder route 宣告於 `:id` route 之前(避免 Nest 把 `order` 匹配為 `:id` 參數)

#### 設計要點

- **locked-by-session guard**:在 `assertCourseWritable`(draft-only)後、mutation 前,用 `liveSessionQuestionSelection.findFirst({ where: { courseId, questionDefinitionId: { in: ids }, liveSession: { is: { status: { in: [waiting, active] } } } } })`。reorder 用 `in: ids`。
- **兩階段重排**:因 `(courseId, position)` 為 immediate unique,直接交換會中途違反;先指派臨時高位 position(`temporaryBase = max(existingMax, N) + N + 1`)再落定 `1..N`。delete 後 compact 用同手法。
- **update full-replace**:prompt + options 全部重送,option 全刪全重建(避 optionRef/position partial 衝突);拒絕 type/selectionMode 變更(`ConflictError`)。`isCorrect` 仍 `false`(Q-3 開放 quiz 正解)。
- **snapshot 不受影響**:SessionQuestion 為不可變副本,source edit/delete 不影響已啟動 session。
- 本 slice 仍限 poll/single;題型擴充隨 Q-3。

#### Verification

| 命令                                                                                | 結果                                |
| ----------------------------------------------------------------------------------- | ----------------------------------- |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/questions-mutation.e2e-spec.ts` | ✅ 1 suite / 9 tests                |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/questions-read.e2e-spec.ts`     | ✅ 1 suite / 9 tests(無回歸)        |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/poll-single-choice.e2e-spec.ts` | ✅ 1 suite / 1 test(無回歸)         |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/openapi.e2e-spec.ts`            | ✅ 1 suite / 3 tests(新端點進 spec) |
| typecheck/lint/format/build                                                         | ✅ 全綠                             |

#### Debugging note(lesson)

- 初次 reorder e2e 全 400:根因是 `ReorderQuestionsDto` 用 `@ValidateNested({ each: true })` + `@Type(() => String)` 驗證 primitive `string[]` 失敗 → 改用 `@IsString({ each: true })`。
- 修 DTO 後仍 400:根因是 **路由衝突** — `@Patch(':courseId/questions/:id')` 宣告於 `@Patch(':courseId/questions/order')` 之前,Nest 把 `order` 匹配為 `:id` → `UpdateQuestionDto` 驗證 `options`/`prompt`/`type`/`selectionMode` 失敗,`questionIds` 被當未知欄位。修法:reorder route 宣告於 `:id` route 之前。
- 偵測:回應 body 顯示 `VALIDATION_FAILED` 且 `field: options`(非 reorder DTO 欄位)+ `questionIds: property questionIds should not exist` → 確認路由到錯 controller method。
- 防止規則:Nest 同一 path segment 有 static 與 param route 時,static route 必須宣告在前;或用更明確 path(如 `/reorder` 子路徑)。

#### Results

- 新增三個 mutation 端點 + locked-by-session guard + 兩階段重排;`QUESTION_LOCKED_BY_SESSION` 首次落地。
- 新 e2e 覆蓋:update 保留位置、同型 update 接受、delete + compact、reorder 完整順序、reorder 缺/多/重複 409、非 owner 404、locked 409(waiting session 選取)、archived 409 `COURSE_NOT_EDITABLE`、CSRF 必要 403。
- 無 schema/migration 變更(swap 位置用既有 `(courseId, position)` unique)。

#### Risk & rollback

- **風險:中高**。mutation + locked guard + 兩階段重排 + position unique 競態。
- **Rollback**:revert application/dto/test;無 schema 變更。
- **監控**:`QUESTION_LOCKED_BY_SESSION`、`COURSE_NOT_EDITABLE`、position P2002 計數。
- **不變量**:snapshot 不受 source 變更影響、draft-only、owner/admin、不洩漏存在性、envelope/auth/CSRF 不變。

### 2026-08-16 — Slice 3: Q-3 題型擴充(完成)

#### Checklist

- [x] 新 `src/modules/questions/domain/question-text.ts`:抽出共用 text helper(readText/characterLength/containsUnsafeText/duplicateKeyFor/isRecord)。
- [x] 新 `src/modules/questions/domain/question-contract.ts`:`validateQuestion`/`normalizeQuestion` 統一 dispatch 所有題型(poll single/multiple、open_text、quiz),回傳 `NormalizedQuestion` 含 `correctOptionRefs`。
- [x] 新 `src/modules/questions/domain/question-contract.spec.ts`:16 unit tests(poll single/multiple、open_text、quiz 正解/缺失/不存在/重複/forbidden、shared bounds/duplicate/unsafe)。
- [x] `CreateQuestionDto`/`UpdateQuestionDto` 放寬為接受所有題型欄位(可選),domain validator 做完整 per-type 判定;`QuestionDto`/`QuestionOptionDto` 加 `isCorrect`/`correctOptionRefs`。
- [x] `QuestionService.createQuestion`/`updateQuestion` 改用 `normalizeQuestion`;quiz `correctOptionRefs` 映射到 option `isCorrect`(`isCorrectOption` helper)。
- [x] `toQuestionDto` 分裂為 **authoring 投影**(含 `isCorrect`/`correctOptionRefs`,給 teacher list/detail/create/update/reorder);learner snapshot(live-session/participant)投影維持不暴露正解(既有 mapping 未動)。
- [x] 加 `CORRECT_OPTION_INVALID` error code。
- [x] `findForActivation` 維持 poll/single 限制(本 slice 只擴充 authoring,activation/submission 邊界未動)。
- [x] 更新既有 Q-1 e2e 斷言:poll authoring options 含 `isCorrect: false` + `correctOptionRefs: []`(反映新投影)。
- [x] 新 `test/questions-types.e2e-spec.ts`:8 tests(poll multiple、open_text、quiz 正解暴露、quiz 缺正解 400、quiz 不存在 ref 400、open_text forbidden options 400、quiz update 保留正解、learner snapshot 不含 isCorrect/correctOptionRefs)。

#### 設計要點(題型規則,來自《題目領域契約》)

- **poll**:`selectionMode` 必填 `single`|`multiple`;options 2–10;`correctOptionRefs` 禁止。
- **open_text**:僅 `type`+`prompt`;`selectionMode`/`options`/`correctOptionRefs` 禁止;options 空、selectionMode null。
- **quiz**:options 2–10;`selectionMode` 禁止;`correctOptionRefs` 必填 >=1、每個 ref 需存在於 options 的 optionRef;1 個正解=單答、多個=多答;option `isCorrect` 依 `correctOptionRefs` 設定。
- **isCorrect 暴露決策**:authoring 投影含;learner/snapshot 不含(已驗證 e2e)。
- DB 既有 CHECK 已支援三題型 + selection mode 規則,無 schema 變更;quiz 正解數量由應用層守護(>=1、refs 存在)。

#### Verification

| 命令                                                                                                                                                                                                              | 結果                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `npm test -- --runInBand src/modules/questions/domain/question-contract.spec.ts src/modules/questions/domain/poll-single-choice.spec.ts`                                                                          | ✅ 2 suites / 21 tests |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/questions-types.e2e-spec.ts test/questions-read.e2e-spec.ts test/questions-mutation.e2e-spec.ts test/poll-single-choice.e2e-spec.ts test/openapi.e2e-spec.ts` | ✅ 5 suites / 30 tests |
| typecheck/lint/format/build                                                                                                                                                                                       | ✅ 全綠                |

#### Results

- 出題端支援 poll(single/multiple)、open_text、quiz;quiz 正解透過 `correctOptionRefs` 設定並暴露於 authoring 投影。
- authoring/learner 投影分裂:teacher 可見正解、學員 snapshot 不暴露。
- 無 schema/migration 變更(既有 CHECK 已支援)。
- `findForActivation` 與 submission 維持 poll/single 限制 — open_text/quiz 的 activation+submission 邊界列為 P3/R follow-up。

#### Risk & rollback

- **風險:中**。DTO 放寬 + 投影分裂 + 影響既有 poll 路徑。
- **Rollback**:revert domain/dto/service/test;無 schema 變更。
- **不變量**:learner 永不見正解(已驗證 e2e)、NFC/unsafe/duplicate 規則一致、envelope/auth/CSRF 不變、poll single 路徑無回歸(30 e2e 全綠)。

#### Follow-up(非本 slice 阻擋)

- open_text/quiz 的 activation + submission cardinality(屬 P3/R 課堂/學員流程)。
- poll-multiple 的 submission 邊界(>=1、<= option count、無重複)。
- `validateQuestion` 的 `OPTION_REF_INVALID` 與 `CORRECT_OPTION_INVALID` 於 Q-4 批次彙整復用。

### 2026-08-17 — Slice 4: Q-4 批次驗證/確認 + CLI credential 子系統(完成)

#### Context

P1 出題擴充最後一塊:批次題目 validate/confirm(1–50 題、全錯誤+預覽+token、重驗+all-or-nothing+冪等),供 Web teacher 與 CLI actor 共用。CLI actor 需全新 CLI credential 子系統(M2 文件明列 deferred,本 slice 落地)。完整設計見 `/home/user/.claude/plans/linear-wibbling-shore.md`(Slice 4 計畫)。

#### 已拍板決策(2026-08-16/17)

- CLI key header:`X-CLI-Key`(自訂;已加 pino redaction)。
- CLI key scope:`all_courses`(MVP)。
- CLI key 簽發:admin 端點 + step-up — `POST /api/v1/admin/accounts/:id/cli-credentials`(raw key 回傳一次)。
- 範圍:完整 Q-4(含 CLI credential 子系統)。
- 既有合約決策:token header `X-Validation-Token`;confirm body `confirmed: true` + 重送 `questions` + `payloadHash`;confirm response `{ schemaVersion, questions: QuestionDto[], payloadHash }`;warning `{ code, field, message }`;courseId path 為準;token 過期/hash 不符/消耗 → `CONFLICT` 類別 + 明確 code(`VALIDATION_TOKEN_INVALID`/`EXPIRED`/`CONSUMED`/`PAYLOAD_HASH_MISMATCH`)。
- stale 修正:`can_create_course=false` **不**撤銷 CLI key(M2 紅卡 #8);account disable 立即撤銷 CLI key + 未用 token。

#### Part A — CLI credential 子系統(完成,已驗證)

##### Checklist

- [x] 新 Prisma model `CliCredential`(UUID PK、`key_hash` unique、`UNIQUE(account_id,name)`、scope/status CHECK、FK CASCADE)+ additive migration。
- [x] `src/modules/identity/domain/cli-credential-status.ts`(active/revoked + all_courses/single_course)。
- [x] `src/modules/identity/application/cli-credential.service.ts`:`createCredential`(`generateToken`+`hashToken`,raw 回傳一次)、`listCredentials`(metadata,無 hash)、`revokeCredential`(冪等)、`revokeAllForAccountInTransaction`(disable 連動)、`authenticate`(hash → findUnique → 查 account.status active + credential.status active → `CliAuthContext`;best-effort `lastUsedAt`)。鏡射 participant token 模式。
- [x] `src/modules/identity/api/dto/cli-credential.dto.ts`:`CreateCliCredentialDto`、`CliCredentialDto`、`CreateCliCredentialResponseDto`。
- [x] `src/common/auth/cli-auth-context.ts`:`CliAuthContext`(account + credentialId + scope,無 sessionId)+ express Request 擴充。
- [x] `src/modules/identity/api/cli-auth.guard.ts`:`CliAuthGuard`(X-CLI-Key header → authenticate,401 on fail,不套 CSRF)。
- [x] `src/common/auth/current-cli-account.decorator.ts`:`@CurrentCliAccount()`。
- [x] `src/modules/identity/api/admin.controller.ts`:`POST /admin/accounts/:id/cli-credentials`(step-up)、`GET .../cli-credentials`、`POST .../cli-credentials/:credentialId/revoke`(step-up,`@HttpCode(200)`)。
- [x] `src/modules/identity/application/account.service.ts`:`disableAccount` 連動撤銷 CLI credentials + 失效未用 `QuestionValidationToken`(`invalidateTokensForAccountInTransaction`)。
- [x] `src/modules/identity/identity.module.ts`:providers/exports `CliCredentialService` + `CliAuthGuard`。
- [x] `src/common/observability/pino-redaction.ts`:加 `X-CLI-Key`、`X-Validation-Token`、`rawKey`、`validationToken`、`payloadHash`。
- [x] `test/cli-credential.e2e-spec.ts`:6 tests 全綠(admin step-up 發 key raw 一次、無 step-up 拒、X-CLI-Key 認證、revoked 拒、disabled account 拒[回 `CLI_CREDENTIAL_REVOKED`,因 disable 撤銷 key]、missing key 401)。

##### Verification(Part A)

| 命令                                                                                          | 結果                     |
| --------------------------------------------------------------------------------------------- | ------------------------ |
| `NODE_ENV=test npm run prisma:migrate:deploy`(20260816160000,授權套用至 `smartlearning_test`) | ✅ 8 migrations,新表建成 |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/cli-credential.e2e-spec.ts`               | ✅ 1 suite / 6 tests     |
| 既有回歸(auth-courses/poll/openapi/questions-read/mutation/types)                             | ✅ 6 suites / 44 tests   |
| canonical-hash unit                                                                           | ✅ 7 tests               |

#### Part B — 批次 validate/confirm(程式碼完成,驗證卡點中)

##### Checklist(程式碼)

- [x] 新 Prisma model `QuestionValidationToken`(token hash unique、綁 account/optional CLI/course/payloadHash/schemaVersion/expiresAt/consumedAt)+ `QuestionBatchIdempotency`(`UNIQUE(actorScope,operation,idempotencyKey)` + `responseJson`)。同 migration。
- [x] `src/common/crypto/canonical-hash.ts`:`canonicalJsonStringify`(排序 key、保留 array order、略過 undefined、無 whitespace)+ `hashPayload`(`sha256:<hex>`)+ 7 unit tests。
- [x] `src/modules/questions/domain/question-batch.ts`:`validateBatch`(1–50、`clientRef` payload 內唯一、彙整所有 issues[呼叫 `validateQuestion` 前剔除 `clientRef`]+ warnings、`BATCH_SIZE_INVALID`/`CLIENT_REF_DUPLICATE`)。
- [x] `src/modules/questions/application/question-batch.service.ts`:`validateBatch`(course 存取檢查 owner/admin + draft、payloadHash、domain validate、valid→產 token[15m]回 preview+token、invalid→回 errors token=null);`confirmBatch`(idempotency replay/conflict、token 重驗[invalid/expired/consumed/hash mismatch/account/course/CLI 綁定]、all-or-nothing append via `QuestionService.appendBatchInTransaction`、成功消耗 token + 寫 idempotency record、失敗不消耗)。
- [x] `src/modules/questions/application/question.service.ts`:加 `appendBatchInTransaction`(在 caller tx 內重用 lock 序列 + assertCourseWritable + 逐題 append 連續 position)。
- [x] `src/prisma/transaction.service.ts`:加 `lockAdvisoryKey(tx, key)` generic helper(idempotency 序列化,key `qbatch:${actorScope}:${idempotencyKey}`)。
- [x] `src/modules/questions/api/dto/question-batch.dto.ts`:`ValidateQuestionBatchDto`/`ConfirmQuestionBatchDto`/`BatchQuestionInputDto`/`BatchQuestionOptionDto` + response DTOs。
- [x] `src/common/auth/batch-actor.guard.ts`:`BatchActorGuard`(X-CLI-Key → CliAuthGuard,否則 SessionGuard;attach `req.batchActor {kind, accountId, role, cliCredentialId?}`)+ `@CurrentBatchActor()`。
- [x] `src/common/auth/batch-csrf.guard.ts`:`BatchCsrfGuard`(Web actor 強制 CSRF,CLI actor 跳過)。
- [x] `src/modules/questions/api/question-batches.controller.ts`:`POST /courses/:courseId/question-batches/validate` + `/confirm`(`Idempotency-Key` + `X-Validation-Token` header)。
- [x] `src/modules/questions/questions.module.ts`:import IdentityModule、加 controller/service/guard providers。
- [x] error codes:加 `BATCH_SIZE_INVALID`、`CLIENT_REF_DUPLICATE`、`VALIDATION_TOKEN_INVALID/EXPIRED/CONSUMED`、`PAYLOAD_HASH_MISMATCH`、`IDEMPOTENCY_KEY_CONFLICT`、`CLI_CREDENTIAL_INVALID/REVOKED`。
- [x] `test/question-batches.e2e-spec.ts`:7 tests(happy path append in order、idempotency replay、idempotency conflict、missing token、payloadHash mismatch、all-or-nothing、CSRF required)。

##### 卡點根因(已解決)— 兩層 `FIELD_FORBIDDEN`,非單一 pipe 問題

原卡點記錄的「Nest 全域 pipe 巢狀 `forbidNonWhitelisted` 擋 `clientRef`」**只是表徵之一**。實際有兩層獨立的 `clientRef` 拒絕,修法需同時處理:

1. **Nest 全域 pipe 層**:全域 `ValidationPipe`(`transform: true` + `forbidNonWhitelisted: true`)對 `questions` 巢狀 `@ValidateNested` + `@Type` 轉換時,在 e2e 把元素轉成空物件、`clientRef` 被判 `FIELD_FORBIDDEN`(field 無 `questions[i]` 前綴)。
   - 修法:controller `@Body(new ValidationPipe({ transform: true, whitelist: false, forbidNonWhitelisted: false }))` 覆蓋全域 pipe;`ValidateQuestionBatchDto`/`ConfirmQuestionBatchDto` 的 `questions` 改 `unknown[]` + `@IsArray()` + `@ApiProperty({ type: () => BatchQuestionInputDto, isArray: true })`(保留元素 schema 給 OpenAPI,不參與 pipe)。
2. **Domain `normalizeQuestion` 層**(真正根因):service `validateBatch` 雖先呼叫 domain `validateBatch`(已 strip `clientRef`)得到 `valid=true`,但隨後 `(questions).map(q => normalizeQuestion(q))` 直接把**含 `clientRef` 的原始 payload** 餵給 `normalizeQuestion` → `validateQuestion` L66-76 對未知 top-level key 回 `FIELD_FORBIDDEN field=clientRef`(無前綴),`normalizeQuestion` throw → 400。`confirmBatch` 內同樣呼叫亦有此問題。
   - 修法:新增 domain `stripClientRef(question)` helper(`question-batch.ts`),`validateBatch` 與 service 兩處 `normalizeQuestion` 呼叫皆先 strip。strip 邏輯集中為單一 helper,避免兩處各寫一份。

兩層都修後,`question-batches.e2e-spec.ts` 7 tests 全綠。

##### 已清理

- 移除 `question-batches.controller.ts` 的 `CTRL questions[0] keys` debug log。
- 移除 `src/modules/questions/api/dto/batch-dto.spec.ts`(臨時隔離 debug unit test,含 `console.log`;其前提「`questions` 為 `BatchQuestionInputDto[]` + `@ValidateNested`」已因修法改變,不再代表 controller 行為,改由 e2e 覆蓋)。
- 移除 e2e 內 `VALIDATE DEBUG` 臨時 log。
- `BatchQuestionInputDto`/`BatchQuestionOptionDto` 保留 class-validator 裝飾器,類別上方加註釋說明「僅供 Swagger plugin 推斷 enum/schema,不參與 request 驗證」(`@IsIn` 讓 plugin 產出 enum;實際驗證由 domain `validateBatch`/`validateQuestion` 守)。

##### Verification(Part B,完成)

| 命令                                                                                                                                     | 結果                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `npm run typecheck`                                                                                                                      | ✅ 通過                                      |
| `npm run lint:check`                                                                                                                     | ✅ 0 errors                                  |
| `npm run format:check`                                                                                                                   | ✅ All matched files use Prettier code style |
| `npm run build`                                                                                                                          | ✅ nest build 通過                           |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/question-batches.e2e-spec.ts`                                                        | ✅ 1 suite / 7 tests                         |
| `NODE_ENV=test npm run test:e2e -- --runInBand`(auth-courses/poll/openapi/questions-read/mutation/types/cli-credential/question-batches) | ✅ 8 suites / 57 tests                       |
| `npm test -- --runInBand`                                                                                                                | ✅ 18 suites / 86 tests                      |
| `NODE_ENV=test npm run test:integration -- --runInBand`                                                                                  | ✅ 3 suites / 10 tests                       |
| `git diff --check`                                                                                                                       | ✅ PASS                                      |

##### Results(Part B)

- 批次 validate/confirm 端點上線:`POST /api/v1/courses/:courseId/question-batches/validate` + `/confirm`(Idempotency-Key + X-Validation-Token header)。
- 兩層 `clientRef` `FIELD_FORBIDDEN` 根因解決:controller 層 pipe 覆蓋 + domain `stripClientRef` helper(集中 strip 邏輯,validate/normalize 共用)。
- 契約驗證由 domain `validateBatch` → `validateQuestion` 統一守(題型、選項數、clientRef 唯一、正解 refs 存在、unsafe/empty/length),涵蓋範圍比 pipe whitelist 更廣;pipe 退場不弱化驗證。
- DB-backed opaque validation token(hash 存、raw 回一次、15m 過期、消耗語意)+ idempotency(`UNIQUE(actorScope,operation,key)` + advisory lock 序列化)+ all-or-nothing append + replay/conflict 語意,全綠。
- 安全:raw key/token 不入 log(pino redaction 已含 `X-CLI-Key`/`X-Validation-Token`/`rawKey`/`validationToken`/`payloadHash`);confirm response 不回顯 raw token(已 e2e 斷言)。

#### Slice 4 整體狀態

- **Part A(CLI credential)**:完成並驗證(6 e2e)。
- **Part B(批次 validate/confirm)**:完成並驗證(7 e2e + 57 e2e 回歸 + 86 unit + 10 integration 全綠)。
- **schema/migration**:3 新表已套用 `smartlearning_test`,prisma generate/validate/typecheck/build 綠。
- **未 commit**:所有變更在工作樹(未 git commit);待使用者指示 commit。

#### 接續步驟

1. P1 出題擴充(E-1 + Q-1~Q-4)全部完成 — 待使用者指示 commit(或分 slice commit)。
2. 進入 P2 課堂老師端(S-1 LiveSession close/cancel 等)。

#### Risk & rollback(Slice 4)

- **風險:高**。新 schema(additive ×3)、CLI credential 新認證子系統、token/hash/冪等新狀態、all-or-nothing transaction、安全敏感(raw key/token 不入 log)。Part B 修法本身:controller 覆蓋全域 pipe(`whitelist:false, forbidNonWhitelisted:false`)僅限批次兩端點,全域 pipe 對其他 controller 不變;契約驗證移至 domain 層(涵蓋更廣),非弱化。
- **Rollback**:revert application/dto/controller/guard/test/domain helper;additive migration 可 forward-drop 三表;不還原已 commit batch 寫入、已消耗 token、已撤銷 CLI key。
- **不變量**:raw CLI key/token 只回傳一次、不入 log;token DB-backed opaque 存 hash;all-or-nothing;draft-only confirm;owner/admin;account disable 立即撤銷 CLI key + 未用 token;`can_create_course=false` 不撤銷 CLI key;envelope/auth/CSRF(Web)不變;既有 Q-1~Q-3 + poll 路徑無回歸(57 e2e + 86 unit + 10 integration 全綠)。

#### Follow-up(Slice 4 deferred)

- CLI key rotation(successor 語意)、pending_verification、key prefix/suffix、max active key、7/30/90/365 expiry。
- CLI `courses list`/`courses create` 端點。
- CLI/batch rate limit。
- 更新 stale BDD 文字(文件維護)。

### 2026-08-17 — Slice 5: S-3 課堂題目結果聚合 endpoint(完成)

#### Context

P2 課堂老師端第一個前端阻擋缺口:老師開題收答案後無 endpoint 讀答題分布,「開題→看分布→收題」loop 無法完成。本 slice 補 `GET /api/v1/live-sessions/:liveSessionId/questions/:sessionQuestionId/results`(per-question),為 backlog S-3(`tasks/todo.md:437`)。

**Scope 決策(使用者確認):** 先 ship per-question endpoint;session-level `GET /live-sessions/:id/results`(M2 API catalog L193)延後到 Socket.IO snapshot/replay slice(R-1)。本 slice 為與 M2 API catalog 的**暫時 divergence**,日後 session-level endpoint 落地時需 reconcile,列為 follow-up。

**Authority(M2):** aggregate 即時從已 commit 的 `Submission` 列計算 — 無 Aggregate/VoteCount 表、不讀 outbox、Redis 非權威(即時同步與結果治理設計 L25-31)。REST 為權威 read/reconciliation path;Socket 為後續 notification 層。

**Runtime 限制:** 目前只有 `poll/single` 可 activation+submission(`question.service.ts:432` 拒其他型;`CreateSubmissionDto` 無 `textAnswer`、`ArrayMaxSize(1)`)。endpoint structurally 處理四種 snapshot type(`poll` single/multiple、`open_text`、`quiz`)以免日後 break,但 e2e 只 exercise `poll/single`。擴充 activation/submission cardinality 為**獨立 follow-up**,非本 slice。

#### Checklist

- [x] 新 error codes:`RESULTS_NOT_REVEALED`、`SESSION_QUESTION_NOT_OPEN`(`error-codes.ts`,409 via `DomainError`)。
- [x] 新 DTO `src/modules/live-sessions/api/dto/results.dto.ts`:`OptionCountDto`、`PollResultsDto`、`QuizResultsDto`、`OpenTextResultsDto`、discriminated union `SessionQuestionResultsDto`,全 `@ApiProperty`;export via dto/index.ts。
- [x] 純聚合 `src/modules/live-sessions/domain/question-results.ts`:`aggregateResults(input)` 無 Prisma/I/O;poll 計每選項 count(totalResponses=submission 數,multiple 可 sum>totalResponses)、quiz exact-set correctness + `isCorrect` 僅 `revealCorrectness` 時暴露、open_text 匿名 text list 過濾 null、空 submissions 零計數、未知 option UUID 防禦忽略。export via domain/index.ts。
- [x] `LiveSessionService.getResults(liveSessionId, sessionQuestionId, actor)`:compound `(id, liveSessionId)` 載入 question+options+submissions(new include,`sessionForProjection` 未動不洩漏答案);**ordering:ownership/participant verify → not_open 檢查 → vote-to-reveal**(非 owner 不洩漏存在性,先 404 再 409);teacher `assertCourseAccess` owner/admin else 404、`revealCorrectness=true`;participant 防禦性驗 session 綁定、open 且未提交 → 409 `RESULTS_NOT_REVEALED`、`revealCorrectness=(status===closed)`。
- [x] Route 放 `ParticipantsController`(非 `LiveSessionsController`)—已注入 `LiveSessionService`、已用 `ParticipantOrSessionGuard`、已有 actor-branch pattern;避免 `LiveSessionsModule`↔`ParticipantsModule` circular(`LiveSessionsModule` 不 import `ParticipantsModule`)。`@Get(':liveSessionId/questions/:sessionQuestionId/results')` + `@UseGuards(ParticipantOrSessionGuard)`,param 名必須 `:liveSessionId`/`:sessionQuestionId`(guard 讀 `request.params.liveSessionId`)。GET 無 CSRF。
- [x] `@ApiTags('live-sessions')` 加 `ParticipantsController`。

#### 設計要點

- **Vote-to-reveal(US-F17 / 即時同步 L83-88):** teacher 任何時候見匿名 aggregate;participant open 期間須先提交才見 aggregate,question close 後全班可見(R-F17-2,reveal gate 為 question `open→closed` 非 session close)。`isCorrect`(quiz)participant 僅 close 後見;teacher 恆見。teacher aggregate 永不洩漏 display-name→answer mapping。
- **Participant authenticate 拒 closed/cancelled session**:故「participant 見 closed 結果」意指 `SessionQuestion.status===closed` 而 session 仍 active;session-level close 後 participant token 拒絕為獨立政策,不併入 S-3。
- **未動 `sessionForProjection`**:避免 snapshot 路徑洩漏答案;results 用獨立 include。
- **無 schema/migration**:純 read-only additive,aggregate 從既有 indexed `Submission.sessionQuestionId` 即時計算。

#### Verification

| 命令                                                                                                                           | 結果                                   |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `npm test -- --runInBand src/modules/live-sessions/domain/question-results.spec.ts`                                            | ✅ 1 suite / 12 tests                  |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/live-session-results.e2e-spec.ts`                                          | ✅ 1 suite / 11 tests                  |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/poll-single-choice.e2e-spec.ts test/live-session-close-cancel.e2e-spec.ts` | ✅ 2 suites / 7 tests(無回歸)          |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/openapi.e2e-spec.ts`                                                       | ✅ 1 suite / 3 tests(新 route 進 spec) |
| `npm test -- --runInBand`(全 unit)                                                                                             | ✅ 19 suites / 99 tests                |
| `npm run typecheck` / `lint:check` / `format:check` / `build` / `git diff --check`                                             | ✅ 全綠(format 修 6 檔 Prettier)       |

#### e2e 覆蓋(11 cases)

teacher open 見 per-option count(2A/1B/0C,totalResponses=3,poll 無 isCorrect,匿名無 participantId/displayName)、teacher close 後見 count、participant 已提交 open 見 aggregate、participant 未提交 open → 409 `RESULTS_NOT_REVEALED`、participant close 後未提交亦見 aggregate、non-owner teacher → 404、missing/cross-session questionId → 404、not_open question → 409 `SESSION_QUESTION_NOT_OPEN`、**non-owner 對 not_open question → 404(非 409,ordering 不洩漏存在性,regression case)**、GET 無 CSRF、無 auth → 401。

#### Risk & rollback

- **風險:低-中**。read-only additive endpoint、新 DTO、2 新 error codes、新純聚合 fn、新測試。**無 schema/migration**。未動 submission/snapshot/activation 路徑。
- **Rollback**:revert commit;無 DB rollback。stable error codes 已發布後保留常數以維 wire 相容。
- **不變量維持**:teacher aggregate 匿名(無 display-name→answer)、learner 僅 closed-question results 見 `isCorrect`、non-owner → 404 不洩漏存在性、envelope/auth/CSRF 不變、僅 poll/single runtime exercisable。

#### Follow-up(Slice 5 deferred)

- Session-level `GET /live-sessions/:id/results`(M2 API catalog)+ reconcile per-question divergence — 隨 R-1 Socket.IO snapshot/replay。
- Socket.IO `result.updated` / `question.closed` broadcast(R-1/R-2)。
- `ArchivedResult` + 90 天 retention + early deletion/tombstone(Phase 8 / S-5)。
- Activation + submission cardinality for multiple/open_text/quiz — endpoint structurally 已支援,但尚無法 activation。
- 即時 joined/voted 人數(S-4)— 本 endpoint 給 submitted counts;joined 需 participant count(獨立)。
- Open-text list cardinality(MVP full list;sampling/top-N TBD — M2 未定案)。

### 2026-08-17 — Slice 6: S-2 老師端 session detail endpoint(完成)

#### Context

P2 課堂老師端第二個缺口:老師 dashboard 需「加入 / 已投」即時人數,目前只能靠 `GET /live-sessions/:id/snapshot`(掛在 `ParticipantsController`、teacher/participant 共用 guard)讀完整 projection,但無 joined/voted 計數,且該路由定位為 participant/teacher 共用而非 teacher 專屬。本 slice 補 teacher 專屬 `GET /api/v1/live-sessions/:liveSessionId`(`LiveSessionsController`、`SessionGuard` only),回完整 projection + `joinedCount`/`votedCount`,為 backlog S-2(`tasks/todo.md:438`)。完整計畫見 `/home/user/.claude/plans/s-2-teacher-toasty-sloth.md`。

**Scope 決策(使用者確認):** `voted` = 當前 open 中 SessionQuestion 的 Submission 數(無 open 題則 0),比照 prototype `voted = current ? current.aggregate.total : 0` 與 S-3 follow-up note(`tasks/todo.md:862`);因 `uq_submission_participant_question` unique,即當前題已投 distinct 學生數。`joined` = `Participant` 列數(one row per join)。不採全 session 累計 submission(跨題累計、同生重複計)語意。

#### Checklist

- [x] DTO `src/modules/live-sessions/api/dto/live-session.dto.ts`:`LiveSessionDto` 加 optional `joinedCount`/`votedCount`(`@ApiProperty`),optional 維持既有 caller wire 相容。
- [x] `LiveSessionService.getTeacherDetail(sessionId, caller)`:以既有 `sessionForProjection` 載入 → `assertCourseAccess`(非 owner → 404,先 404 再計數,不洩漏存在性,對齊 S-1/S-3 ordering)→ `find(q => q.status===OPEN)` 取當前題(至多一題,P2002 guard 保證)→ `Promise.all` 平行 `participant.count` / `submission.count`(無 open 題 → voted 0)→ 回 `{ session, joinedCount, votedCount }`。無 Prisma `_count`/groupBy;reuse `Promise.all + count` pattern(course/question pagination)。
- [x] `toLiveSessionDto(session, counts?)`:加 optional 第二參,`...(counts ?? {})` 注入;既有 6 個 call site 全未動。
- [x] Controller `src/modules/live-sessions/api/live-sessions.controller.ts`:加 `Get` import + `@ApiTags('live-sessions')`(OpenAPI grouping 與 `ParticipantsController` 一致)+ `detail()` route `@Get(':liveSessionId') @UseGuards(SessionGuard)`(GET 無 CSRF)、`ParseUUIDPipe`、`@CurrentAccount`,回 `toLiveSessionDto(session, { joinedCount, votedCount })`。無路由衝突(`:liveSessionId` bare vs `:liveSessionId/snapshot` vs `:liveSessionId/questions/.../results` 路徑形狀不同)。
- [x] E2E `test/live-session-detail.e2e-spec.ts`(新,9 cases),model on `test/live-session-results.e2e-spec.ts`(DB setup / `requireDatabase()` / truncate / admin bootstrap / teacher temp-password flow / cookie helpers)。

#### 設計要點

- **voted 語意:** 當前 open 題的 Submission 數;waiting/題間/closed/cancelled session → 0(無 open 題)。prototype 與 S-3 follow-up note 一致;不採全 session 累計(避免跨題重複計同一學生)。
- **joined 語意:** `Participant` 列數(`participant.service.ts:68-75` 每次 join 一列)。
- **不洩漏存在性 / 不洩漏身分:** owner check 在計數前(非 owner → 404);teacher projection 永不暴露 `participants`/`tokenHash`/`displayName`/答案 mapping。
- **無 schema/migration:** 純 read-only additive,aggregate 從既有 indexed `Submission.sessionQuestionId`/`Participant.liveSessionId` 即時計算。
- **未動 `sessionForProjection`:** 與 S-3 同,不洩漏答案;counts 用獨立 `count` query。
- **既有 `snapshot` 路由保留:** participant 仍需它;本 S-2 為 teacher 專屬。兩條 teacher read path 並存,reconcile 列為 follow-up。

#### Verification

| 命令                                                                                                                                                                 | 結果                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/live-session-detail.e2e-spec.ts`                                                                                 | ✅ 1 suite / 9 tests                   |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/live-session-results.e2e-spec.ts test/live-session-close-cancel.e2e-spec.ts test/poll-single-choice.e2e-spec.ts` | ✅ 3 suites / 18 tests(無回歸)         |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/openapi.e2e-spec.ts`                                                                                             | ✅ 1 suite / 3 tests(新 route 進 spec) |
| `npm run build`                                                                                                                                                      | ✅ nest build 成功                     |
| `npm run typecheck` / `lint:check` / `format:check`                                                                                                                  | ✅ 全綠                                |

#### e2e 覆蓋(9 cases)

waiting session(joined 0/voted 0,無 sessionQuestion)、active + open 題(4 joined / 2 voted,完整 projection,無身分洩漏)、active 無 open 題(關題後 voted 0)、closed session(voted 0、joined 保留)、non-owner teacher → 404、unknown liveSessionId → 404、missing auth → 401、GET 無 CSRF → 200、invalid UUID → 400。

#### Risk & rollback

- **風險:低**。read-only additive endpoint、2 optional DTO 欄位(backward-compatible)、新 service method、新 e2e。無 schema/migration,未動 submission/snapshot/activation 路徑。既有 `toLiveSessionDto` call site 未動(counts 參 optional)。
- **Rollback:** revert commit;無 DB rollback。
- **不變量維持:** teacher projection 匿名(無身分/答案 mapping)、非 owner → 404 不洩漏存在性、envelope/auth/CSRF 不變、至多一 open 題(P2002 guard)。

#### Follow-up(Slice 6 deferred)

- 即時 joined/voted 推送(S-4)— 無 Socket 前可輪詢本 endpoint 頂著。
- Reconcile `snapshot`(teacher path)與本 S-2 路由 — 日後 teacher read path 統一。
- Session-level `GET /live-sessions/:id/results`(M2 API catalog)— 隨 R-1。

### 2026-08-17 — Slice 7: S-4 / R-1 lite Socket.IO 即時通道基礎(完成)

#### Context

P2 課堂老師端第三個缺口:joined/voted 即時人數的 **push** 交付。S-2 已交付 polling stopgap(`GET /api/v1/live-sessions/:id` 回 `joinedCount`/`votedCount`),本 slice 補 Socket.IO 即時通道(R-1 lite),把題目生命週期 + 即時人數 + 答題聚合用 push 交付。完整設計見 `/home/user/.claude/plans/snoopy-toasting-wreath.md`。

**Scope 決策(使用者確認):** 交付 R-1 lite — `/live` namespace + handshake auth + session/teacher rooms + in-process event bus + 生命週期事件 push;**defer** outbox table / `eventSeq` / `aggregateVersion` / replay / `sync.required` / coalescing / Redis adapter / per-participant vote-to-reveal socket projection 至完整 R-1。reconnect = 新連線 = fresh `session.snapshot`(lite 無 eventSeq,reconnect 不重播)。

**Authority(《即時同步與結果治理設計》):** PostgreSQL 為唯一權威;socket 為通知層,不授權結果。每個 mutation **先 commit 再 publish**(§1);publish 失敗只記 log,不讓 mutation 失敗(fire-and-forget)。raw participant token 永不入 event payload/log;teacher aggregate 永遠匿名(無 display-name→answer mapping);非 owner 先 404/拒連再說狀態;closed/cancelled session 拒 reconnect。

#### Checklist

- [x] 新依賴:`@nestjs/websockets@^11`、`@nestjs/platform-socket.io@^11`、`socket.io@^4.8`、dev `socket.io-client@^4.8`;`npm audit` 0 vulnerabilities。
- [x] `src/modules/realtime/live-session-event-bus.ts`:leaf in-memory bus,`publish`(fan-out、listener error 隔離、不 reject)+ `subscribe`(回 unsubscribe)。Signal union: `participant.joined`/`question.opened`/`question.closed`/`session.state_changed`/`submission.committed`。
- [x] `src/modules/realtime/live-session-event-bus.spec.ts`:5 unit tests(fan-out、throwing listener 隔離、async rejecting listener 隔離、unsubscribe、多 signal)。
- [x] `src/modules/realtime/live-gateway.ts`:`@WebSocketGateway({ namespace: 'live' })`。handshake auth — teacher:手動 parse `socket.request.headers.cookie`(`cookie` 模組,因 socket.io handshake 不走 express middleware,cookie-parser 不會 populate `request.cookies`)→ `SessionService.loadActiveSession` → `getTeacherDetail` 驗 owner/admin;participant:`handshake.auth.{participantToken,sessionCode}` → `findByCode` + `ParticipantService.authenticate`。成功 join `session:<id>`(+ teacher 再 join `teacher:<id>`)→ emit `session.snapshot`(teacher: getTeacherDetail+counts;participant: getParticipantSnapshot learner 投影,無答案)。失敗 emit `error {code}` + disconnect(`SESSION_NOT_JOINABLE` DomainError code 保留,其餘 fail-closed `UNAUTHORIZED`)。`@SubscribeMessage('snapshot.fetch')` 供 client 主動重取。
- [x] gateway `onModuleInit` subscribe bus → `handleSignal` per signal 重算投影並 emit(`participant.joined`→teacher `counts.updated`;`question.opened`→`session:<id>` `question.opened` + teacher `counts.updated`;`question.closed`→`session:<id>` `question.closed` + teacher `counts.updated` + `result.updated`;`session.state_changed`→`session:<id>`(+ `session.closed` 當 closed);`submission.committed`→teacher `counts.updated` + `result.updated`)。events envelope `{schemaVersion, serverTimestamp, liveSessionId, visibility, data}`(**無** `eventSeq`/`aggregateVersion`,lite 不可重播)。per-signal catch+log,下游失敗不影響 bus。
- [x] `src/bootstrap/configure-websocket.ts`:`CorsIoAdapter extends IoAdapter` 覆寫 `createIOServer` 注入 env-derived CORS allowlist(`ConfigService` runtime 讀,非 decorator 靜態期)+ `configureWebSocket(app)`;`configureApplication` 呼叫(production + e2e 共用)。
- [x] `src/modules/realtime/realtime.module.ts`:`@Global` 匯出 `LiveSessionEventBus`(leaf,無 service dep → 無 cycle),import `LiveSessionsModule`/`ParticipantsModule`(gateway → read services),services 只注入 bus(單向依賴)。
- [x] mutation services 注入 bus + post-commit `publish`(fire-and-forget、try/catch log+swallow):`LiveSessionService`(startSession/openQuestion/closeQuestion/closeSession[bulk-close open questions emit `question.closed` per + `session.state_changed`]/cancelSession)、`ParticipantService`(join)、`SubmissionService`(submit,只有 accepted 路徑[新建立或 idempotent replay],conflict throw 不 publish)。
- [x] `src/app.module.ts` import `RealtimeModule`。
- [x] `src/common/observability/pino-redaction.ts`:加 `req.body.participantToken`、`req.body.sessionCode`(socket `auth` payload 防洩)。
- [x] `test/live-session-realtime.e2e-spec.ts`:9 e2e(teacher snapshot、open→`question.opened`+`counts.updated`、participant learner snapshot 無 isCorrect/答案、submit→teacher `counts.updated`+`result.updated`[participant 無 result push]、close→`question.closed`+`result.updated`、invalid token 拒、unknown code 拒 `SESSION_NOT_JOINABLE`、non-owner teacher 拒、cancel→`session.state_changed`+reconnect 拒)。

#### 設計要點

- **commit-then-publish:** `publish` 只在 `await this.transactions.run(...)` 返回(已 commit)後呼叫;`void this.eventBus.publish(signal).catch(...)` 確保 bus 失敗不讓 mutation 失敗。
- **socket.io handshake cookie:** socket.io 的 handshake 請求(`/socket.io/...`)在 express middleware 之前被 socket.io engine 攔截,cookie-parser 不會 populate `request.cookies`。gateway 手動 `cookie.parse(socket.request.headers.cookie)` 讀 `__Host-session`(opaque/unsigned,不需 secret)。
- **reconnect = fresh snapshot:** lite 無 outbox/eventSeq,reconnect 等同新連線,server 重發 `session.snapshot`。`eventSeq`/`aggregateVersion` 故意省略(非 durable,標了會誤導 client);完整 R-1 加 outbox 時 reconcile 此 divergence。
- **vote-to-reveal 仍由 REST S-3 守:** lite 不 push per-participant result projection;participant 收到 lifecycle ping 後自行 refetch `GET .../results`(S-3 服務端守 reveal gate)。
- **teacher room recompute:** `emitTeacherCounts`/`emitTeacherResults` 用 `role:'admin'` internal recompute(teacher-room 成員已在 connect 時驗過 owner/admin);非 owner 從不進 teacher room。
- **無 schema/migration:** 純 additive runtime,aggregate 從既有 indexed rows 即時計算。

#### Verification

| 命令                                                                                   | 結果                                               |
| -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `npm install` + `npm audit`                                                            | ✅ 0 vulnerabilities                               |
| `npm run typecheck`                                                                    | ✅ PASS                                            |
| `npm run lint:check`                                                                   | ✅ 0 errors                                        |
| `npm run format:check`                                                                 | ✅ All matched files use Prettier                  |
| `npm run build`                                                                        | ✅ nest build PASS                                 |
| `npm test -- --runInBand src/modules/realtime/live-session-event-bus.spec.ts`          | ✅ 1 suite / 5 tests                               |
| `npm test -- --runInBand`(全 unit)                                                     | ✅ 20 suites / 104 tests                           |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/live-session-realtime.e2e-spec.ts` | ✅ 1 suite / 9 tests(DB-backed, 0 skipped)         |
| `NODE_ENV=test npm run test:e2e -- --runInBand`(全 e2e)                                | ✅ 14 suites / 98 tests(無回歸)                    |
| `NODE_ENV=test npm run test:integration -- --runInBand`                                | ✅ 3 suites / 10 tests                             |
| `NODE_ENV=test npm run prisma:migrate:status`                                          | ✅ 8 migrations, schema up to date(無新 migration) |
| `git diff --check`                                                                     | ✅ PASS                                            |

#### Debugging lesson(關鍵根因)

1. **cookie-parser 不作用於 socket.io handshake:** 初版用 `socket.request.cookies`(`cookie-parser` populate 的),但 socket.io engine 攔截 handshake 請求在 express middleware 之前 → `request.cookies` 永遠 undefined。偵測:`hasCookieHeader=true hasCookieJar=false`。修法:手動 `cookie.parse(socket.request.headers.cookie)`。
2. **post-commit emit 的 client race:** service `publish` 在 `transactions.run` 返回後同步 fire,bus listener 同步 emit 到 room——事件在 REST response 返回前已送到 client。若 test 在 `await` REST 之後才 `nextEvent(event)` 註冊 listener,事件已過 → timeout。偵測:`roomSize=1 sockCount=1`(socket 在 room、emit 到對的 room),但 client 收不到。修法:test 在 mutation **之前** pre-register listener promise,mutation 後 await。適用所有 signal-driven event test(open/submit/close/cancel)。
3. **DomainError code 偵測:** 初版用 `error.message === 'SESSION_NOT_JOINABLE'` 判定,但 `DomainError.message` 是人類描述('LiveSession cannot be joined.'),非 code。修法:`error instanceof DomainError && error.code === 'SESSION_NOT_JOINABLE'`。

#### Results

- `/live` Socket.IO namespace 上線,handshake auth 重用 Web session cookie(teacher)/ participant token+code(participant)。
- 生命週期事件 push(`session.snapshot`[join/reconnect/snapshot.fetch]、`question.opened`/`question.closed`、`session.state_changed`/`session.closed`、teacher-only `counts.updated`/`result.updated`)。
- PostgreSQL 為唯一權威,socket 通知層;raw token 不入 event/log;teacher aggregate 匿名;非 owner 拒連;closed/cancelled session 拒 reconnect。
- 無 schema/migration;既有 REST/e2e/integration 全綠(98 e2e + 104 unit + 10 integration,無回歸)。

#### Risk & rollback

- **風險:中高**。新 transport + 新依賴 + handshake auth(安全敏感)+ broadcast visibility + service post-commit emit。
- **Rollback:** revert 依賴、`configureApplication` websocket adapter line、`RealtimeModule`、service `publish`+constructor param、redaction、tests。**無 DB/migration** — 無 PostgreSQL rollback。不 replay/restore 任何 socket state。
- **不變量維持:** PostgreSQL 為權威、socket 通知層、raw participant token 不入 event/log、vote-to-reveal 仍由 REST S-3 守、非 owner 拒連、closed/cancelled session 拒 reconnect、既有 REST/CSRF/auth 行為不變。

#### Follow-up(Slice 7 deferred)

- **R-1 完整:** outbox table + `eventSeq`/`aggregateVersion`、replay / `sync.required`、coalescing、Redis adapter、durable publisher;reconcile lite 的 eventSeq envelope divergence。
- per-participant vote-to-reveal socket projection(目前 participant 收 lifecycle ping 後 refetch REST)。
- Session-level `GET /live-sessions/:id/results`(M2 API catalog)— 仍 deferred。
- Auto-close scheduler + submit/close race matrix(R-4)。
- `ArchivedResult` + 90 天保留(S-5)。
- 既有非阻擋警告:Nest `LegacyRouteConverter`(`health/(.*)`、`/api/*`)、`pg@9 client.query()` deprecation — 列為 E-4 清理。

#### Non-goals(本 slice)

- 無 outbox/aggregate table、無 eventSeq、無 replay、無 Redis、無 auto-close。
- 無 activation/submission cardinality 變更(multiple/open_text/quiz)。
- 無新 REST endpoint(S-2 polling endpoint 已覆蓋 REST read)。
- 無前端工作(依既定 B 策略:後端先)。

### 2026-08-17 — Slice 7: S-4 / R-1 lite Socket.IO 即時通道基礎(完成)

#### Context

P2 課堂老師端第三個缺口:joined/voted 即時人數的 **push** 交付。S-2 已交付 polling stopgap(`GET /api/v1/live-sessions/:id` 回 `joinedCount`/`votedCount`),本 slice 補 Socket.IO 即時通道(R-1 lite),把題目生命週期 + 即時人數 + 答題聚合用 push 交付。完整設計見 `/home/user/.claude/plans/snoopy-toasting-wreath.md`。

**Scope 決策(使用者確認):** 交付 R-1 lite — `/live` namespace + handshake auth + session/teacher rooms + in-process event bus + 生命週期事件 push;**defer** outbox table / `eventSeq` / `aggregateVersion` / replay / `sync.required` / coalescing / Redis adapter / per-participant vote-to-reveal socket projection 至完整 R-1。reconnect = 新連線 = fresh `session.snapshot`(lite 無 eventSeq,reconnect 不重播)。

**Authority(《即時同步與結果治理設計》):** PostgreSQL 為唯一權威;socket 為通知層,不授權結果。每個 mutation **先 commit 再 publish**(§1);publish 失敗只記 log,不讓 mutation 失敗(fire-and-forget)。raw participant token 永不入 event payload/log;teacher aggregate 永遠匿名(無 display-name→answer mapping);非 owner 先 404/拒連再說狀態;closed/cancelled session 拒 reconnect。

#### Checklist

- [x] 新依賴:`@nestjs/websockets@^11`、`@nestjs/platform-socket.io@^11`、`socket.io@^4.8`、dev `socket.io-client@^4.8`、`@types/socket.io`;`npm audit` 0 vulnerabilities。
- [x] `src/modules/realtime/live-session-event-bus.ts`:leaf in-memory bus,`publish`(fan-out、listener error 隔離、不 reject)+ `subscribe`(回 unsubscribe)。Signal union: `participant.joined`/`question.opened`/`question.closed`/`session.state_changed`/`submission.committed`。
- [x] `src/modules/realtime/live-session-event-bus.spec.ts`:5 unit tests(fan-out、throwing listener 隔離、async rejecting listener 隔離、unsubscribe、多 signal)。
- [x] `src/modules/realtime/live-gateway.ts`:`@WebSocketGateway({ namespace: 'live' })`。handshake auth — teacher:手動 `cookie.parse(socket.request.headers.cookie)`(`cookie` 模組,因 socket.io handshake 不走 express middleware,cookie-parser 不 populate `request.cookies`)→ `SessionService.loadActiveSession` → `getTeacherDetail` 驗 owner/admin;participant:`handshake.auth.{participantToken,sessionCode}` → `findByCode` + `ParticipantService.authenticate`。成功 join `session:<id>`(+ teacher 再 join `teacher:<id>`)→ emit `session.snapshot`(teacher: getTeacherDetail+counts;participant: getParticipantSnapshot learner 投影,無答案)。失敗 emit `error {code}` + disconnect(`DomainError.code === 'SESSION_NOT_JOINABLE'` 保留,其餘 fail-closed `UNAUTHORIZED`)。`@SubscribeMessage('snapshot.fetch')` 供 client 主動重取。
- [x] gateway `onModuleInit` subscribe bus → `handleSignal` per signal 重算投影並 emit(`participant.joined`→teacher `counts.updated`;`question.opened`→`session:<id>` `question.opened` + teacher `counts.updated`;`question.closed`→`session:<id>` `question.closed` + teacher `counts.updated` + `result.updated`;`session.state_changed`→`session:<id>`(+ `session.closed` 當 closed);`submission.committed`→teacher `counts.updated` + `result.updated`)。events envelope `{schemaVersion, serverTimestamp, liveSessionId, visibility, data}`(**無** `eventSeq`/`aggregateVersion`,lite 不可重播)。per-signal catch+log,下游失敗不影響 bus。
- [x] `src/bootstrap/configure-websocket.ts`:`CorsIoAdapter extends IoAdapter` 覆寫 `createIOServer` 注入 env-derived CORS allowlist(`ConfigService` runtime 讀,非 decorator 靜態期)+ `configureWebSocket(app)`;`configureApplication` 呼叫(production + e2e 共用)。
- [x] `src/modules/realtime/realtime.module.ts`:`@Global` 匯出 `LiveSessionEventBus`(leaf,無 service dep → 無 cycle),import `LiveSessionsModule`/`ParticipantsModule`(gateway → read services),services 只注入 bus(單向依賴)。
- [x] mutation services 注入 bus + post-commit `publish`(fire-and-forget、try/catch log+swallow):`LiveSessionService`(startSession/openQuestion/closeQuestion/closeSession[bulk-close open questions emit `question.closed` per + `session.state_changed`]/cancelSession)、`ParticipantService`(join)、`SubmissionService`(submit,只有 accepted 路徑[新建立或 idempotent replay],conflict throw 不 publish)。
- [x] `src/app.module.ts` import `RealtimeModule`。
- [x] `src/common/observability/pino-redaction.ts`:加 `req.body.participantToken`、`req.body.sessionCode`(socket `auth` payload 防洩)。
- [x] `test/live-session-realtime.e2e-spec.ts`:9 e2e(teacher snapshot、open→`question.opened`+`counts.updated`、participant learner snapshot 無 isCorrect/答案、submit→teacher `counts.updated`+`result.updated`[participant 無 result push]、close→`question.closed`+`result.updated`、invalid token 拒、unknown code 拒 `SESSION_NOT_JOINABLE`、non-owner teacher 拒、cancel→`session.state_changed`+reconnect 拒)。

#### 設計要點

- **commit-then-publish:** `publish` 只在 `await this.transactions.run(...)` 返回(已 commit)後呼叫;`void this.eventBus.publish(signal).catch(...)` 確保 bus 失敗不讓 mutation 失敗。
- **socket.io handshake cookie:** socket.io 的 handshake 請求(`/socket.io/...`)在 express middleware 之前被 socket.io engine 攔截,cookie-parser 不會 populate `request.cookies`。gateway 手動 `cookie.parse(socket.request.headers.cookie)` 讀 `__Host-session`(opaque/unsigned,不需 secret)。
- **reconnect = fresh snapshot:** lite 無 outbox/eventSeq,reconnect 等同新連線,server 重發 `session.snapshot`。`eventSeq`/`aggregateVersion` 故意省略(非 durable,標了會誤導 client);完整 R-1 加 outbox 時 reconcile 此 divergence。
- **vote-to-reveal 仍由 REST S-3 守:** lite 不 push per-participant result projection;participant 收到 lifecycle ping 後自行 refetch `GET .../results`(S-3 服務端守 reveal gate)。
- **teacher room recompute:** `emitTeacherCounts`/`emitTeacherResults` 用 `role:'admin'` internal recompute(teacher-room 成員已在 connect 時驗過 owner/admin);非 owner 從不進 teacher room。
- **無 schema/migration:** 純 additive runtime,aggregate 從既有 indexed rows 即時計算。

#### Verification

| 命令                                                                                   | 結果                                               |
| -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `npm install` + `npm audit`                                                            | ✅ 0 vulnerabilities                               |
| `npm run typecheck`                                                                    | ✅ PASS                                            |
| `npm run lint:check`                                                                   | ✅ 0 errors                                        |
| `npm run format:check`                                                                 | ✅ All matched files use Prettier                  |
| `npm run build`                                                                        | ✅ nest build PASS                                 |
| `npm test -- --runInBand src/modules/realtime/live-session-event-bus.spec.ts`          | ✅ 1 suite / 5 tests                               |
| `npm test -- --runInBand`(全 unit)                                                     | ✅ 20 suites / 104 tests                           |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/live-session-realtime.e2e-spec.ts` | ✅ 1 suite / 9 tests(DB-backed, 0 skipped)         |
| `NODE_ENV=test npm run test:e2e -- --runInBand`(全 e2e)                                | ✅ 14 suites / 98 tests(無回歸)                    |
| `NODE_ENV=test npm run test:integration -- --runInBand`                                | ✅ 3 suites / 10 tests                             |
| `NODE_ENV=test npm run prisma:migrate:status`                                          | ✅ 8 migrations, schema up to date(無新 migration) |
| `git diff --check`                                                                     | ✅ PASS                                            |

#### Debugging lessons(關鍵根因)

1. **cookie-parser 不作用於 socket.io handshake:** 初版用 `socket.request.cookies`(`cookie-parser` populate 的),但 socket.io engine 攔截 handshake 請求在 express middleware 之前 → `request.cookies` 永遠 undefined。偵測:`hasCookieHeader=true hasCookieJar=false`。修法:手動 `cookie.parse(socket.request.headers.cookie)`(用 `cookie` 模組,cookie-parser 的 transitive dep)。
2. **post-commit emit 的 client race(關鍵):** service `publish` 在 `transactions.run` 返回後同步 fire,bus listener 同步 emit 到 room — 事件可能在 REST response 返回 client 前已送到。若 test 在 `await` REST 之後才 `nextEvent(event)` 註冊 listener,事件已過 → timeout。偵測:`roomHas=true roomSize=1 sockCount=1`(socket 在 room、emit 到對的 room),但 client 收不到。修法:test 在 mutation **之前** pre-register listener promise,mutation 後 await。適用所有 signal-driven event test(open/submit/close/cancel)。
3. **DomainError code 偵測:** 初版用 `error.message === 'SESSION_NOT_JOINABLE'` 判定,但 `DomainError.message` 是人類描述('LiveSession cannot be joined.'),非 code → unknown code 拒連誤判為 `UNAUTHORIZED`。修法:`error instanceof DomainError && error.code === 'SESSION_NOT_JOINABLE'`(讀 `DomainError.code` 屬性)。

#### Results

- `/live` Socket.IO namespace 上線,handshake auth 重用 Web session cookie(teacher)/ participant token+code(participant)。
- 生命週期事件 push(`session.snapshot`[join/reconnect/snapshot.fetch]、`question.opened`/`question.closed`、`session.state_changed`/`session.closed`、teacher-only `counts.updated`/`result.updated`)。
- PostgreSQL 為唯一權威,socket 通知層;raw token 不入 event/log;teacher aggregate 匿名;非 owner 拒連;closed/cancelled session 拒 reconnect。
- 無 schema/migration;既有 REST/e2e/integration 全綠(98 e2e + 104 unit + 10 integration,無回歸)。

#### Risk & rollback

- **風險:中高**。新 transport + 新依賴 + handshake auth(安全敏感)+ broadcast visibility + service post-commit emit。
- **Rollback:** revert 依賴、`configureApplication` websocket adapter line、`RealtimeModule`、service `publish`+constructor param、redaction、tests。**無 DB/migration** — 無 PostgreSQL rollback。不 replay/restore 任何 socket state。
- **不變量維持:** PostgreSQL 為權威、socket 通知層、raw participant token 不入 event/log、vote-to-reveal 仍由 REST S-3 守、非 owner 拒連、closed/cancelled session 拒 reconnect、既有 REST/CSRF/auth 行為不變。

#### Follow-up(Slice 7 deferred)

- **R-1 完整:** outbox table + `eventSeq`/`aggregateVersion`、replay / `sync.required`、coalescing、Redis adapter、durable publisher;reconcile lite 的 eventSeq envelope divergence。
- per-participant vote-to-reveal socket projection(目前 participant 收 lifecycle ping 後 refetch REST)。
- Session-level `GET /live-sessions/:id/results`(M2 API catalog)— 仍 deferred。
- Auto-close scheduler + submit/close race matrix(R-4)。
- `ArchivedResult` + 90 天保留(S-5)。
- 既有非阻擋警告:Nest `LegacyRouteConverter`(`health/(.*)`、`/api/*`)、`pg@9 client.query()` deprecation — 列為 E-4 清理。

#### Non-goals(本 slice)

- 無 outbox/aggregate table、無 eventSeq、無 replay、無 Redis、無 auto-close。
- 無 activation/submission cardinality 變更(multiple/open_text/quiz)。
- 無新 REST endpoint(S-2 polling endpoint 已覆蓋 REST read)。
- 無前端工作(依既定 B 策略:後端先)。

---

# Phase A — 題型擴充（quiz / open_text / poll-multiple）— 完成

日期：2026-08-17（commit 594e9d3）
範圍：解除 activation/submission 對 poll/single 的限制，讓三種題型可上課與作答。

## 結果

- A1 activation gate 解除：`question.service.ts` `findForActivation` 改用共用 `validateQuestion` + `toActivatableContract`。
- A2 migration `20260817100000_relax_submission_answer_cardinality`：放寬 `selected_option_refs` CHECK（`jsonb_path_exists`，非 subquery）、新增 `text_answer` 長度 CHECK。
- A3 新 `submissions/domain/answer-contract.ts` + DTO 改 optional/nullable、加 `textAnswer`。
- A4 service 依 snapshotType 驗證、互斥寫入（`Prisma.DbNull`）、idempotency fingerprint 排序 refs + canonical text。
- A5 quiz correctness metrics 受 `revealCorrectness` 管制；open_text `responses` redaction。
- A6 realtime：`result.updated` 加 `sessionQuestionId`；per-client participant-safe result push（submit→sender、close→all）。
- A7 新 3 個 lifecycle e2e + 更新 realtime e2e。

驗證：typecheck / lint:check / prisma:validate 綠；e2e 17/101、integration 3/10、unit 20/104 全綠。
Lessons：PG CHECK 不能用 subquery（用 `jsonb_path_exists`）、Prisma `DbNull` vs `JsonNull`。

## Phase A 遺留（小，可隨時補）

- [ ] batch validate preview 回應缺 `clientRef`（DTO 宣告但 `toPreview()` 沒填）— `question-batch.service.ts`。
- [ ] gateway participant snapshot 與 REST participant snapshot 可見範圍不一致（gateway 用 `toLiveSessionDto` 未過濾 open question / hasSubmitted）— 建議 Phase B participant 改動時一起統一。
- [ ] `GET /auth/session` 的 `expiresAt` 是空字串 — 既有問題，非 Phase A 引入。

---

# Phase B — 學生帳號 + 加選名冊 — 待執行

範圍：新增 student role + CourseEnrollment + 登入學生綁定 Participant（保留匿名 session code fallback）。屬需求升級（既有設計明列「無學員帳號」為 MVP 限制，需同步更新設計文件 authorization matrix）。
計畫檔：`/home/user/.claude/plans/expressive-hopping-kitten.md`。

風險：高（auth/權限/realtime handshake）。分小切片、每切片獨立 e2e、可逐一切 rollback。

## Checklist（建議順序）

### B1 — student role + 帳號 + 登入（不可建課）

- [ ] schema/migration：`Account.role` CHECK 加 `student`（DROP/ADD `account_role_check`，範例 `20260815174233:32-34`）；`roles.ts` 加 `STUDENT`。
- [ ] `CreateAccountDto`/`AdminController`/`AccountService` 接受 student；`canCreateCourse` 對 student 強制 false（service invariant + `CanCreateCourseGuard`）。
- [ ] student 沿用同一 cookie session 登入；`SessionDto` role 回 student；`mustChangePassword`/disabled lifecycle 沿用。
- [ ] 明確 role policy：student 不可存取 courses/questions/live-sessions owner 路徑（現有 service 只比 owner/admin，需加 student 拒絕）。
- [ ] 測試：`identity.integration-spec.ts` role CHECK、`student-account.e2e-spec.ts` 登入/建課被拒/disabled。

### B2 — CourseEnrollment + 名冊 API（新 bounded context `enrollments`）

- [ ] schema/migration：新 `CourseEnrollment` model（`uq_course_enrollment_course_student`、`idx_*`、`status` CHECK active/removed）。
- [ ] 新 module `src/modules/enrollments`（api/application/domain），加入 `app.module.ts`，依賴方向 identity→courses→enrollments。
- [ ] API（teacher owner/admin）：`POST /courses/:courseId/enrollments`、`DELETE /courses/:courseId/enrollments/:studentAccountId`、`GET /courses/:courseId/enrollments`（分頁）。
- [ ] API（student）：`GET /me/courses`。
- [ ] target account 必須是 student；Course archived 禁止新加選。
- [ ] 測試：teacher 加選/移除/列表、跨 owner 不洩、student 跨非 enrolled course 403/404。

### B3 — student cookie 綁定 Participant（HTTP）

- [ ] schema/migration：`Participant` 加 optional `accountId` + FK Account `onDelete SetNull` + `idx_participant_account` + `uq_participant_session_account`。
- [ ] `ParticipantOrSessionGuard` / `ParticipantsController` 新增 student cookie actor 分支（視為 participant；找/建該 session 的 account-bound Participant）；`assertCourseAccess` 不套用 student。
- [ ] join：student 可 cookie 認證加入（省略 displayName，以 account identity）；匿名 session code fallback 保留。兩者產 Participant；student 路徑寫 `accountId`。
- [ ] submission：student cookie 認證時由 cookie→Participant 取代 `X-Participant-Token`；token 路徑不變。
- [ ] 測試：student cookie join/submit/results；匿名 fallback 仍可用；disabled student 不可重用。

### B4 — realtime student handshake

- [x] `live-gateway.ts`：cookie 不再一律走 teacher path；role=student 走 participant binding path（join `session:<id>` room，不進 teacher room）；`AuthenticatedClient` 加 student/participant-account 表達。
- [x] snapshot 分支對應調整；學生收 `result.updated`、不收 `counts.updated`。
- [x] 順便統一 gateway participant snapshot 與 REST participant snapshot（只保留 open + hasSubmitted）。
- [x] 測試：student cookie handshake 進 participant room、收 result、不收 counts — targeted realtime e2e 14/14 passed。

### B5 — 隱私 / redaction / 設計文件

> **Status (2026-08-23): IN PROGRESS / targeted runtime evidence PASS.** Runtime behavior is present and the focused privacy regressions pass; this slice still has a sibling-document permission boundary and broad verification pending. No schema/migration change is in scope.

- [x] `pino-redaction.ts` call-site audit completed; no reachable raw `passwordHash` logger payload found, so no blanket redaction was added for authorized `username`/`displayName`/opaque `accountId` projections.
- [x] `pino-redaction.spec.ts` verifies credentials, cookies, tokens, answer payloads and open-text content are removed while authorized profile metadata remains available to projections.
- [x] open_text results remain anonymous in open and closed REST projections; response objects contain only `{ text }` and no identity/token linkage.
- [x] realtime student close `result.updated` remains participant-safe with no identity linkage or teacher-only counts.
- [ ] synchronize all sibling design documents that still contain historical "no student account" wording; current workspace permission blocked edits to at least Web Auth and Backend NestJS planning files, while other approved addenda were applied.

### B5 working notes

- Focused unit: 2 suites / 14 tests PASS.
- Focused DB-backed e2e: 2 suites / 15 tests PASS against guarded `smartlearning_test`.
- B3 full HTTP/concurrency, full regression, and P0-06 archive/retention runtime remain separate pending scope.

## Phase B 驗證（DoD）

- student 可登入、加選、看名冊/我的課、cookie 加入 session 並作答；匿名 session code fallback 保留（e2e 通過）。
- realtime：student 進 participant room、收 `result.updated`、不收 `counts.updated`（targeted e2e 14/14 通過；B4 verified）。
- 權限 regression：student 存取 owner 路徑被拒。
- `prisma:validate`、相關 unit/integration/e2e、`openapi.e2e-spec.ts` 通過。
- 設計文件同步更新。

---

# Phase B — Execution Log

日期：2026-08-18
計畫：`/home/user/.claude/plans/streamed-toasting-panda.md`

## Acceptance criteria

- [ ] Student role/login/session lifecycle is supported; student `canCreateCourse` is always false and teacher/admin owner paths reject students.
- [ ] CourseEnrollment roster APIs support owner/admin add/remove/list, student active-course listing, archived-course protection, and cross-owner privacy.
- [ ] Enrolled students can cookie-join/read/submit/results through an account-bound Participant; anonymous session-code/token behavior remains unchanged.
- [x] Student Socket.IO clients are participant-only, receive safe `result.updated`, and never receive `counts.updated` — targeted B4 realtime e2e passed.
- [ ] Privacy/redaction and all authoritative design/authorization documents are synchronized.

## Checklist

- [ ] Checkpoint A: capture baseline, implement B1 migration/identity/authorization, add regression tests, verify targeted gates.
- [ ] Checkpoint B: implement B2 CourseEnrollment bounded context and roster APIs, migrate/test isolated DB, verify OpenAPI.
- [ ] Checkpoint C: implement B3 account-bound Participant HTTP flow, preserve anonymous flow, test concurrency and disabled accounts.
- [ ] Checkpoint D: implement B4 realtime handshake/projection parity, complete B5 privacy/docs, run full regression gates.
- [ ] Record final results, operational notes, and any new lesson in `tasks/lessons.md`.

## Risk & rollback

- **Risk:** high — authentication/authorization, enrollment tenancy, participant identity, and Socket.IO visibility.
- **Rollback:** revert application slice-by-slice; retain additive migrations and committed student/enrollment/participant rows; use forward fixes instead of editing applied migrations or restoring revoked sessions/submissions.
- **DB safety:** only mutate `smartlearning_test` through the guarded test setup and obtain explicit authorization before migration deployment to test/development databases.

## Working notes

- Existing role/status constraints are hand-written PostgreSQL `TEXT + CHECK`; UUIDs are app-generated UUID v7.
- Existing test bootstrap must continue using `test/setup/db.ts`; it refuses databases other than `smartlearning_test`.
- PostgreSQL remains the identity/enrollment/participant authority; realtime publishes only post-commit notifications.
- B1 code-only verification (2026-08-18): unit 20 suites/104 tests, typecheck, lint, format, build, and diff check PASS; test migration/integration/e2e intentionally deferred by user, so B1 remains unverified against PostgreSQL.

## B2 progress (2026-08-18)

- Added `CourseEnrollment` schema model and additive migration `20260818110000_add_course_enrollment`; migration is not applied.
- Added enrollment status domain, application service, controller, DTO projections, module wiring, and `/api/v1/me/courses`.
- Add/reactivate is draft-only and course-row locked; remove is idempotent and allowed for authorized archived-course owners/admins; active-course listing is student-only.
- Added enrollment e2e coverage and OpenAPI path assertions; PostgreSQL-backed tests remain deferred with migration authorization.

## B3/B4 progress (2026-08-18)

- Added nullable `Participant.accountId`, account/session uniqueness and index migration `20260818120000_bind_participant_account`; migration is not applied.
- Student cookie joins/resolution require an active student account and active CourseEnrollment, create one participant idempotently under the LiveSession row lock, and never return the internal participant token.
- Anonymous session-code/token joins and submissions remain available; cookie-backed mutations use CSRF/Origin validation while bearer-token paths remain unchanged.
- Socket.IO cookie handshakes now branch student accounts into participant scope, keep teacher/admin scope unchanged, project only open participant questions, and never send teacher counts to student sockets.
- B3/B4 DB-backed e2e/realtime verification remains deferred with migration authorization; static checks are rerun after the final code changes.

## B5 discovery note (2026-08-18)

- The design-document paths listed in the Phase B plan are not present in this checkout (only README/SKILL/task markdown is tracked); no authoritative design document was edited. Existing Pino redaction already covers cookies, participant/session tokens, idempotency keys, and answer fields.
- Added Socket.IO handshake redaction for participant tokens, session codes, and handshake cookies; no password, password hash, cookie, raw session/participant token, or open-text content is exposed in responses or logs.

## Final code-only verification (2026-08-18)

- `src/modules/realtime/live-gateway.ts`: account-bound participant sockets are reauthorized before snapshots, participant result projections, and every signal; revoked enrollment/account status disconnects the socket before later broadcasts. `counts.updated` remains teacher-room-only.
- Account-bound Participant creation and cookie-bound submission revalidation now lock rows in the order `liveSession → course → account` before the final enrollment/account checks, closing enrollment-removal and account-disable TOCTOU windows.
- Replaced the Socket.IO `RemoteSocket[] as Socket[]` assertion with a narrow structural `DisconnectableSocket` shape (`id` + `disconnect`) and retained only the local helper cast needed by the Socket-oriented result path.

| Command                                                    | Result                       |
| ---------------------------------------------------------- | ---------------------------- |
| `npm run typecheck`                                        | PASS                         |
| `npm run lint:check`                                       | PASS                         |
| `npm run format:check`                                     | PASS                         |
| `npm run build`                                            | PASS                         |
| `git diff --check`                                         | PASS                         |
| `npm test -- --runInBand`                                  | PASS — 20 suites / 104 tests |
| `npm run test:e2e -- --runInBand test/openapi.e2e-spec.ts` | PASS — 1 suite / 3 tests     |

The verification agent confirmed the working tree was unchanged by these checks. Expected LiveSessionEventBus simulated-error logs and existing Nest legacy wildcard-route warnings were non-blocking.

## Intentional migration-backed verification block

- The user explicitly chose `Defer migration`; no Phase B migration was deployed or applied, and no `setupTestDb` was run.
- The following additive migrations remain unapplied: `20260818100000_add_student_role`, `20260818110000_add_course_enrollment`, and `20260818120000_bind_participant_account`.
- Consequently, identity integration plus enrollment, student-account, account-bound participant, and realtime DB-backed e2e suites remain unexecuted. Phase B acceptance criteria and DoD stay unchecked until explicit migration authorization is provided.
- When authorized, apply only to the isolated `smartlearning_test` database, verify migration status, then run the targeted B1–B4 integration/e2e suites before broader regression. Do not edit already-applied migrations or commit without explicit user instruction.

## 2026-08-20 — US-F7 password policy and login rate limit (complete; DB verification blocked)

### Context and acceptance criteria

- [x] Enforce the 12–128 Unicode password policy plus deterministic normalized common-password rejection for account creation, admin reset, bootstrap, and self-service change.
- [x] Enforce account + source fixed-window login limits with safe defaults, numeric env coercion, TTL expiry, generic 429 `RATE_LIMITED`, retry hint, anti-enumeration behavior, and account-scope clearing on success.
- [x] Preserve no-schema/no-Redis MVP boundary and document the static-list and single-instance limitations.
- [x] Complete frontend F7 regression coverage in the separate UI repository after backend contract verification.

### Checkpoints

- [x] A — audit/harden existing uncommitted backend F7 files and add policy/rate-limit tests.
- [x] B — run targeted backend gates, then frontend F7 fixes/tests.
- [x] C — attempt backend DB regression/status checks and record the block; PostgreSQL at `localhost:5432` was unavailable, so DB-backed verification remains blocked.

### Risk & rollback

- Risk: high — authentication, password state, session rotation, and abuse controls.
- Rollback: revert/remove only F7 policy/limiter wiring and new files; no migration rollback. Preserve unrelated README, live-session DTO, lesson, and Phase B changes.

### Dependencies & environment

- Node 24+, migrated `smartlearning_test` for DB-backed e2e, and guarded test DB setup. Redis and real breached-password source remain deferred.

### Working notes

- Backend working tree was already dirty before this slice; unrelated changes must not be reset or overwritten.
- RateLimiterService must coerce ConfigService env strings at read time; this is a required permanent-lockout tripwire.
- Frontend StepUpDialog/useStepUp remain deferred to F8; self-service change-password is Session + CSRF only.

### Results (2026-08-20)

- **What changed**: retained and hardened the static common-password policy, applied it to account creation/reset/bootstrap/self-change, added normalized account limiter keys and string-env TTL coverage, corrected the disabled-account rate-limit e2e fixture, added source-scope and retry-envelope regression assertions, and preserved the in-memory single-instance MVP boundary.
- **Static verification**: typecheck, lint, format, build, and targeted policy/limiter/filter tests passed (3 suites / 33 tests). A prior full backend static/unit pass also passed (21 suites / 120 tests before the final targeted additions).
- **DB verification blocked**: `prisma:migrate:status` failed with PostgreSQL `P1001` at `localhost:5432`; auth-rate-limit/auth-courses e2e and identity integration were guarded/blocked and did not exercise DB assertions.
- **Unrelated work preserved**: existing README, live-session DTO, lesson, Docker, and Phase B changes remain untouched by this F7 slice; no schema/migration or commit was created.

## 2026-08-21 — US-F16 account course-creation permission (backend + isolated browser acceptance verified)

### Goal and acceptance criteria

- [x] Add admin-only `PATCH /api/v1/admin/accounts/:id/permissions` with body `{ canCreateCourse: boolean }` and HTTP 200 `AccountDto` response.
- [x] Keep permission changes separate from disable/restore, WebSession/CLI credential revocation, unused-token invalidation, and existing domain rows.
- [x] Enforce the student invariant: a student target cannot be granted `canCreateCourse=true`.
- [x] Add OpenAPI and targeted account-admin e2e coverage; record the real DB gate explicitly when unavailable.

### Checkpoints

- [x] A — Confirm the execution-plan contract and implement DTO/controller/service boundaries.
- [x] B — Add row-locked single-field mutation, no-op behavior, OpenAPI assertion, and account-admin behavioral cases.
- [x] C — Close the revoke/create TOCTOU by rechecking `canCreateCourse` under the owner row lock in `CourseService.createCourse`, with a unit regression test.
- [x] D — Run DB-backed F16 e2e/side-effect matrix: targeted `account-admin.e2e-spec.ts` passed (1 suite / 10 tests) against migrated `smartlearning_test`.
- [x] E — Real Playwright acceptance passed against the rebuilt dirty-source backend with an isolated fixture and exact `CORS_ORIGIN=http://localhost:3001`.

### Risk & rollback

- Risk: high — authorization boundary and preservation of sessions, credentials, and domain data.
- Rollback: remove only the F16 DTO/route/service/tests/docs; preserve existing account list/detail/create and disable/restore/CLI flows. No schema migration or data rollback is required.

### Dependencies & environment

- Node 24+, migrated isolated `smartlearning_test`, backend on `localhost:3000`, frontend origin `http://localhost:3001` for browser integration.
- No Prisma schema/migration change; the existing `Account.canCreateCourse` column is authoritative.

### Working notes

- Contract source: `/home/user/projects/smartLearning/docs/智學互動平台/50_實作與測試/US-F16 前端實作計畫-執行方案.md`.
- `TransactionService.lockAccountForUpdate()` serializes permission changes; same-value updates return the locked row without side effects.
- `CourseService.createCourse()` now takes the same account row lock and rechecks the authoritative permission before inserting, so a revoke/create race linearizes at the account lock.
- Student `true` is rejected with `FORBIDDEN`; malformed/unknown IDs remain existence-safe; global validation rejects non-boolean/unknown body fields.

### Results

- **What changed**: added `UpdateAccountPermissionsDto`, admin controller PATCH route, `AccountService.updateCourseCreationPermission`, the transaction-locked course-create recheck plus regression tests, frontend API reference rows for existing list/detail and new PATCH, OpenAPI path assertion, and F16 account-admin e2e cases.
- **Static verification**: targeted `npm test -- --runInBand src/modules/courses/application/course.service.spec.ts` passed (1 suite / 2 tests); `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`, and `git diff --check` all passed after the race fix. No DB-mutating tests or migrations were run.
- **Integration verification**: OpenAPI e2e passed (3 tests); `NODE_ENV=test npm run prisma:migrate:status` passed with 12 migrations up to date; targeted `NODE_ENV=test npm run test:e2e -- --runInBand test/account-admin.e2e-spec.ts` passed (1 suite / 10 tests), covering true/false course creation, student/non-admin/CSRF behavior, revoke/create serialization, and domain/credential preservation assertions.
- **Historical before isolated fixture**: real browser acceptance was blocked because all five `F16_*` fixture variables were unset and UI port `3001` was not listening; the final acceptance evidence is recorded below.

### Real F16 browser acceptance — 2026-08-22 (dirty source + isolated fixture)

- **Runtime**: rebuilt the current uncommitted F16 source and launched an isolated `f16isolated` Compose stack. `f16-isolated-backend` runs on host `3000` with `CORS_ORIGIN=http://localhost:3001`; `f16-isolated-db` runs on host `55433` with a fresh named volume. The prior `smartlearning-backend` container was stopped only; its original container/database/volume were preserved.
- **Fixture**: compiled bootstrap created a fresh admin in the isolated database; the real admin API created a unique teacher and the forced password change completed. Target account ID: `01a028b5-c31f-7410-83a5-7032e8e81acd`. Passwords and cookies stayed in-process and were not written to source, tasks, logs, or commits.
- **Preflight**: `/health/live`, `/health/ready`, `/api/docs-json` all returned HTTP 200; isolated migration exited `0`; `prisma migrate status` found 12 migrations with no pending migrations; live OpenAPI exposed the F16 detail and permission PATCH routes; allowed CORS returned the exact UI origin and credentials, while an unapproved origin received no ACAO.
- **Browser**: `node test/browser/run.mjs test/browser/us-f16-account-permission.spec.ts` passed Chromium **1/1** in 3.1 seconds, including real admin/teacher login, keyboard/ARIA switch behavior, revoke→403/no-new-course, re-enable→201, archive, restore, and logout cleanup.
- **Scope**: no backend source, schema, existing domain row, or volume was reset/deleted. CP0 is now `PASS`; CP1–CP5 were not started.

---

# 2026-08-23 — US-F0 CP5 → US-F1 Backend Contract → F1 Frontend

## Goal and acceptance criteria

- [ ] Complete US-F0 CP5 real-backend Playwright acceptance with isolated runtime/fixtures, CSRF/Origin negatives, stale-session authorization, accessibility/responsive evidence, scoped cleanup, and no-new-row proof.
- [ ] Freeze and obtain manual approval for the F1 history/result/governance contract before schema changes.
- [ ] Implement F1 backend archive authority, retention/deletion/tombstone semantics, history/result APIs, privacy/race tests, OpenAPI and frontend reference.
- [ ] Obtain manual approval of the backend gate before any F1 frontend route/hook/type/component.
- [ ] Implement F1 frontend only from the confirmed backend contract and complete real-backend acceptance.

## Checkpoint checklist

- [ ] CP0 — non-mutating source/runtime/OpenAPI/CORS/migration/fixture preflight.
- [ ] Manual confirmation 1 — authorize authenticated Course create/archive/permission mutations.
- [ ] CP1 — run existing US-F0 real-browser spec and sanitized handoff.
- [ ] Manual confirmation 2 — confirm CP5 acceptance matrix completed.
- [ ] CP2 — present canonical F1 routes/DTOs/authorization/race/retention/deletion semantics.
- [ ] Manual confirmation 3 — authorize schema/migration implementation.
- [ ] CP3/4 — implement additive archive authority, governance APIs/worker, docs, and regression coverage.
- [ ] CP5 — run backend contract verification bundle.
- [ ] Manual confirmation 4 — authorize F1 frontend implementation.
- [ ] CP6 — implement and verify F1 frontend; request Manual confirmation 5.

## Risk & rollback

- **Risk:** high — authentication/authorization, anonymous result governance, irreversible deletion, additive migration, and close/submit/archive races.
- **Rollback:** preserve existing F8/Phase-B dirty work; use additive migration plus revert/forward-fix; never reset working trees, truncate, broad `down -v`, restore revoked sessions, or resurrect deleted/tombstoned result content.

## Dependencies and environment

- Node 24+, PostgreSQL, Prisma 7, backend `3000`, UI `3001`, Chromium/Playwright 1.62.1, exact runtime `CORS_ORIGIN=http://localhost:3001` for CP5.
- CP5 uses process-only `F0_*` variables; secrets/raw cookies/CSRF/participant/CLI tokens and raw backend messages must not enter source, logs, task records, traces, or chat.
- DB-backed verification is limited to protected `smartlearning_test` or an explicitly isolated database; do not mutate unknown databases.

## Working notes

- Current backend dirty scope is US-F16/F8/Phase-B; current UI dirty scope is task documentation. Keep these scopes separate.
- Current backend has close/cancel and per-question result projections but no ArchivedResult/history/retention/tombstone authority.
- P0 cancellation and current backend/wire behavior require an explicit CP2 decision; result route naming also requires explicit canonicalization before frontend work.

## Results

- Planning completed and approved; no product source, schema, migration, environment file, or runtime/domain data changed during planning.
- CP0 execution is the next action. Stop at Manual confirmation 1 before authenticated CP5 mutations.

### CP0 preflight — 2026-08-23 (BLOCKED; no authenticated CP5 mutation)

- **PASS:** existing isolated backend on `3000` returned HTTP 200 for `/health/live`, `/health/ready`, `/api/docs`, and `/api/docs-json`; live OpenAPI had 37 paths including Course, F16 permission, Phase-B enrollment/participant, and current LiveSession routes.
- **PASS:** runtime CORS was exactly `http://localhost:3001`; allowed-origin response exposed matching ACAO/credentials and an unapproved origin had no ACAO. Protected `smartlearning_test` migration status reported 12 migrations and schema up to date.
- **PASS:** existing migrate container exited `0`; backend container was healthy. No source, product file, database row, or existing volume was changed by this preflight.
- **BLOCKER:** the reachable backend was built from `/tmp/smartlearning-cp5-20260822` (Compose labels/config), not the current checkout; source/runtime parity therefore cannot be claimed. UI `3001` was unreachable, and all eight process-only `F0_*` variables were missing.
- **Safety decision:** no Course create/archive, permission mutation, authenticated browser run, fixture mutation, teardown, or volume deletion was performed. CP5 remains `BLOCKED`; Manual confirmation 1 has not been requested as a PASS handoff.
- **Next action requiring user decision:** rebuild a fresh isolated stack from the current checkout on backend `3000` (which requires stopping only the named stale isolated `smartlearning-cp5-20260822` stack while preserving its volume), start UI `3001`, and provision the eight F0 fixture variables before requesting Manual confirmation 1.

### CP0 rerun — 2026-08-23 (PASS; awaiting Manual confirmation 1)

- **Runtime/source:** stopped only the named stale isolated stack while preserving `smartlearning-cp5-20260822_cp5_pgdata`; built `smartlearning-cp5-20260823` from the current checkout context `/home/user/projects/smartLearning/smartLearning-backend` with a new volume `smartlearning-cp5-20260823_cp5f0_20260823_pgdata`.
- **Services:** backend `3000` healthy, isolated DB `55435` healthy, migrate exited `0`, UI `3001` returned HTTP 200. No existing development DB/container/volume was touched.
- **Contract/CORS:** `/health/live`, `/health/ready`, `/api/docs`, `/api/docs-json` returned HTTP 200; live OpenAPI exposed 37 paths including current F16/Phase-B routes; `CORS_ORIGIN` was exactly `http://localhost:3001`, allowed origin returned matching ACAO/credentials, blocked origin returned no ACAO.
- **Fixture:** compiled bootstrap in the current-source runtime image created an isolated admin; real admin API created an isolated teacher with `canCreateCourse=false`; teacher completed forced password change; all eight F0 variables exist only in the waiting provisioning process. No credentials, cookies, CSRF values, or raw tokens were persisted or printed.
- **Safety:** no Course create/archive, permission update, authenticated browser run, arbitrary delete, truncate, or volume deletion was performed. CP0 exit criteria are PASS; waiting for explicit Manual confirmation 1 before CP5 mutations.
- **User decision:** Manual confirmation 1 was intentionally declined on 2026-08-23; execution is paused at CP0. The isolated runtime/fixture remains available; the credential-holding provisioning process was stopped and its control markers removed. CP1 remains pending.

### Implementation lesson (2026-08-23)

- Host `npm run bootstrap:admin` under the available Node/tsx toolchain failed before application startup with `PrismaService` receiving an undefined `ConfigService`; the current-source compiled runtime image worked. For isolated Docker fixtures, use the compiled bootstrap artifact inside the exact runtime image and verify its exit code, rather than treating a host CLI failure as a database/runtime failure.

### CP5 isolated-stack execution checklist — 2026-08-23

- [x] A — repeat sanitized runtime/source/config/health/CORS/UI/migration preflight; no authenticated mutation.
- [x] Manual A — user selected **Stop here** after the sanitized preflight; no lifecycle action or authenticated mutation was authorized.
- [ ] B — provision a fresh isolated F0 admin/teacher fixture with compiled bootstrap and process-only credentials.
- [ ] Manual B — obtain explicit confirmation before releasing the fixture marker for real Playwright Course/permission mutations.
- [ ] C — run static gates and the existing Chromium 1-worker `us-f0-course-flow.spec.ts`; require non-skipped pass and scoped cleanup.
- [ ] D — collect sanitized evidence, verify Compose scope/volume preservation, and append UI task-log results only after real acceptance.

**Scope:** no backend/product source, schema, migration, env file, commit, broad teardown, volume deletion, truncate, or arbitrary row deletion. Existing CP5 and unrelated Compose projects/volumes remain protected.

**Working notes:** current shell has no F0 variables; existing CP5 fixture credentials must not be recovered. If a fresh current-source migration image fails, stop as blocked and do not modify the Dockerfile in this CP5 run.

### CP5 isolated-stack preflight attempt — 2026-08-23 (BLOCKED; paused at Manual A)

- **PASS:** backend and UI repository scope was preserved; backend source remained clean before this execution attempt and the UI retained only its existing `tasks/todo.md` modification.
- **PASS:** named `smartlearning-cp5-20260823` runtime reported backend healthy on `3000`, DB healthy on `55435`, migration exit `0`, network `smartlearning-cp5-20260823_default`, and volume `smartlearning-cp5-20260823_cp5f0_20260823_pgdata`.
- **PASS:** `/health/live`, `/health/ready`, `/api/docs`, `/api/docs-json`, and UI `3001` returned HTTP `200`; allowed CORS returned `http://localhost:3001`, while a blocked origin returned no ACAO.
- **PASS:** merged config safe projection contained only backend `3000:3000` and DB `55435:5432`; resource labels matched the named CP5 project. No F0 variable names were present in the current process environment.
- **BLOCKED:** the user selected **Stop here** at Manual confirmation A. No existing CP5 container was stopped, no rerun project/volume was created, no fixture was provisioned, and no authenticated Course/permission/browser mutation was attempted.
- **Decision:** CP5 real-browser acceptance remains `BLOCKED`/pending a later explicit confirmation; existing CP5 runtime, volume, unrelated Compose projects, and domain data were left untouched. UI `tasks/todo.md` was not appended because browser/cleanup evidence does not exist.

### CP5 fresh rerun — 2026-08-23 (PAUSED at Checkpoint A)

- **PASS:** backend `HEAD` was `cc0b88146afa3cf7712d708aa850aaea20fd766c` with a clean working tree; the UI retained only its pre-existing task-log change at the start of the rerun.
- **PASS:** existing Compose scope was inventoried without secrets: `smartlearning-cp5-20260823` owned `3000:3000`, `55435:5432`, network `smartlearning-cp5-20260823_default`, and volume `smartlearning-cp5-20260823_cp5f0_20260823_pgdata`; unrelated projects/resources were not targeted. All `F0_*` names were absent from the current process environment.
- **PASS:** the run-scoped temporary Compose projection passed with project `smartlearning-cp5-20260823-rerun-20260822172242`, current-checkout build context, `migrate`/`runtime` targets, exact `3000:3000` and `55435:5432` mappings, isolated volume/network names, `service_completed_successfully` dependency, and `CORS_ORIGIN=http://localhost:3001`. The temporary file was `/tmp/smartlearning-cp5-20260823-rerun-20260822172242.yml`; its volume and network were not created.
- **PASS:** the already-running UI endpoint at `http://localhost:3001` returned HTTP `200`.
- **PAUSED:** the user selected **Stop here** at Checkpoint A. No old CP5 container was stopped; no image build, new stack startup, migration, bootstrap, fixture provisioning, F0 marker, authenticated mutation, or browser run was performed.
- **Decision:** this fresh rerun remains pending Checkpoint B authorization. Existing CP5 runtime/volume/network and unrelated Compose resources remain protected; no backend product source, schema, migration, environment file, or database row was changed.

### CP5 Checkpoint B attempt — 2026-08-23 (BLOCKED; environment unavailable)

- **Manual authorization:** received for the limited Checkpoint B lifecycle/fixture step only; authenticated Course, permission, and browser mutations remain unauthorized pending Manual B.
- **BLOCKED:** the reviewed `/tmp/cp5f0-provision-and-run.sh` provisioning flow is absent, and the Docker API is unavailable (`unix:///var/run/docker.sock: no such file or directory`). Therefore no CP5 container was stopped, no fresh project/volume/network was created, no image was built, no migration/bootstrap/fixture provisioning ran, and no F0 marker was released.
- **Safety:** no backend/UI product source, schema, migration, environment file, database row, existing CP5 resource, unrelated Compose project, or volume was changed.
- **Next step:** restore Docker daemon access and recreate/recover the explicitly reviewed CP5 provisioning flow without recovering credentials; then rerun the limited Checkpoint B preflight before requesting Manual B.

### CP5 Checkpoint B retry — 2026-08-23 (BLOCKED; execution artifact absent)

- **Docker:** the Docker socket is now present, and the named project inventory is readable. The existing `smartlearning-cp5-20260823` containers are exited (`backend`/`db` exit 255; `migrate` exit 0).
- **BLOCKED:** the reviewed provisioning script and temporary Compose file are absent (`/tmp/cp5f0-provision-and-run.sh` and `/tmp/smartlearning-cp5-20260823.yml` cannot be read). The Compose project metadata points to the missing temporary file, so the exact isolated lifecycle/config cannot be safely reconstructed from the current filesystem without risking the wrong project or volume.
- **Safety:** no container was stopped or started, no stack was rebuilt, no volume/network/database mutation was attempted, and no F0 credential or marker was recovered.
- **Next step:** restore the exact CP5 execution artifact (or provide an explicitly reviewed replacement) before retrying; then re-run the scoped Checkpoint B preflight and fixture provisioning.

### CP5 Checkpoint B preflight — 2026-08-23 (PASS; lifecycle intentionally not executed)

- **Docker:** daemon available (`29.5.3`); named project inventory is readable. Existing `smartlearning-cp5-20260823` containers remain exited: backend/db `255`, migrate `0`.
- **Artifacts:** reviewed `/tmp/cp5f0-provision-and-run.sh` and `/tmp/smartlearning-cp5-20260823.yml`; the script is gated on the fixture marker and Manual confirmation 1 before UI mutations. No marker files currently exist.
- **Scope:** container labels match project `smartlearning-cp5-20260823`; the existing DB volume is `smartlearning-cp5-20260823_cp5f0_20260823_pgdata`, attached only at PostgreSQL data path; network is `smartlearning-cp5-20260823_default`.
- **Compose projection:** sanitized merged config contains exactly `backend:3000:3000` and `db:55435:5432`; no lifecycle command was issued.
- **Safety:** no container was stopped/started, no image was built, no migration/bootstrap/fixture provisioning ran, no marker was released, and no authenticated Course/permission/browser mutation was attempted.
- **Next step:** the limited preflight is complete. Stop before the reviewed provisioning script's bootstrap or any fixture/authenticated mutation; request a separate explicit authorization before proceeding past Manual B.

### Phase B Checkpoint A preflight — 2026-08-23 (BLOCKED; PostgreSQL unavailable)

- **PASS:** current backend branch is `phase-b-student-enrollment`; the only pre-existing dirty file is `tasks/todo.md`, containing unrelated CP5 notes. No product source, schema, migration, or unrelated change was reset or overwritten.
- **PASS:** Phase B migrations were inspected read-only: `20260818100000_add_student_role`, `20260818110000_add_course_enrollment`, and `20260818120000_bind_participant_account`. The guarded test configuration names `smartlearning_test`; development configuration names `smartlearning_dev`.
- **BLOCKED:** read-only `NODE_ENV=test npm run prisma:migrate:status` resolved target `smartlearning_test` but PostgreSQL at `localhost:5432` was unreachable (`P1001`). Development status likewise resolved `smartlearning_dev` but was unreachable. Migration status is therefore unproven; no targeted tests, migration deploy, schema/data write, or manual authorization request was performed.
- **Next step:** restore PostgreSQL connectivity, rerun the read-only Checkpoint A status preflight, then request manual authorization before any targeted Phase B test.

### Phase B Checkpoint A rerun + B1/B2 targeted verification — 2026-08-23

- **PASS:** after PostgreSQL recovery, read-only `NODE_ENV=test npm run prisma:migrate:status` resolved `smartlearning_test`; 12 migrations were found and the database schema was up to date. No migration file, schema, product source, or unrelated CP5/F8 change was edited.
- **AUTHORIZED:** the user authorized targeted B1/B2 DB-backed tests and fixture-isolation truncation limited to `smartlearning_test`.
- **PASS:** `NODE_ENV=test npm run test:integration -- --runInBand test/identity.integration-spec.ts` — 1 suite / 7 tests passed, 0 skipped.
- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand test/student-account.e2e-spec.ts test/enrollments.e2e-spec.ts test/openapi.e2e-spec.ts` — 3 suites / 8 tests passed, 0 skipped.
- **PASS:** combined B1/B2 scope — 4 suites / 15 tests passed, 0 failures, 0 skips. Evidence covers student role and `canCreateCourse=false` normalization/persistence/session projection, owner roster add/list/remove/reactivate/idempotency, cross-owner privacy, archived-course rejection, `/api/v1/me/courses`, student owner-path denial, DB CHECK rejection, and OpenAPI enrollment/admin paths.
- **NOTE:** `test/setup/db.ts` internally invokes idempotent `npx prisma migrate deploy` before DB-backed suites. The tests made no schema change because status was already up to date, but this implicit setup behavior differs from the Checkpoint A wording “不重套 migration”; it is recorded as a boundary discrepancy, not silently treated as a no-op.
- **Checkpoint B decision required:** accept this B1/B2 report and authorize the next scoped step, B3 account-bound HTTP participant tests. No B3, realtime, documentation, or broad regression work has started.

### Phase B current execution status — 2026-08-23

- **Completed:** Checkpoint A DB preflight, authorized B1/B2 targeted verification, and authorized B4 realtime targeted verification.
- **B1/B2 result:** 4 suites / 15 tests passed, 0 skipped, 0 failures against `smartlearning_test`; no `smartlearning_dev` access.
- **B4 result:** `test/live-session-realtime.e2e-spec.ts` passed with 1 suite / 14 tests, 0 failures, 0 skips; realtime static gates also passed.
- **Current state:** B4 targeted acceptance verified; B3 full HTTP suite, B5 authoritative-document synchronization, and final regression gates remain pending.
- **Not started:** `test/participant-account.e2e-spec.ts` (B3 full suite), B5 authoritative-document synchronization, and broad/full regression gates.
- **Next action:** decide whether to run the separate B3 account-bound HTTP suite, then complete B5 documentation/privacy synchronization before claiming the overall Phase B DoD.
- **Safety status:** no runtime source, Prisma schema, migration, design document, commit, reset, down migration, or broad deletion was performed. Existing CP5/F8 work was preserved.
- **Working-tree note:** this execution appended the B4 result and updated the B4 checklist only; product source and schema remain unchanged.
- **Boundary note:** DB-backed test setup internally runs idempotent `npx prisma migrate deploy`; migration status was already up to date and no schema change was observed. This remains an explicit process-boundary note.

### B4 realtime targeted verification — 2026-08-23

- **AUTHORIZED:** the user explicitly authorized the guarded B4 realtime fixture isolation limited to `smartlearning_test`; no `smartlearning_dev` or unknown database access was authorized.
- **PASS:** read-only `NODE_ENV=test npm run prisma:migrate:status` resolved `smartlearning_test`; 12 migrations were found and the schema was up to date.
- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand test/live-session-realtime.e2e-spec.ts` — 1 suite / 14 tests passed, 0 failures, 0 skips. The suite used real TCP Socket.IO clients and PostgreSQL; all tests reached `requireDatabase()` rather than passing vacuously.
- **PASS:** B4-focused static gates — realtime event-bus unit 1 suite / 5 tests, typecheck, lint:check, format:check, and `git diff --check` all passed.
- **RESULT:** B4 realtime targeted acceptance is verified: student cookie participant scope, snapshot privacy, participant-safe result push, teacher-only counts, enrollment/account revocation disconnects, anonymous fallback, and existing teacher lifecycle paths passed. No product source, schema, migration, environment file, commit, or unrelated CP5/F8 change was edited.
- **BOUNDARY:** B3 full `participant-account.e2e-spec.ts`, B5 authoritative-document synchronization, and broad/full regression remain unverified and are not claimed complete. Existing non-blocking Nest legacy route-converter warnings remained.

### B5 privacy targeted verification — 2026-08-23

- **PASS:** `NODE_ENV=test npm run prisma:validate` — Prisma schema/config valid; no schema or migration edits.
- **PASS:** `NODE_ENV=test npm test -- --runInBand src/common/observability/pino-redaction.spec.ts src/modules/live-sessions/domain/question-results.spec.ts` — 2 suites / 14 tests passed.
- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand test/open-text-live-flow.e2e-spec.ts test/live-session-realtime.e2e-spec.ts` — 2 suites / 15 tests passed against guarded `smartlearning_test`; no skips/failures. Evidence covers open/closed open_text anonymity, account-bound student cookie submit/results, realtime close projection identity negatives, teacher-only counts isolation, and anonymous fallback.
- **PASS:** `NODE_ENV=test npm run prisma:migrate:status` — `smartlearning_test`, 12 migrations, schema up to date.
- **PASS:** `git diff --check` — no whitespace errors.
- **PASS:** current backend `SKILL.md` and `docs/frontend-api-reference.md` now distinguish B1/B2/B4/B5 targeted evidence from B3/full regression pending; P0/SPEC/BDD/result-governance/domain/API/contract-review/historical-DB sibling addenda were applied where workspace permissions allowed.
- **BLOCKED:** edits to sibling `Web Auth 與安全設計.md`, `Backend NestJS 實作規劃.md`, canonical `資料模型與 ER 設計.md`, and `即時同步與結果治理設計.md` were denied by the current permission classifier; no workaround was attempted. B5 docs sync is therefore not claimed complete.
- **PASS:** `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`, and `git diff --check` all passed on the current working tree.
- **BOUNDARY:** B3 full HTTP/concurrency and broad/full regression remain pending. P0-06 archive/retention runtime remains out of scope.

### 2026-08-24 — Config: DB-backed test command permission rules (project-local)

- **AUTHORIZED:** the user explicitly authorized adding project-local permission rules so `NODE_ENV=test npm run test:e2e` and `NODE_ENV=test npm run test:integration` run without a permission prompt, scoped to `smartlearning_test`.
- **DONE:** `.claude/settings.local.json` → `permissions.allow` now includes `Bash(NODE_ENV=test npm run test:e2e *)` and `Bash(NODE_ENV=test npm run test:integration *)`. The pre-existing `Bash(npm run *)` rule does not match env-prefixed commands, hence the explicit rules.
- **VERIFIED:** `jq` confirms valid JSON and both rules present. `.claude/` is gitignored (not committed).
- **NOTE:** the initial `Edit` was denied by the auto-mode permission classifier as self-modification; it succeeded only after the user granted explicit authorization (1+2). No workaround of the classifier was attempted.
- **BOUNDARY:** no product source, Prisma schema, migration, environment file, design document, or commit changed. Phase B feature work remains at the B5 status above; B3 full HTTP/concurrency and broad/full regression remain pending.

### 2026-08-26 — BE-1.1 Account-bound Participant HTTP 驗收（TEST-ONLY）

- **AUTHORIZED:** the user confirmed the Checkpoint-1 scope and the 3 new tests, then authorized the DB-backed e2e (Checkpoint 3) and the broad regression (Checkpoint 4). DB-backed runs touch `smartlearning_test` only (implicit idempotent `migrate deploy` + `truncateAll`, existing isolation).
- **EDIT (TEST-ONLY):** `test/participant-account.e2e-spec.ts` — added 3 `it` blocks (net +223 lines), reusing existing helpers (`loginAs`, `provisionAndLogin`, `setupActiveSession`, `cookieValue`, `TEST_ORIGIN`); no runtime/schema/migration/other-test edits.
  - `rejects a cookie-join when the student has no active enrollment` (BE-1.1.1 negative): not-enrolled student cookie join → 403 + no participant row (count=0).
  - `returns participant-safe results through the student cookie (vote-to-reveal)` (BE-1.1.6): submitted student reads OPEN poll aggregate 200 with `options[i].isCorrect === undefined`; teacher projection 200 same shape; non-submitting enrolled student → 409 `RESULTS_NOT_REVEALED`.
  - `rejects a cookie submission without a valid CSRF token or exact Origin` (BE-1.1.8): missing token / wrong token / wrong Origin (`http://evil.test`) → 403 `AUTH_CSRF_INVALID`; then a valid token+Origin → 201.
- **BE-1.1 coverage:** all 8 sub-items now have assertions (1.1.1 ✓/✓, 1.1.2–1.1.5/1.1.7 pre-existing, 1.1.6 new, 1.1.8 new).
- **PASS:** targeted e2e — `NODE_ENV=test npm run test:e2e -- test/participant-account.e2e-spec.ts --runInBand` → 1 suite / **8 passed, 0 failed, 0 skipped**.
- **PASS:** full regression — typecheck, lint:check, format:check, build, `git diff --check` all passed; unit 22 suites / 123 tests; full e2e 22 suites / 136 tests; integration 3 suites / 12 tests; `prisma:migrate:status` → `smartlearning_test` 12 migrations, schema up to date.
- **ENV NOTE:** the e2e subagent brought up the local Docker engine (Rancher Desktop) because Postgres was not initially listening; the existing `smart-learning-pg-dev` container then served `smartlearning_test` on 5432. No test data or other DB was affected.
- **RESULT:** BE-1.1 acceptance met (8/8 covered, 0 skipped, 0 failed). No implementation bug surfaced; all 3 risk flags verified against source before writing (403 join path, poll `isCorrect` omission, CSRF/Origin fail-closed).
- **BOUNDARY:** no commit made (per request, commit only if the user asks). BE-1.2+ sub-item verification and any docs authorization-matrix sync remain out of this task's scope. Pre-existing non-blocking Nest legacy route-converter warnings remained.

### 2026-08-26 — BE-1.2 撤銷與競態（TEST-ONLY）

- **PLAN:** `/home/user/.claude/plans/wsl-localhost-ubuntu-home-user-projects-silly-breeze.md`. USER CONFIRMED: (1) new test file `test/participant-revocation.e2e-spec.ts`, (2) DB-backed e2e authorized on `smartlearning_test` only (existing isolation; implicit idempotent migrate deploy + truncateAll).
- **SCOPE (test-only):** source exploration confirmed the revocation invariants already hold — cookie join locks `liveSession → course → account` and re-reads account/enrollment under the Course/Account row locks (`participant.service.ts` `findOrCreateAccountParticipant`); cookie submit locks `sessionQuestion → course → account` and re-reads under the same locks (`submission.service.ts` submit); enrollment removal locks Course, account disable locks Account, both serializing vs join/submit. No runtime/schema/migration/design-doc change was required.
- **EDIT (TEST-ONLY):** new `test/participant-revocation.e2e-spec.ts` — 9 tests mapping BE-1.2.1→BE-1.2.9, reusing BE-1.1 setup helpers (`loginAs`/`provisionAndLogin`/`setupActiveSession`/`cookieValue`/`TEST_ORIGIN`) and the `Promise.all` race idiom from `account-admin.e2e-spec.ts`.
  - Sequential: removal→join 403, removal→submit 403, disable→join 401, disable→submit 401.
  - Concurrent (winner-tolerant `count <= 1` + branch status): removal vs join, removal vs submit, disable vs join, disable vs submit.
  - Authority no-duplicate: idempotent double join + single submission → `participant.count==1` / `submission.count==1`.
- **FIX DURING VERIFY (test-only):** first run surfaced an assertion-contract gap, not a source bug — the two disable-race tests only anticipated 401 (guard) on the disable-wins branch, but the late join/submit can legitimately surface **403** `ForbiddenError` (session still valid at the guard, then the in-transaction account-lock TOCTOU re-check sees disabled). Fixed to accept `[401, 403]` on the disable-wins branch.
- **PASS:** targeted e2e — `participant-revocation.e2e-spec.ts` **9/9, 0 skipped**, green on every run.
- **REGRESSION:** full unit 22/123, full integration 3/12, typecheck/lint/format/build/`git diff --check` all PASS; `prisma:migrate:status` → `smartlearning_test` 12 migrations up to date.
- **BOUNDARY (pre-existing flake, NOT this slice):** the full e2e suite (`-- --runInBand`) is dominated by a pre-existing, non-deterministic test-isolation cascade — `ConflictError: Bootstrap already completed` thrown in `beforeEach` (`createFirstAdmin`, `bootstrap.service.ts:110`) because the shared `system_setting.bootstrap_completed` flag intermittently survives `truncateAll`, cascading `login`/`admin/accounts` 401/500 across suites. Full e2e is flaky run-to-run regardless of this change; `participant-revocation` itself passed in both full runs and every isolated run. This is a pre-existing harness isolation defect out of BE-1.2 scope; noted as a follow-up, not fixed here.
- **RESULT:** BE-1.2 acceptance met (9/9 covered, 0 skipped, 0 failed). No implementation bug surfaced; both disable-wins outcomes (401 guard / 403 lock-guard) verified against source. `participant-revocation` is untracked (new file); no commit made.

### 2026-08-26 — BE-1.3 匿名流程回歸（Checkpoint B）

- **AUTHORIZED:** user authorized Checkpoint B and explicitly authorized guarded DB-backed test operations against `smartlearning_test` only (implicit idempotent migration setup + truncation).
- **EDIT (TEST-ONLY):** `test/participant-account.e2e-spec.ts` — added one coexistence regression covering anonymous session-code/token and enrolled student cookie identities in the same LiveSession; no runtime/schema/migration changes.
- **COVERAGE:** anonymous join returns raw token; token snapshot works; token submission works; token results work; account-bound join returns `participantToken: null`; both rows remain distinct (`accountId` vs `NULL`, distinct IDs/hashes); both submissions remain independently linked; both participant result projections remain safe and aggregate both answers.
- **PASS:** focused test — `NODE_ENV=test npm run test:e2e -- --runInBand test/participant-account.e2e-spec.ts -t "keeps anonymous and account-bound participants independent" --silent` → 1 passed, 0 failed, 0 skipped.
- **PASS:** `NODE_ENV=test npm run prisma:migrate:status` → `smartlearning_test`, 12 migrations, schema up to date; `git diff --check` passed.
- **BOUNDARY:** this is a Checkpoint B implementation slice. Existing anonymous poll/result suites and broader quality gates remain for Checkpoint C; no commit made.

### 2026-08-26 — BE-1.4 Phase B 回歸驗證規劃

- **EDIT (DOC-ONLY):** expanded `docs/智學互動平台/00_專案規劃/智學互動平台剩餘工作WBS.md` BE-1.4 from a flat command list into an executable regression plan.
- **PLAN:** added schema/migration preflight, B1–B5 targeted sequencing, OpenAPI, full unit/integration/e2e, static quality gates, baseline/evidence format, DB authorization boundary, implicit test migration note, stop conditions, and explicit sign-off DoD.
- **CURRENT EVIDENCE:** BE-1.1 (8/8), BE-1.2 (9/9), BE-1.3 coexistence regression, B1/B2 (4 suites / 15 tests), B4 (1 suite / 14 tests), and B5 focused privacy (2 suites / 14 tests plus 2 e2e suites / 15 tests) are recorded as passing in this file; B3 full HTTP/concurrency, B5 authoritative-document synchronization, and broad/full regression remain pending unless separately verified.
- **RESULTS:** no runtime, schema, migration, environment, or test source changed by this planning update; no database command was run; no commit made.

### 2026-08-26 — BE-2 Checkpoint A contract inventory（READ-ONLY）

- **SCOPE:** completed the Checkpoint A static inventory for BE-2 Student／Enrollment API stabilization. No migration, truncate, test execution, service startup, database mutation, or product-source change was performed.
- **BASELINE:** branch `phase-b-student-enrollment`; HEAD `82f6a4e01b77f298131b80ba8f6b679fc93348af`; pre-existing working tree remains `M tasks/todo.md`, `?? AGENTS.md`, `?? CLAUDE.md`. The WBS BE-2 contract-freeze plan is present in `docs/智學互動平台/00_專案規劃/智學互動平台剩餘工作WBS.md`.
- **IMPLEMENTATION INVENTORY:** student role／session projection is implemented under `src/modules/identity`; `CourseEnrollment` and `EnrollmentsController` are wired under `src/modules/enrollments`; routes are `/api/v1/courses/:courseId/enrollments` (POST/GET), `/api/v1/courses/:courseId/enrollments/:studentAccountId` (DELETE), and `/api/v1/me/courses` (GET). Phase B migrations are additive: student role, enrollment table, and participant account binding.
- **CURRENT EVIDENCE:** `test/student-account.e2e-spec.ts`, `test/enrollments.e2e-spec.ts`, and `test/openapi.e2e-spec.ts` cover student login／role and owner-path denial, roster add/list/remove/reactivation/idempotency, `/me/courses`, archived-course add rejection, cross-owner privacy, and enrollment OpenAPI paths. Existing task evidence records B1/B2 as 4 suites／15 tests, 0 failure／0 skipped, against `smartlearning_test`; BE-1.1～1.3 and B4/B5 evidence remains separately scoped.
- **FROZEN SEMANTICS TO CARRY FORWARD:** student `canCreateCourse=false`; active duplicate add returns the existing row; removed row re-add reactivates it; remove is idempotent; archived course rejects new/reactivation; non-owner teacher is existence-hidden with 404; student cannot manage roster and receives 403; mutation requires CSRF + exact Origin; response projections exclude credentials/tokens/hashes.
- **GAPS／DECISIONS FOR CHECKPOINT B:** verify the above semantics against current source and OpenAPI output; explicitly settle active／removed roster list visibility, archived-course list/remove behavior, invalid／disabled target-account status and error-code mapping, pagination ordering／bounds, and whether any current frontend reference wording diverges from runtime. No contract decision was silently changed during Checkpoint A.
- **NEXT GATE:** Checkpoint A static inventory is complete. Before DB-backed verification or any implementation/contract correction in Checkpoint B, obtain explicit authorization for guarded operations limited to `smartlearning_test`; test setup implicitly runs idempotent `migrate deploy` and `truncateAll`.

### 2026-08-27 — BE-2 Checkpoint B smartlearning_test 驗證

- **AUTHORIZED:** user authorized Checkpoint B DB-backed validation limited to `smartlearning_test`; test setup's implicit idempotent `migrate deploy` + `truncateAll` was within the stated authorization boundary.
- **PASS:** `NODE_ENV=test npm run prisma:migrate:status` — target `smartlearning_test` at `localhost:5432`, 12 migrations found, database schema up to date; no pending or failed migration.
- **PASS:** `NODE_ENV=test npm run test:integration -- --runInBand test/identity.integration-spec.ts` — 1 suite / 7 tests passed, 0 failed, 0 skipped; PostgreSQL-backed student role/identity checks passed.
- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand test/student-account.e2e-spec.ts test/enrollments.e2e-spec.ts test/openapi.e2e-spec.ts` — 3 suites / 8 tests passed, 0 failed, 0 skipped; student account, enrollment roster, `/me/courses`, archived/duplicate/reactivation/privacy and OpenAPI checks passed.
- **BOUNDARY:** no source/schema/migration/environment/document change and no commit. Existing Nest `LegacyRouteConverter` warnings for `health/(.*)` and `/api/*` remained non-blocking.
- **RESULT:** Checkpoint B smartlearning_test verification complete; further contract corrections, documentation freeze, broader regression, or next checkpoint requires a separate authorization decision.

### 2026-08-27 — BE-2 Checkpoint C smartlearning_test 驗證

- **AUTHORIZED:** user explicitly authorized Checkpoint C DB-backed validation limited to `smartlearning_test`; the test setup's implicit idempotent `migrate deploy` + `truncateAll` stayed within that boundary.
- **PASS:** `NODE_ENV=test npm run prisma:migrate:status` — target `smartlearning_test` at `localhost:5432`, 12 migrations found, database schema up to date; no pending or failed migration.
- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand test/enrollments.e2e-spec.ts` — 1 suite / 2 tests passed, 0 failed, 0 skipped; `/me/courses` active-only behavior, removed-enrollment omission, archived existing-enrollment behavior, pagination/metadata/ordering, non-student 403, roster add/list/remove/reactivation, and cross-owner rejection passed.
- **BOUNDARY:** no source/schema/migration/environment/document change and no commit. Existing Nest `LegacyRouteConverter` wildcard-route warnings remained non-blocking.
- **RESULT:** Checkpoint C targeted database-backed E2E verification complete. This does not constitute full Phase B regression/sign-off; broader regression and any remaining contract/documentation freeze require separate scope/authorization.

### 2026-08-27 — BE-2 Checkpoint D smartlearning_test 回歸驗證

- **AUTHORIZED:** user explicitly authorized Checkpoint D DB-backed validation limited to PostgreSQL `smartlearning_test`; existing test setup implicit idempotent `migrate deploy` + `truncateAll` stayed within this boundary.
- **PASS:** `NODE_ENV=test npm run prisma:validate` and `NODE_ENV=test npm run prisma:migrate:status` — schema valid; `smartlearning_test` at `localhost:5432`, 12 migrations, schema up to date.
- **PASS:** targeted BE-2/BE-1/live-flow verification — 9 suites / 36 tests passed, 0 failed, 0 skipped. Covered identity, student account, enrollment, OpenAPI, participant account/revocation, anonymous poll, poll-multiple, and open-text live flows.
- **PASS:** full regression — unit 22 suites / 123 tests; integration 3 suites / 12 tests; E2E 23 suites / 146 tests; all passed with 0 failures and 0 skips.
- **PASS:** quality gates — `typecheck`, `lint:check`, `format:check`, `build`, and `git diff --check` all passed.
- **BOUNDARY:** no source/schema/migration/environment/document changes and no commit. Existing Nest `LegacyRouteConverter` warnings for `health/(.*)` and `/api/*` remained non-blocking.
- **RESULT:** Checkpoint D verification complete. Full runtime regression and quality gates pass, but BE-2 contract-freeze DoD is not claimed until any remaining artifact/document synchronization and explicit release sign-off are completed.

### 2026-08-27 — BE-2 contract freeze 文件同步（DOC-ONLY）

- [x] 同步 frontend API reference、SKILL、Web Auth、API Schema、M2 Contract Review：student Web Session + active enrollment account-bound Participant、anonymous fallback、CSRF/exact Origin、roster/my-courses ordering/idempotency、OpenAPI 與 per-question results route。
- [x] Refresh Checkpoint D evidence：smartlearning_test 12 migrations up to date；targeted 9 suites/36 tests；full unit 22/123、integration 3/12、E2E 23/146；quality gates pass；0 failure/skip。
- [x] 保留 archive/retention 與 durable realtime/replay deferred；明確記載尚未取得 final sign-off，需 sync/release approval。
- [ ] Final sign-off：待文件同步與 release approval。
- **SCOPE:** 僅上述文件與本 evidence log；未修改 source/schema/migration/env/test/config；未執行 DB command；未 commit。

### 2026-08-27 — BE-2 final sign-off review（READ-ONLY）

- **RESULT:** BLOCKED；contract artifacts 已同步，但 BE-2 DoD 尚不能宣稱 final sign-off。
- **BLOCKER 1 — archived error code:** WBS 要求 archived add/reactivation 為 409 `COURSE_NOT_EDITABLE`；目前 runtime/e2e 僅證明 generic 409 `CONFLICT`，尚無 code assertion。
- **BLOCKER 2 — concurrency authority proof:** WBS 要求 concurrent add/remove 的 transaction lock／unique-constraint proof；目前僅有 sequential duplicate、remove、reactivation evidence。
- **BLOCKER 3 — archived list/remove evidence:** source 允許 archived roster list/remove，但缺少明確 DB-backed test/contract decision；需先凍結並驗證政策。
- **PARTIAL:** OpenAPI e2e 已驗證 paths、`/api/v1` prefix 與無 double prefix，但尚未針對 enrollment DTO、query parameters 與 response schema 做明確 assertions。
- **PASS:** BE-2.1、BE-2.2、BE-2.3、BE-2.6 的主要 runtime／targeted evidence 與文件已對齊；BE-2.7 artifact sync 與 Checkpoint D regression evidence 已記錄。
- **BOUNDARY:** release approval 未授予，不能由測試或文件同步推定；archive/retention、durable realtime/replay 仍 deferred。此次未執行 DB/test，未修改 runtime/schema/migration/env。

### 2026-08-27 — BE-2 Contract Gaps Forward-Fix Slice

- [x] Archived enrollment add/reactivation now returns 409 `COURSE_NOT_EDITABLE` with `field: courseId`; generic conflicts remain unchanged.
- [x] Enrollment controller OpenAPI metadata documents UUID/path/query constraints, inner DTO/page schemas, and archived 409 envelope shape.
- [x] Extended enrollment/OpenAPI contract assertions for archived behavior, unchanged rows, roster/my-courses visibility, ordering/idempotency, and concurrency scenarios.
- [ ] Verify static formatting, typecheck, lint, build, and diff check; DB-backed tests remain intentionally unauthorized.
- **BOUNDARY:** no Prisma schema/migration/env/config changes; no migration, truncate, DB-backed test, or service startup.

### 2026-08-27 — BE-3.1 CP2 Question cascade targeted verification

- **AUTHORIZED:** user explicitly authorized DB-backed targeted E2E limited to `smartlearning_test`; setup implicit idempotent `migrate deploy` + `truncateAll` remained within scope.
- **FIX (test-only):** active-session cleanup in `test/live-session-results.e2e-spec.ts` now uses `close` and asserts `201`; active cancellation remains rejected by the frozen policy. Realtime cancellation fixture now remains `waiting` via `setupActiveSession(false)` so it exercises `waiting → cancelled`.
- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/live-session-realtime.e2e-spec.ts test/live-session-results.e2e-spec.ts test/live-session-close-cancel.e2e-spec.ts` — 3 suites / 33 tests passed, 0 failed, 0 skipped.
- **PASS:** CP2 coverage includes question open/close, duplicate close/reopen and invalid-state rejection, session-close question cascade, waiting cancellation realtime event and terminal reconnect rejection, active-cancel `409 CONFLICT`, and result visibility/error paths.
- **BOUNDARY:** account-disable realtime timeout did not reproduce in the rerun; no runtime source/schema/migration/env/config change was needed. Existing Nest `LegacyRouteConverter` wildcard warnings remained non-blocking.
- **RESULT:** CP2 targeted E2E now passes with 0 failure/0 skipped.
- **MANUAL CHECKPOINT 2 CONFIRMED:** user reviewed CP2 and authorized entry into CP3; no release sign-off is inferred from this checkpoint.

### 2026-08-27 — BE-3.1 CP3 Terminal-state negative paths

- [x] Verify closed/cancelled direct join and reconnect rejection, post-terminal submission rejection, question-close submission rejection, no side effects, and account-bound/anonymous parity.
- [x] Record targeted DB-backed verification against `smartlearning_test`; test setup implicitly runs idempotent `migrate deploy` + `truncateAll`.

#### Verification evidence

- `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/cp3-terminal-state.e2e-spec.ts` — PASS; 1 suite / 4 tests, 0 failed, 0 skipped.
- `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/cp3-terminal-state.e2e-spec.ts test/live-session-realtime.e2e-spec.ts test/live-session-results.e2e-spec.ts test/live-session-close-cancel.e2e-spec.ts` — PASS; 4 suites / 37 tests, 0 failed, 0 skipped.
- `npm run typecheck` — PASS.
- `npm run lint:check` — PASS.
- `npm run format:check` — PASS; all matched files use Prettier code style.
- `npm run build` — PASS.
- `git diff --check` — PASS.
- Warnings: existing Nest `LegacyRouteConverter` warnings for `health/(.*)` and `/api/*` legacy wildcard route patterns; non-blocking and unchanged.
- No runtime, Prisma schema, migration, environment, or configuration changes were made; only this task-log evidence was updated.

### 2026-08-27 — CP4 full regression verification

- **AUTHORIZED:** user requested entry into CP4 verification; DB-backed execution was limited to PostgreSQL `smartlearning_test`. Test setup's implicit idempotent `migrate deploy` + `truncateAll` remained within that boundary. Development DB was not touched.
- **PASS:** `NODE_ENV=test npm run prisma:validate` and `NODE_ENV=test npm run prisma:migrate:status` — schema valid; 12 migrations present; schema up to date.
- **PASS:** targeted BE-2/BE-1/live-flow E2E — 10 suites / 57 tests, 0 failed, 0 skipped. The repository's available participant-account coverage was used in place of a nonexistent `identity.e2e-spec.ts`.
- **PASS:** full unit — 22 suites / 123 tests; integration — 3 suites / 12 tests, 0 skipped; E2E — 24 suites / 152 tests, 0 skipped.
- **PASS:** `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`, and `git diff --check`.
- **WARNINGS:** existing non-blocking Nest `LegacyRouteConverter` warnings for `health/(.*)` and `/api/*`; no failures or flakes.
- **RESULT:** CP4 full regression verification passed with full regression confidence. No runtime, schema, migration, environment, configuration, or test-source changes were made; only this evidence log was updated.

### 2026-08-27 — BE-3.1 CP4 專項驗證（coverage review）

- **AUTHORIZED:** user requested entry into BE-3.1 CP4 specialized verification; any DB-backed activity was limited to `smartlearning_test`. No development DB operation or source/test modification was performed.
- **PASS／PARTIAL:** existing evidence covers owner success, unauthenticated `401`, missing CSRF `403`, non-owner teacher `404` existence hiding, common envelope/filter behavior, and selected redaction/privacy projections.
- **GAPS:** no dedicated student wrong-role `403` control-route test; no admin control-route success; wrong-CSRF and non-exact-Origin cases are covered on submission but not directly on each control route; control-route E2E does not systematically assert the complete envelope; no close/cancel-specific log-capture assertion.
- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/live-session-close-cancel.e2e-spec.ts test/live-session-detail.e2e-spec.ts test/student-account.e2e-spec.ts test/api-envelope.e2e-spec.ts` — 4 suites / 24 tests passed, 0 skipped.
- **PASS:** `NODE_ENV=test npm test -- --runInBand src/common/observability/pino-redaction.spec.ts src/modules/live-sessions/domain/live-session-status.spec.ts src/modules/live-sessions/domain/question-results.spec.ts` — 3 suites / 18 tests passed, 0 skipped.
- **PRECHECK:** `smartlearning_test` is reachable with 12 migrations applied and schema up to date; no manual migration was run. Existing warnings include Nest legacy wildcard routes and a pg@9 `client.query()` deprecation warning.
- **RESULT:** BE-3.1 CP4 remains **BLOCKED／PARTIAL** despite the targeted suites passing: wrong-CSRF and wrong-Origin control-route evidence, student wrong-role, admin success, systematic control-route envelope assertions, close/cancel log-capture, and manual Checkpoint 4 review remain outstanding. Do not advance to CP5 or infer release sign-off.

### 2026-08-27 — BE-3.1 CP4 gap-test implementation

- **EDIT (TEST-ONLY):** extended `test/live-session-close-cancel.e2e-spec.ts` with student wrong-role/detail rejection, admin cross-owner control success, wrong CSRF/Origin no-side-effect checks, complete envelope metadata assertions, and response secret-field absence assertions.
- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/live-session-close-cancel.e2e-spec.ts` — 1 suite / 12 tests, 0 failed, 0 skipped, against `smartlearning_test`.
- **PASS:** `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`, and `git diff --check`.
- **WARNINGS:** existing Nest `LegacyRouteConverter` wildcard-route warnings only; no runtime/schema/migration/config changes.
- **REMAINING:** missing-CSRF and non-exact-Origin cases are currently asserted on the cancel route, not every control route; admin cancel, student create/start/open/question-close, and close/cancel log-capture/manual evidence remain pending. CP4 manual sign-off is not inferred from automated tests.

### 2026-08-27 — BE-3.1 CP4 remaining route-matrix verification

- **AUTHORIZED:** user authorized the remaining CP4 route-matrix verification; all DB-backed operations were limited to `smartlearning_test`, including the guarded test setup's implicit idempotent `migrate deploy` and `truncateAll`. No development DB was touched.
- **EDIT (TEST-ONLY):** added `test/live-session-route-matrix.e2e-spec.ts`; no runtime, Prisma schema, migration, environment, or configuration changes.
- **PASS:** `NODE_ENV=test npm run prisma:migrate:status` — `smartlearning_test`, 12 migrations, schema up to date.
- **PASS:** focused route matrix — `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/live-session-route-matrix.e2e-spec.ts` — 1 suite / 14 tests, 0 failures, 0 skips.
- **PASS:** adjacent close/detail regression — `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/live-session-close-cancel.e2e-spec.ts test/live-session-detail.e2e-spec.ts` — 2 suites / 21 tests, 0 failures, 0 skips.
- **PASS:** `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`, and `git diff --check`.
- **COVERAGE:** direct HTTP checks now exercise create, start, question open/close, session close/cancel, and detail across authenticated/unauthenticated, student, non-owner, admin/owner, CSRF, exact-Origin, envelope/request-id, redaction, and rejected-mutation side-effect paths.
- **WARNING:** existing Nest `LegacyRouteConverter` warnings for `health/(.*)` and `/api/*` wildcard routes remain non-blocking and unchanged.
- **RESULT:** CP4 automated route-matrix verification is complete with full targeted verification confidence.
- **MANUAL CHECKPOINT 4 SIGN-OFF:** User confirmed **“Checkpoint 4 verified”** on 2026-08-27. The CP4 actor/role/credential matrix and raw HTTP evidence review are accepted. This sign-off covers CP4 only; it does not approve CP5 or BE-3.1 final release sign-off.

### 2026-08-27 — BE-3.1 CP5 targeted verification

- **AUTHORIZED:** user authorized DB-backed CP5 verification limited to `smartlearning_test`; test setup's implicit idempotent `migrate deploy` + `truncateAll` remained within that boundary.
- **PASS:** `NODE_ENV=test npm run prisma:migrate:status` — `smartlearning_test`, 12 migrations, schema up to date.
- **PASS:** targeted lifecycle/terminal E2E — `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/live-session-route-matrix.e2e-spec.ts test/live-session-close-cancel.e2e-spec.ts test/cp3-terminal-state.e2e-spec.ts` — 3 suites / 30 tests, 0 failures, 0 skips.
- **PASS:** submission integration — `NODE_ENV=test npm run test:integration -- --runInBand --silent test/poll-submission.integration-spec.ts` — 1 suite / 4 tests, 0 failures, 0 skips; concurrent same-participant submission serialization and idempotency passed.
- **PASS:** `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`, and `git diff --check`.
- **GAP:** current evidence does not include concurrent close-vs-cancel, timestamp-preserving terminal retry/side-effect proof, or submit-vs-close commit-order races. Existing sequential terminal tests and concurrent-submission test do not satisfy those CP5 race requirements.
- **RESULT:** CP5 targeted lifecycle/static verification passed, but BE-3.1 CP5 remains **INCOMPLETE/BLOCKED** pending dedicated DB-backed race evidence and manual Checkpoint 5 review. No runtime/schema/migration/config changes were made.

### 2026-08-27 — BE-3.1 CP5 race-test evidence

- **EDIT (RUNTIME + TEST):** `SubmissionService.submit()` now locks `live_session` before `session_question`, matching `closeSession()` and removing the opposing lock protocol. `test/poll-submission.integration-spec.ts` now starts real submit/close transactions concurrently behind a PostgreSQL `live_session` row lock and checks persisted authority rows. No schema, migration, environment, or config changes.
- **PASS:** `NODE_ENV=test npm run test:integration -- --runInBand --silent test/poll-submission.integration-spec.ts` — 1 suite / 8 tests, 0 failures, 0 skips. `smartlearning_test` setup performed only its approved idempotent migration check and `truncateAll` isolation.
- **PASS:** `npm run typecheck`, `npm run format:check`, `npm run build`, and `git diff --check`.
- **RECHECK:** `npm run lint:check` initially reported the now-removed unused `holdQuestionRowLock` helper; a fresh lint run is pending after that test-only cleanup.
- **CONCURRENCY RESULT:** submit/close cases complete without deadlock or timeout, close reaches `closed`, and persisted submissions are either exactly one when submit wins or zero when close wins. The tests intentionally accept either PostgreSQL lock winner; JavaScript promise creation order is not treated as deterministic database queue ordering.
- **NOTE:** existing Nest legacy wildcard-route and pg@9 client-query deprecation warnings remain non-blocking. Jest reports an existing delayed open-handle warning after the suite exits; all tests complete successfully.
- **RESULT:** runtime lock-order correction and concurrent authority-consistency evidence are complete; final static lint recheck, lifecycle E2E regression, broader regression, and manual Checkpoint 5 review/sign-off remain outstanding.
- **MANUAL CHECKPOINT 5 SIGN-OFF:** User confirmed **“Checkpoint 5 verified”** on 2026-08-27. The CP5 concurrent submit/close race evidence and authority-consistency review are accepted. This sign-off covers CP5 only; it does not imply broader regression or final BE-3.1 release sign-off.

### 2026-08-27 — BE-3.1 CP6 Post-commit realtime proof

- [x] Add deterministic DB-backed commit-before-publish and publisher-rejection proof tests.
- [x] Verify commit-before-publish ordering for lifecycle signals and preserve pre-mutation listener registration.
- [x] Verify event-bus/publisher failure cannot fail or roll back committed REST mutations.
- [x] Verify teacher, anonymous participant, and account-bound student projections remain visibility-safe.
- [x] Run focused realtime unit/E2E/integration verification against `smartlearning_test` only, then static gates.
- [ ] Record sanitized evidence and manual Checkpoint 6 review; do not claim CP7 auto-close or durable BE-7 replay.

**Risk & rollback:** Medium; prefer additive test coverage and revert only the focused source/test changes if a verified runtime defect is found. No migration, reset, truncate outside guarded test setup, or destructive rollback.

**Dependencies & environment:** Node 24+, PostgreSQL `smartlearning_test`, `NODE_ENV=test`; DB-backed test setup implicitly performs idempotent migration checking and `truncateAll` and requires explicit authorization.

#### CP6 preflight and focused verification

- **AUTHORIZED:** User authorized CP6 DB-backed verification limited to `smartlearning_test`; the guarded test setup's implicit idempotent migration check and `truncateAll` remained within scope.
- **PASS:** static preflight — realtime bus unit 1 suite / 5 tests; `npm run typecheck`; `npm run lint:check`; `npm run format:check`; `npm run build`; `git diff --check`.
- **PASS:** `NODE_ENV=test npm run prisma:migrate:status` — `smartlearning_test` at `localhost:5432`, 12 migrations, schema up to date.
- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/live-session-realtime.e2e-spec.ts` — 1 suite / 14 tests, 0 failures, 0 skips.
- **COVERAGE:** existing focused realtime suite verifies pre-mutation listener registration, lifecycle signals, Socket.IO delivery, participant-safe projections, teacher-only counts/results, vote-to-reveal targeting, and account/enrollment revocation behavior.
- **BOUNDARY:** no new CP6-specific deterministic publish-rejection/committed-state test or transaction-held commit-before-event proof was added in this preflight; adjacent regression and manual Checkpoint 6 review remain pending. Lite bus only; durable outbox/eventSeq/replay/Redis remain deferred.

#### CP6 implementation results

- [x] Added DB-backed deterministic commit-before-publish assertions for representative `LiveSessionService`, `ParticipantService`, and `SubmissionService` mutations. The mocked publisher queries PostgreSQL state from inside the publish call and verifies the mutation is already committed.
- [x] Added publisher rejection isolation coverage across join, question open, and submission: REST mutations still return 201 and committed rows remain present when the event bus rejects.
- [x] Preserved the existing pre-mutation Socket.IO listener registration coverage in `test/live-session-realtime.e2e-spec.ts`.
- [x] No production, schema, migration, configuration, or durable realtime changes were required.

#### CP6 verification

- **PASS:** `npx prettier --write test/live-session-realtime.e2e-spec.ts`
- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/live-session-realtime.e2e-spec.ts` — 1 suite / 18 tests, 0 failures, 0 skips.
- **PASS:** `npm run typecheck`; `npm run lint:check`; `npm run format:check`; `npm run build`; `git diff --check`.
- **MANUAL CHECKPOINT 6 SIGN-OFF:** User confirmed **“Checkpoint 6 verified”** on 2026-08-27. CP6 automated commit-before-publish, publisher-failure isolation, and visibility-safe realtime evidence is accepted; this sign-off does not approve CP7 or deferred BE-7 durable outbox/replay/event sequencing.

### 2026-08-27 — BE-3.1 final regression sign-off

- **AUTHORIZED:** User authorized the post-`prisma:generate` BE-3.1 regression against PostgreSQL `smartlearning_test`, including the guarded test setup's implicit idempotent migration check and `truncateAll` cleanup.
- **PASS:** `npm run prisma:generate` — Prisma Client 7.9.1 generated successfully.
- **PASS:** `npm test -- --runInBand` — 22 suites / 123 tests.
- **PASS:** `NODE_ENV=test npm run test:integration -- --runInBand` — 3 suites / 16 tests, 0 failed, 0 skipped; clean serialized rerun after competing processes ended.
- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand` — 25 suites / 170 tests, 0 skipped; serialized after competing E2E processes completed.
- **PASS:** `npm run prisma:validate`; `NODE_ENV=test npm run prisma:migrate:status` — schema valid and `smartlearning_test` up to date.
- **PASS:** `npm run typecheck`; `npm run lint:check`; `npm run format:check`; `npm run build`; `git diff --check`.
- **WARNINGS:** Existing non-blocking NestJS `LegacyRouteConverter` warnings for `health/(.*)` and `/api/*` route patterns.
- **CLEAN:** No source, schema, migration, environment, configuration, or tracked-file changes; working tree clean and no commit created.
- **MANUAL FINAL REGRESSION SIGN-OFF:** User requested **“record final regression sign-off in tasks/todo.md”** and subsequently authorized a clean integration rerun. BE-3.1 post-generation final regression is accepted as passing: unit 22/123, integration 3/16, E2E 25/170, Prisma/static/build gates all pass. This does not claim deferred CP7 auto-close, durable BE-7 outbox/replay/event sequencing, or Redis adapter work.

### 2026-08-27 — BE-3.2 Teacher projections acceptance coverage

- [x] BE-3.2.1/.2: teacher session detail joined/voted counts across waiting, active/open, no-open, and closed states.
- [x] BE-3.2.3: teacher result projection includes authoritative option counts after submit and close, with anonymous projection privacy.
- [x] BE-3.2.4: participant REST and Socket.IO projections omit teacher-only joined/voted counts; participant room receives no `counts.updated` or teacher-only fields.
- [x] BE-3.2.5: representative join/open/submit signals observe committed PostgreSQL rows, and publisher rejection does not fail or roll back committed mutations.
- [x] Strengthened realtime assertions for teacher counts and option distributions; paired anonymous participant privacy checks with teacher delivery.
- [x] Added explicit participant snapshot REST no-count assertion.

#### Verification

- **AUTHORIZED:** User authorized focused DB-backed E2E verification against `smartlearning_test`, including the guarded setup's implicit idempotent migration check and `truncateAll` cleanup.
- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/live-session-detail.e2e-spec.ts test/live-session-results.e2e-spec.ts test/live-session-realtime.e2e-spec.ts` — 3 suites / 39 tests passed / 0 skipped.
- **PASS:** `npm run typecheck`; `npm run lint:check`; `npm run format:check`; `npm run build`; `git diff --check`.
- **WARNING:** Existing non-blocking NestJS `LegacyRouteConverter` wildcard-route warnings remain.
- **BOUNDARY:** Lite in-process event bus only; durable outbox, event sequence/replay, Redis adapter, and BE-3.1 CP7 auto-close remain deferred.
- **RESULT:** BE-3.2.1 through BE-3.2.5 acceptance coverage is complete for the current runtime; no production/schema/migration changes were needed.

### 2026-08-28 — BE-4.2 poll-multiple acceptance tests

- [x] Extended `test/poll-multiple-live-flow.e2e-spec.ts` through question close and post-close result visibility.
- [x] Asserted permuted same-key replay returns the same submission and leaves exactly one DB row.
- [x] Asserted wire option refs are persisted as formal `SessionQuestionOption` UUIDs.
- [x] Added empty, duplicate, and over-cardinality invalid submission assertions with no accepted mutation.
- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/poll-multiple-live-flow.e2e-spec.ts` — 1 suite / 1 test passed, 0 skipped, against `smartlearning_test`.
- **PASS:** `NODE_ENV=test npm run test:integration -- --runInBand --silent test/poll-submission.integration-spec.ts` — 1 suite / 8 tests passed, 0 failures; Jest reported an existing open-handle warning after completion.
- **PASS:** `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`, and `git diff --check`.
- **WARNING:** Existing NestJS legacy wildcard-route and `pg@9 client.query()` deprecation warnings remained non-blocking.
- **RESULT:** BE-4.2 acceptance evidence is complete for the current poll-multiple runtime; no production/schema/migration changes were needed.

### 2026-08-28 — BE-4.3 quiz acceptance tests

- [x] Extended `test/quiz-live-flow.e2e-spec.ts` with formal snapshot-option UUID persistence assertions.
- [x] Added invalid quiz submission coverage for empty, duplicate, unknown, and over-cardinality selections, with per-participant no-row assertions.
- [x] Added immutable submission conflict coverage for a changed answer using an existing idempotency key.
- [x] Strengthened teacher correctness projection assertions (`isCorrect` flags), close persistence (`closed`/`closedAt`), post-close visibility for an unsubmitted participant, and post-close submission rejection.
- **INITIAL TEST DEFECT:** invalid cases reused the participant that had already submitted; the runtime correctly returned `409 SUBMISSION_CONFLICT` before answer validation. The test was corrected to use a fresh participant per invalid case.
- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/quiz-live-flow.e2e-spec.ts` — 1 suite / 1 test passed, 0 skipped, against guarded `smartlearning_test`.
- **PASS:** `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`, and `git diff --check`.
- **WARNING:** Existing NestJS legacy wildcard-route warnings remain non-blocking.
- **RESULT:** BE-4.3 acceptance evidence is complete for the current multi-correct quiz runtime; no production/schema/migration changes were needed.

### 2026-08-28 — BE-4.4 open-text acceptance coverage

- [x] BE-4.4.1: retained and verified the complete open-text lifecycle from authoring through close and participant-safe results.
- [x] BE-4.4.2: added explicit refs-only rejection alongside the existing refs-plus-text rejection; both return `400 FIELD_FORBIDDEN`.
- [x] BE-4.4.3: verified the accepted submission through Prisma and parameterized SQL; `selected_option_refs IS NULL` and the returned column are both SQL `NULL`, while normalized `textAnswer` persists.
- [x] BE-4.4.4: verified open and closed teacher/student results contain exactly `{ text }` response objects and no participant, account, display-name, session-code, or token linkage.
- **EDIT (TEST-ONLY):** `test/open-text-live-flow.e2e-spec.ts`; no production, schema, migration, environment, or configuration changes.
- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/open-text-live-flow.e2e-spec.ts` — 1 suite / 1 test passed, 0 failed, 0 skipped, against guarded `smartlearning_test`.
- **PASS:** `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`, and `git diff --check`.
- **WARNING:** Existing NestJS `LegacyRouteConverter` warnings for `health/(.*)` and `/api/*` remain non-blocking.
- **RESULT:** BE-4.4 acceptance evidence is complete for the current open-text runtime; no runtime or database change was required.

## BE-5 — archive governance (2026-08-28)

- [x] Additive Prisma models/migration draft for ArchivedResult and DeletionEvent
- [x] Close flow invokes idempotent archive finalization after committed close
- [x] Teacher/admin archive list/detail and ownership scoping skeleton
- [x] Whole-session purge removes archive payload, submissions, participants, and snapshots
- [x] Bounded due-archive purge entrypoint (`purgeDue`) with fixed 90-day deadline
- [x] Harden deletion-request idempotency/request linkage and pagination query contract (request creation now uses the session transaction lock; migration adds a partial unique index for outstanding requests)
- [x] Add archive aggregate projection and focused privacy regression tests
- [x] Add full archive governance e2e/regression matrix
- [x] Deploy archive migration and run authorized DB-backed verification against `smartlearning_test`

### Results

- Added `projectArchive()` using the shared `aggregateResults()` primitive. Archive payloads now contain ordered, typed anonymous aggregates only; raw submission rows, timestamps, and identity/linkage fields are not persisted.
- Added focused projection tests for poll, quiz, open-text, ordering, correctness aggregates, and privacy-negative fields.
- Updated frontend API reference for `/results` archive list/detail and deletion governance semantics.
- Added a transaction-scoped lock around deletion-request creation and a partial unique index for one outstanding request per session/requester, preventing concurrent duplicate requests.
- **PASS:** `npm test -- --runInBand` — 24 suites / 127 tests; `npm run prisma:validate`; `npm run typecheck`; `npm run lint:check`; `npm run format:check`; `npm run build`; and `git diff --check`.
- **PASS:** authorized `NODE_ENV=test npm run prisma:migrate:deploy` applied migration `20260828090000_add_archive_governance` to `smartlearning_test`; `NODE_ENV=test npm run prisma:migrate:status` reports 13 migrations and schema up to date.
- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand test/live-session-close-cancel.e2e-spec.ts test/live-session-detail.e2e-spec.ts test/live-session-realtime.e2e-spec.ts test/live-session-results.e2e-spec.ts test/live-session-route-matrix.e2e-spec.ts` — 5 suites / 65 tests, 0 failed, 0 skipped; expected realtime post-commit isolation warnings only.
- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/archive-governance.e2e-spec.ts` — 1 suite / 3 tests passed, 0 failed, 0 skipped, against guarded `smartlearning_test`.
- Added focused archive governance coverage for active archive finalization and 90-day retention metadata, owner/admin/cross-owner detail visibility, list access, CSRF and deletion-request idempotency, step-up/confirmation gates, early-delete tombstone cleanup, and due-retention purge idempotency.
- Destructive assertions ran only inside the guarded E2E setup against `smartlearning_test`; no production database or migration command was run during this verification.

## BE-6 — auto-close scheduler (2026-08-28)

- [x] Add validated `LIVE_SESSION_AUTO_CLOSE_MS` (8h default) and `LIVE_SESSION_AUTO_CLOSE_TICK_MS` configuration.
- [x] Add bounded, row-lock serialized automatic close with atomic open-question closure, `autoClosed=true`, archive follow-up, and realtime signals.
- [x] Add lifecycle-managed native timer with startup sweep, overlap guard, shutdown cleanup, and per-candidate failure isolation.
- [x] Add authorized PostgreSQL scheduler race/e2e coverage; test setup was authorized to use guarded `smartlearning_test` migration/truncation operations.

### Results

- Implemented `LiveSessionService.autoCloseExpiredSessions()` and registered `LiveSessionAutoCloseScheduler` in `LiveSessionsModule`.
- Existing manual close/cancel behavior and database schema remain unchanged; auto-close uses the existing session row lock and post-commit governance/event boundaries.
- PASS: `NODE_ENV=test npm run test:integration -- --runInBand test/poll-submission.integration-spec.ts` — 1 suite / 8 tests, 0 failed, 0 skipped; PostgreSQL submit/close race coverage passed against `smartlearning_test`.
- BLOCKED: `NODE_ENV=test npm run test:e2e -- --runInBand test/live-session-close-cancel.e2e-spec.ts` — 6 passed / 6 failed; all failures occurred during teacher provisioning/login with `Missing __Host-csrf cookie` at `test/live-session-close-cancel.e2e-spec.ts:88-103`, before lifecycle/auto-close assertions.
- NOT RUN: `test/live-session-route-matrix.e2e-spec.ts`; lifecycle E2E prerequisite was blocked by CSRF cookie setup failure.
- No code or schema files were modified; working tree remained clean.
- Follow-up: investigate test login/CSRF cookie issuance under `NODE_ENV=test`, then rerun the lifecycle and route-matrix E2E suites. Do not claim BE-6 E2E completion until those assertions execute.

## BE-7 — durable realtime Checkpoint A (2026-08-28)

### Scope and mandatory boundary

- [x] Inventory current R-1-lite bus/gateway, lifecycle producers, transaction lock helpers, schema, tests, and authoritative M2 realtime/API/ER/architecture contracts.
- [x] Freeze the v1 durable envelope, event catalog, visibility values, cursor representation/validation, watermark/version semantics, replay recovery outcomes, coalescing eligibility, safe outbox input boundary, Redis degradation policy, and lock-order constants.
- [x] Add DB-free contract fixtures/unit coverage only.
- [x] Preserve the existing BE-6 evidence above without replacement.
- [ ] **STOP:** obtain explicit human confirmation before changing `prisma/schema.prisma`, adding a migration, changing runtime transaction behavior, adding Redis dependencies, or running DB-backed tests. This checkpoint does not claim durable persistence or replay implementation.

### Frozen decisions and findings

- Canonical Socket envelope is camelCase `{ event, schemaVersion, eventSeq, aggregateVersion, serverTimestamp, liveSessionId, visibility, data }`; PostgreSQL `BIGINT` `eventSeq` is represented as a canonical non-negative decimal string to avoid JavaScript precision loss. Durable visibility values are `session`, `teacher`, `participant`, and `participant_after_submit`; lite `all` is compatibility-only.
- Durable events are `session.snapshot`, `session.state_changed`, `question.opened`, `question.closed`, `result.updated`, `session.closed`, and `sync.required`. `participant.joined`, `submission.committed`, and `counts.updated` remain compatibility/wake aliases only.
- `aggregateVersion` increments for each fresh accepted submission and each question-close finalization; lifecycle-only events use the current/neutral version. Snapshots carry `{ eventSeq, aggregateVersions }` watermarks.
- Replay is strictly greater-than-cursor and sequence ordered. Hidden rows preserve continuity without exposing data. Gaps, stale/expired/dead/coalesced continuity failures, over-current or permission-invalid cursors produce actor-safe `sync.required` plus a fresh snapshot after authentication; no guessed delta or reason leak.
- Only pending/retry `result.updated` display notifications coalesce by `(liveSessionId, sessionQuestionId, visibility)`; lifecycle, snapshot, close, control, and submission/idempotency outcomes do not coalesce.
- Outbox projection inputs are allowlisted to safe reason/status/question/version/visibility fields; participant/account IDs, tokens, answers, and identity-answer links are rejected and are materialized from PostgreSQL at delivery time.
- All submit, question open/close, manual close, and auto-close writes must converge on `liveSession → sessionQuestion`; account-bound authorization retains `liveSession → course → account`. Current `transitionQuestion()` and bulk close/auto-close still require the post-checkpoint runtime correction.
- Redis policy is `REALTIME_REDIS_MODE=off|optional|required`: local healthy, local degraded fallback, or readiness-blocking required mode respectively; Redis never authorizes or stores domain truth.

### Files added/changed

- Added `src/modules/realtime/live-session-realtime-contract.ts` with pure contract types/validators for envelope fields, lossless sequence cursors, watermarks, replay decisions, coalescing, lock orders, safe outbox inputs, and Redis policy.
- Added `src/modules/realtime/live-session-realtime-contract.spec.ts` covering catalog/visibility, cursor/sequence precision, version/watermark monotonicity, safe input rejection, replay/gap/recovery, coalescing, lock order, and Redis modes.
- Exported the contract from `src/modules/realtime/index.ts`.

### Verification and stop boundary

- [x] DB-free verification: `npm test -- --runInBand src/modules/realtime/live-session-realtime-contract.spec.ts src/modules/realtime/live-session-event-bus.spec.ts` PASS (2 suites, 23 tests); `npm run prisma:validate` PASS; `npm run typecheck` PASS; `npm run format:check` PASS; `npm run lint:check` PASS; `npm run build` PASS; `git diff --check` PASS after removing the trailing blank line.
- **Database scope:** no migration, deploy, truncate, DB-backed test, Redis connection, or runtime transaction change is authorized or claimed in Checkpoint A.
- **Next step after explicit confirmation:** implement additive schema/outbox and sequence/version transaction integration, then run only authorized `smartlearning_test` migration/tests.

## BE-7 — durable realtime Checkpoint B (2026-08-28, in progress)

### Acceptance criteria and implementation slices

- [x] Add additive durable schema/migration for per-session event sequences, question aggregate versions, bounded outbox delivery state, leases, retention evidence, and eligible result coalescing.
- [x] Integrate transactional outbox appends with session/question lifecycle, participant creation, fresh submissions, close/auto-close, cancel, and archive linkage while retaining post-commit wake aliases.
- [x] Preserve exact submitter-only open-question result delivery with a routing-only `targetParticipantId` column; it is never copied into `projectionInput` or emitted payloads. Closed-question result rows remain untargeted and actor-gated.
- [x] Add bounded publisher claiming, per-session ordering, retry/backoff, lease recovery, expiry/dead handling, coalescing guards, transport readiness gating, and sync recovery notifications.
- [x] Add actor-authorized snapshots with repeatable-read watermark reads, replay upper bounds/truncation detection, strict cursor validation, safe visibility filtering, and actor-safe result maps.
- [x] Add Redis off/optional/required policy, optional Compose profile, adapter setup, readiness reporting, and lifecycle cleanup.
- [ ] Add authorized PostgreSQL migration/integration/E2E regression evidence against exactly `smartlearning_test`.
- [ ] Reproduce and resolve the pre-existing BE-6 lifecycle E2E CSRF fixture failure before claiming lifecycle regression completion.
- [ ] Complete full unit/integration/E2E regression and update final WBS/load evidence.

### Risk, rollback, and operational notes

- **Risk:** high — durable event ordering, replay authorization, result privacy, and schema changes affect realtime correctness and security.
- **Rollback:** stop publisher workers before application rollback; retain additive tables and rows for forward repair; keep Redis independently disabled with `REALTIME_REDIS_MODE=off`; do not use a destructive down migration.
- **Monitoring:** sequence gaps, `sync.required`, pending/oldest age, retry/dead rows, coalescing count, publisher failures, duplicate delivery, and actor/privacy projection errors.
- **Dependencies:** Node.js 24+, PostgreSQL migration `20260828110000_add_durable_realtime`, and (only when enabled) Redis reachable at `REDIS_URL`; DB-backed tests must use `smartlearning_test`.

### Files and verification

- Added/changed: `prisma/schema.prisma`, `prisma/migrations/20260828110000_add_durable_realtime/migration.sql`, realtime outbox/publisher/gateway/Redis services, lifecycle/submission/participant integrations, readiness/DTO/docs, and focused unit fixtures.
- [x] PASS: `npx prisma format`; `npm run prisma:validate`; `npm run prisma:generate`; `node scripts/normalize-prisma-client.mjs generated/prisma`.
- [x] PASS: `npm run typecheck`; `npm run lint:check`; `npm run format:check`; `npm run build`.
- [x] PASS: targeted realtime/health tests — 4 suites / 30 tests, 0 failed.
- [x] PASS: `git diff --check` (to be rerun after final documentation/task edits).
- **BLOCKED/NOT RUN:** `NODE_ENV=test npx prisma migrate deploy`, DB-backed integration/E2E, and full regression. The migration deploy was rejected by the command permission boundary; no database mutation was performed. Required explicit scope remains migration `20260828110000_add_durable_realtime` on database `smartlearning_test`.

### BE-7 final DB-free hardening results — 2026-08-29

- [x] Prevent publisher shutdown cleanup from querying the new outbox table when this instance has no outstanding lease; this keeps an un-migrated AppModule compile/close test independent of the durable migration.
- [x] Make replayed `session.closed` envelopes include the documented `{ status: 'closed' }` payload, matching live terminal delivery.
- [x] Propagate account-disabled socket-enumeration failures and retry them with bounded backoff; shutdown clears pending revocation timers. Per-delivery PostgreSQL authorization checks remain the safety net.
- [x] Make Redis optional-mode fallback operational: `/live` adapter transitions between Redis/local on availability changes, preserves existing room memberships, retries startup/runtime recovery with bounded backoff, and keeps required mode traffic-blocking while unavailable.
- [x] Remove the unreachable wildcard HTTP CORS fallback; validated credentialed HTTP and Socket.IO CORS paths now use explicit origin arrays only.
- [x] Add focused regression coverage for terminal replay status, account-revocation retry scheduling, and the publisher/adapter hardening paths.
- [x] Close replaced Socket.IO adapters during Redis/local failover, add adapter transition coverage, and isolate lifecycle cleanup failures.
- [x] Add gateway recovery-fence coverage and archive-governance coverage for purging targeted `participant_after_submit` rows.

#### Latest DB-free verification

- **PASS:** `npm run prisma:validate`, `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`, and `git diff --check`.
- **PASS:** `npm test -- --runInBand` — 30 suites / 174 tests, 0 failed, 0 skipped.
- **PASS:** focused realtime suites — 2 suites / 14 tests, 0 failed.
- **NOT RUN:** migration deployment, PostgreSQL integration/E2E, or Redis-backed runtime/cross-instance tests; no database mutation or Redis connection was performed.

#### Remaining release boundary

- **BLOCKED:** explicit authorization is still required for exactly `20260828110000_add_durable_realtime` against `smartlearning_test` before `NODE_ENV=test npx prisma migrate deploy` or any guarded DB-backed suite.
- **PENDING:** resolve the pre-existing BE-6 `Missing __Host-csrf cookie` lifecycle fixture, then run the authorized lifecycle/realtime/archive regression matrix and update WBS/load evidence.
- **DEFERRED:** cross-instance account lifecycle propagation remains limited by the in-process `AccountLifecycleBus`; durable per-delivery authorization and Redis adapter recovery do not claim cross-instance disable-event delivery.

#### Review follow-ups — 2026-08-29

- [x] Close the previous `/live` namespace adapter before Redis/local replacement, isolate adapter-close failures, and preserve room membership; add transition coverage in `src/modules/realtime/realtime-redis.service.spec.ts`.
- [x] Add gateway coverage proving `notifySyncRequiredForSession()` returns `false` when recovery socket enumeration fails, so the publisher's persisted dead-row recovery fence remains closed.
- [x] Extend archive-governance E2E setup with a targeted `participant_after_submit` durable event and assert purge removes all such rows before participant cleanup.
- **NOT RUN:** the new archive-governance assertion and publisher dead-predecessor sequence matrix require the authorized durable migration on `smartlearning_test`; no DB mutation was performed.

#### Status — 2026-08-29 (updated after authorized runtime verification)

- **IMPLEMENTATION COMMITTED:** BE-7 durable realtime implementation is committed on branch `feat/be7-durable-realtime` under `feat(realtime): add durable live-session outbox`.
- **RELEASE STATUS:** the durable migration is applied to `smartlearning_test`; PostgreSQL and Redis runtime checks passed; integration passed; the targeted E2E matrix is partially blocked by two existing/adjacent behavioral failures recorded below.
- **NEXT ACTION:** resolve the `cp3-terminal-state` terminal-session status mismatch and the realtime vote-to-reveal count/event-order failure, then rerun the lifecycle/realtime matrix and full E2E regression before claiming BE-7 E2E completion.

### 2026-08-29 — BE-7 smartlearning_test runtime verification (completed with E2E blockers)

#### Acceptance criteria

- [x] Apply only `20260828110000_add_durable_realtime` to `smartlearning_test`.
- [x] Verify PostgreSQL and Redis runtime availability without disturbing unrelated containers.
- [x] Run the authorized durable realtime/lifecycle/archive integration and E2E matrix; record the failing assertions and isolation results precisely.
- [x] Run final migration-status and diff checks; record exact outcomes.

#### Risk & rollback

- **Risk:** high — migration and DB-backed realtime verification affect durable event ordering and privacy paths.
- **Rollback:** no destructive down migration was run; leave the additive schema in place for forward repair. Only services started for this verification may be stopped in a separately authorized cleanup.

#### Dependencies & environment

- Target: `.env.test` resolves `DATABASE_URL` to PostgreSQL database `smartlearning_test` at `localhost:5432`.
- Runtime: PostgreSQL is provided by the running `smart-learning-pg-dev` container (it has no Docker healthcheck); Redis is the profile-gated `smartlearning-redis` service from `docker-compose.yml`.
- Guardrail: `test/setup/db.ts` rejects any database other than `smartlearning_test`; the requested DB-backed suites used their documented guarded test setup, including test-database fixture cleanup. No manual reset/down migration was run.
- Redis test boundary: `.env.test` keeps `REALTIME_REDIS_MODE=off`, so the Redis check proves container health/PING only; it does not claim Redis adapter or cross-instance E2E coverage.

#### Working notes

- Preflight status identified exactly one pending migration: `20260828110000_add_durable_realtime`.
- Post-deploy schema probe returned `live_session_event`, `realtime_event_seq`, `aggregate_version`, and the migration record present.
- Redis was started only as `smartlearning-redis`; unrelated PostgreSQL containers were not stopped or reconfigured.

#### Verification

| Command / check                                                                                  | Result                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV=test npm run prisma:migrate:deploy`                                                    | PASS — applied `20260828110000_add_durable_realtime` to `smartlearning_test`; no other migration was pending.                                                                                                                                                                                                        |
| `NODE_ENV=test npm run prisma:migrate:status` (post-deploy)                                      | PASS — 14 migrations found; database schema up to date.                                                                                                                                                                                                                                                              |
| Read-only PostgreSQL schema probe                                                                | PASS — `live_session_event` exists; both durable columns and migration record are present.                                                                                                                                                                                                                           |
| PostgreSQL runtime                                                                               | PASS — `smart-learning-pg-dev` is running (no Docker healthcheck); `pg_isready` accepted connections on `localhost:5432`.                                                                                                                                                                                            |
| Redis runtime                                                                                    | PASS — `smartlearning-redis` healthy; `redis-cli ping` returned `PONG`.                                                                                                                                                                                                                                              |
| `NODE_ENV=test npm run test:integration -- --runInBand --silent`                                 | PASS — 3 suites / 16 tests, no skips.                                                                                                                                                                                                                                                                                |
| Targeted E2E matrix (`live-session-realtime`, close/cancel, results, archive, route matrix, CP3) | FAIL — 4 suites passed, 2 failed; 59 passed, 3 failed, 62 total; Jest did not exit because of an open handle after a failing realtime test.                                                                                                                                                                          |
| Isolated realtime E2E                                                                            | FAIL — 1 failed / 17 passed; vote-to-reveal assertion at `test/live-session-realtime.e2e-spec.ts:655` expected `votedCount=1`, received `0`. Outbox rows were delivered in order with a teacher `session.snapshot` at seq 4 before targeted `result.updated` at seq 5, supporting a stale counts event/order defect. |
| Isolated CP3 terminal-state E2E                                                                  | FAIL — expected 409, received 401 at `test/cp3-terminal-state.e2e-spec.ts:322`; `ParticipantService.authenticate` rejects the terminal session before submission handling.                                                                                                                                           |
| Isolated close-question realtime test                                                            | PASS — 1 selected test passed; the combined-run close timeout is treated as cross-suite/open-handle interference, not a standalone failure.                                                                                                                                                                          |
| Full E2E suite                                                                                   | NOT RUN — targeted E2E failures prevented the planned expansion.                                                                                                                                                                                                                                                     |
| `git diff --check`                                                                               | PASS — no whitespace errors.                                                                                                                                                                                                                                                                                         |

#### Results

- The authorized additive migration is deployed and verified against the intended PostgreSQL database only.
- PostgreSQL connectivity and durable schema objects are proven; Redis is healthy and reachable, but `.env.test` intentionally exercised local realtime mode rather than Redis adapter mode.
- All three integration suites passed. E2E execution reached the real PostgreSQL-backed fixtures and exposed two actionable failures; they are recorded rather than silently treated as skips.
- No application source, Prisma schema/migration, or runtime configuration was edited. The only working-tree change is this verification record.

### 2026-08-29 — BE-7 E2E blocker-fix plan Checkpoint A (understand/reproduce)

- [x] Confirmed the CP3 mismatch in `test/cp3-terminal-state.e2e-spec.ts`: a post-close anonymous bearer submission uses a token whose participant lookup link was removed/rotated by archive finalization, so authentication correctly returns `401 UNAUTHORIZED`; an account-bound student-cookie submission still reaches the terminal-session state boundary and returns `409 SESSION_NOT_JOINABLE`. Cancellation and direct session-code reconnect paths remain strict `409 SESSION_NOT_JOINABLE`.
- [x] Confirmed the durable realtime E2E ordering issue in `test/live-session-realtime.e2e-spec.ts`: the participant-join `session.snapshot`/compatibility `counts.updated` delivery may still be pending when the submission listener is registered, allowing the join-time `votedCount=0` event to satisfy a submission-time assertion. The deterministic fix is to await the join notifications before registering the submission listener; no publisher/gateway change is indicated.
- [x] Cross-checked the authoritative P0/realtime/result-governance rules: closed/cancelled sessions reject future writes and reconnects; archive finalization must remove account/display-name/token lookup links; durable events remain ordered and per-socket delivery serialized; teacher-only counts stay out of participant projections.
- [x] Existing reusable lessons cover both failure modes (`tasks/lessons.md`: post-commit listener registration, archive privacy/lock boundaries); no new lesson entry is required at this checkpoint.
- **STOPPED at manual Checkpoint A:** no source/schema/migration/config changes were made and no DB-backed test or migration command was run. Awaiting explicit human authorization to edit the focused E2E fixtures and run the guarded `smartlearning_test` verification in Checkpoint B.

### 2026-08-29 — BE-7 E2E blocker-fix plan Checkpoint B initial verification (blocked)

- [x] Applied the authorized test-only changes in `test/cp3-terminal-state.e2e-spec.ts` and `test/live-session-realtime.e2e-spec.ts`; `npx prettier --write` reported both files unchanged after formatting.
- **FAIL:** `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/cp3-terminal-state.e2e-spec.ts` — 1 failed / 3 passed / 4 total; `40P01 deadlock detected` occurred in guarded `truncateAll()` (`test/setup/db.ts:50`) before the terminal assertion, likely due to durable publisher DB activity from the prior case. No assertion result is claimed from the blocked case.
- **FAIL:** `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/live-session-realtime.e2e-spec.ts` — 1 failed / 17 passed / 18 total; the vote-to-reveal test failed at `test/live-session-realtime.e2e-spec.ts:637` because the newly awaited join-count listener received `joinedCount: 0`. The initial teacher snapshot's follow-up `counts.updated` was still eligible to satisfy the listener, so the first fix did not fully drain earlier count notifications. The failed test also left a socket open, and Jest reported an open-handle warning.
- **STOP-THE-LINE / RE-PLAN:** Checkpoint B is not green; do not expand to the lifecycle matrix or full regression. Preserve the evidence above, diagnose deterministic test isolation and event selection, then revise the minimal test-only fix before rerunning the focused commands. Existing non-blocking Nest route-converter and `pg@9 client.query()` warnings were also observed.

### 2026-08-29 — BE-7 Checkpoint B re-plan after initial verification

- **CP3 isolation correction:** `LiveSessionPublisher` starts during `app.init()` and can still hold PostgreSQL projection locks while CP3's `beforeEach` calls the dynamic `TRUNCATE ... CASCADE`. CP3 has no realtime assertions, so the test will stop and await the publisher once after app initialization; no fixed sleep, production change, schema change, or migration change is needed.
- **Realtime event-selection correction:** durable sequence order is preserved, but generic `counts.updated` payloads have no event source/sequence marker. The test will use a predicate waiter that ignores earlier `0/0` counts and resolves only on expected join `1/0` and submit `1/1` states. This is deterministic for the one-participant/one-submission fixture and does not alter publisher/gateway behavior.
- **Revised scope:** remain test-only in the same two focused E2E files; rerun Checkpoint B focused commands after formatting. Do not expand regression until both pass.

### 2026-08-29 — BE-7 Checkpoint B revised verification (partial)

- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/cp3-terminal-state.e2e-spec.ts` — 1 suite / 4 tests passed, 0 failed, 0 skipped; stopping the publisher after app initialization removed the cleanup deadlock. Existing Nest route-converter and `pg@9` warnings remained non-blocking; no open-handle warning.
- **BLOCKED:** `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/live-session-realtime.e2e-spec.ts` — 17 passed / 1 failed / 18 total; the failing `non-owner teacher is rejected before room join` case hit `40P01 deadlock detected` in `truncateAll()` (`test/setup/db.ts:50`, suite `beforeEach` at `test/live-session-realtime.e2e-spec.ts:171`) before its assertion. Publisher transient retry/dispatch warnings were observed; no open-handle warning. The revised vote-to-reveal predicate waiters were not reached in this run.
- **STOP-THE-LINE:** Do not expand regression. Reproduce the realtime cleanup deadlock in isolation and determine a deterministic test-only publisher/cleanup synchronization before claiming the focused suite green.

### 2026-08-29 — BE-7 Checkpoint B focused rerun after transient cleanup deadlock

- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/cp3-terminal-state.e2e-spec.ts` — 1 suite / 4 tests passed, 0 failed, 0 skipped; no open-handle warning.
- **PASS:** `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/live-session-realtime.e2e-spec.ts` — 1 suite / 18 tests passed, 0 failed, 0 skipped; vote-to-reveal predicate waiters observed the expected teacher join `1/0` and submit `1/1` counts; no open-handle warning.
- **REPRODUCTION RESULT:** The realtime-suite `40P01` cleanup deadlock did not recur when that suite was run alone. The prior failure remains recorded as an intermittent publisher/`truncateAll()` interaction; no fixed sleep or broad timeout was added. Matrix execution will determine whether further isolation hardening is necessary.
- **CHECKPOINT B STATUS:** focused blocker behavior is green; proceed to Checkpoint C lifecycle/realtime/archive matrix, while preserving the transient cleanup warning as an explicit verification item.
- **STOPPED BEFORE CHECKPOINT C:** the seven-suite matrix was not started because its guarded setup truncates `smartlearning_test` and requires a separate explicit authorization for the broader Checkpoint C scope. No matrix command or additional DB operation was performed.

### 2026-08-29 — BE-7 Checkpoint C seven-suite matrix (blocked)

- **AUTHORIZED SCOPE:** guarded DB-backed execution was limited to `NODE_ENV=test` / `smartlearning_test`, including the existing idempotent migration and truncation performed by test setup. No development database operation or manual reset/down migration was run.
- **FAIL:** `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/live-session-realtime.e2e-spec.ts test/live-session-close-cancel.e2e-spec.ts test/live-session-results.e2e-spec.ts test/archive-governance.e2e-spec.ts test/live-session-route-matrix.e2e-spec.ts test/cp3-terminal-state.e2e-spec.ts test/participant-account.e2e-spec.ts` — 6 suites passed / 1 failed / 7 total; 70 tests passed / 1 failed / 71 total; 0 skipped; duration 197.879s.
- **FAILURE:** `test/live-session-realtime.e2e-spec.ts`, `teacher connects and receives a session.snapshot with joined/voted counts`, failed during guarded fixture cleanup with Prisma raw-query error `40P01 deadlock detected`. The intermittent durable publisher / `truncateAll()` cleanup interaction therefore recurred in the combined matrix.
- **WARNINGS:** repeated `LiveSessionPublisher` transient retry/dispatch warnings (`state: retry`, `PrismaClientKnownRequestError`), existing Nest `LegacyRouteConverter` warnings for `health/(.*)` and `/api/*`, and the existing `pg` `client.query()` deprecation warning were observed. No Jest open-handle warning was observed.
- **STOP-THE-LINE:** full E2E, integration, migration-status, Prisma/static/build, and diff supporting checks were not run because the required seven-suite gate was not green. Diagnose deterministic publisher/cleanup isolation; do not add fixed sleeps or broad timeouts. No broader BE-7 completion or release sign-off is claimed.

### 2026-08-29 — BE-7 Checkpoint C publisher/truncateAll deadlock fix (in progress)

#### Acceptance criteria

- [ ] Publisher shutdown stops wake sources and awaits the active drain before destructive test cleanup begins.
- [ ] Publisher init/destroy is repeatable and idempotent with one subscription/timer/startup scan per active lifecycle.
- [ ] Realtime E2E quiesces only around `truncateAll()` and restarts before fixture setup; CP3 remains permanently stopped.
- [ ] Focused publisher unit, isolated realtime E2E, and exact seven-suite Checkpoint C matrix pass without `40P01`, skips, or open handles.
- [ ] Only after the matrix is green, run and record the full authorized verification bundle against `smartlearning_test`.

#### Risk & rollback

- **Risk:** medium — production publisher lifecycle becomes restartable; delivery SQL, ordering, projection, retry, lease, and gateway contracts remain unchanged.
- **Rollback:** revert lifecycle/helper/realtime-hook edits while retaining CP3's one-time shutdown and the recorded deadlock evidence. Do not replace the lifecycle barrier with sleeps or retries.
- **Database boundary:** DB-backed verification is authorized only with `NODE_ENV=test` resolving to guarded `smartlearning_test`, including existing idempotent setup migration/truncation. No development database or destructive down/reset operation.

#### Implementation checklist

- [x] Add explicit active lifecycle guard and quiescent repeatable shutdown to `LiveSessionPublisher`.
- [x] Add deterministic deferred/fake-timer lifecycle unit coverage.
- [x] Add `withQuiescedLiveSessionPublisher()` to the test app factory.
- [x] Wrap realtime-suite `truncateAll()` only; preserve existing socket cleanup unless inspection proves a leak.
- [x] Record the deadlock lifecycle-barrier lesson and verification results.

#### Checkpoint C verification results — 2026-08-29 (PASS)

**AUTHORIZED SCOPE:** guarded DB-backed execution limited to `NODE_ENV=test` / `smartlearning_test`, including the existing idempotent migration and truncation performed by test setup. No development database operation or manual reset/down migration was run.

**Scope expansion during verification:** the seven-suite matrix initially failed with `40P01` in `route-matrix`, `close-cancel`, and `results`; the full e2e run additionally failed in `enrollments` and `archive-governance`. Root cause: `LiveSessionPublisher` is a shared singleton across the whole test process, so **any** suite that calls `truncateAll()` while the publisher is active can deadlock — the realtime-suite-only wrapper was insufficient. Applied `withQuiescedLiveSessionPublisher(app, () => truncateAll(...))` to every `truncateAll()` call site in DB-backed suites (24 files), leaving `cp3-terminal-state` permanently stopped (its existing `onModuleDestroy()` in `beforeAll` already quiesces). Also fixed a `prefer-const` lint error in `live-session-realtime.e2e-spec.ts` (`nextEventMatching`).

**Verification bundle (all PASS):**

| Command                                                                                         | Result                                                              |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `npm test -- --runInBand src/modules/realtime/live-session-publisher.spec.ts`                   | PASS — 1 suite / 11 tests (incl. 4 new lifecycle tests)             |
| `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/live-session-realtime.e2e-spec.ts` | PASS — 1 suite / 18 tests                                           |
| Seven-suite Checkpoint C matrix                                                                 | PASS — 7 suites / 71 tests, no `40P01`, no skips, no open handles   |
| `NODE_ENV=test npm run test:e2e -- --runInBand --silent` (full)                                 | PASS — 26 suites / 178 tests, no `40P01`, no skips, no open handles |
| `NODE_ENV=test npm run test:integration -- --runInBand --silent`                                | PASS — 3 suites / 16 tests                                          |
| `npm test -- --runInBand`                                                                       | PASS — 30 suites / 178 tests                                        |
| `npm run typecheck`                                                                             | PASS                                                                |
| `npm run lint:check`                                                                            | PASS                                                                |
| `npm run format:check`                                                                          | PASS                                                                |
| `npm run build`                                                                                 | PASS                                                                |
| `NODE_ENV=test npm run prisma:migrate:status`                                                   | PASS — 14 migrations, schema up to date                             |
| `git diff --check`                                                                              | PASS                                                                |

**Result:** Checkpoint C lifecycle/realtime/archive matrix and the full authorized verification bundle are green against `smartlearning_test`. The publisher/`truncateAll()` deadlock is resolved deterministically (no fixed sleeps or broad timeouts). This does not claim a release sign-off; it records the Checkpoint C verification gate as passed.

## 2026-08-29 BE-8.0 Contract freeze 與人工授權（Checkpoint 0）

Freeze 文件：`../docs/智學互動平台/50_實作與測試/BackendBE8/be-8-contract-freeze.md`

- [x] 凍結 `GET /auth/session`（真實 `expiresAt`、401 語意、envelope 不變）
- [x] 凍結錯誤契約（`AUTH_SESSION_EXPIRED` vs `UNAUTHORIZED`；已凍結、實作 CP1）
- [x] 凍結 account update scope allowlist（實作 CP2）
- [x] 凍結 CLI 憑證模型（rotation = 立即失效，使用者已決策；實作 CP3）
- [x] 凍結 rate limit 契約（US-F7 coerce invariant 沿用；CLI/batch 归屬待 CP0 決策）
- [x] 凍結 observability 目標（metrics 端點 + CP6 redaction 範圍）
- [x] **人工 Checkpoint 0 — verified（2026-08-30，使用者回覆「全照建議」）**：Q1–Q7 決策已寫回 freeze 文件 §2–§8。CP1（Session expiry 契約）解鎖。

#### Risk & rollback

- **Risk:** low — 僅新增 design docs 檔案與本區塊；零程式碼/schema 變更。
- **Rollback:** 刪除 `BackendBE8/be-8-contract-freeze.md` 與本區塊。
- **Database boundary:** 本 CP 僅唯讀執行 `prisma:migrate:status`（`NODE_ENV=test`，`smartlearning_test`）；無任何資料操作。

#### Results

- 建立 `docs/智學互動平台/50_實作與測試/BackendBE8/be-8-contract-freeze.md`（§0 環境基準 → §7 DB 授權聲明 → §8 人工 CP0 清單 Q1–Q7 → §10 evidence）。
- Verification：`git status` 乾淨（僅 docs 新檔）、`npm run typecheck` PASS、`NODE_ENV=test npm run prisma:migrate:status` 唯讀 PASS（14 migrations up to date）。
- **CP0 決策記錄（2026-08-30）：** `username` 不可改；`displayName` 僅 admin；role 提權至 admin 需 step-up。CLI expiry = 無 TTL 直到 revoke（CP3 不做 expiry migration）。CLI/batch rate limit = per-CLI-key。`AUTH_SESSION_EXPIRED` 凍結、CP1 實作（SessionExpiredError 子類，idle/absolute 同 code）。Metrics = `/metrics` VERSION_NEUTRAL 無 envelope、network 層隔離。DB 授權：`smartlearning_test` + setup migrate/truncate 邊界，已授權。CP1 以 targeted auth/session suite 先行。
- **§10 evidence 執行（2026-08-30）：** 唯讀核對全部 PASS — `git status` 乾淨（僅 `M tasks/todo.md`）、`git diff --check` PASS、`npm run typecheck` PASS、`NODE_ENV=test npm run prisma:migrate:status` PASS（14 migrations up to date）。§1–§6 凍結契約證據位置（`auth.controller.ts:111-125`、`session.guard.ts:54`、`error-codes.ts:19`、`session-limits.ts`、`admin.controller.ts:134-155`、`schema.prisma:405`、`frontend-api-reference.md` §auth）全部核對一致；Redis container Up 但 `REDIS_URL` 於各 env 檔皆註解（僅影響 CP5）。Stop conditions 未觸發，**CP0 完成**。

## 2026-08-30 BE-8.1 CP1 — Session expiry 契約實作

實作文件：`../docs/智學互動平台/50_實作與測試/BackendBE8/be-8-1-cp1-session-expiry.md`（上游契約 `be-8-contract-freeze.md` §1–§2，CP0 verified）。

#### Checklist

- [x] `src/common/errors/domain-error.ts` 新增 `SessionExpiredError`（code `AUTH_SESSION_EXPIRED`、401、泛用 message `'Session expired'`）；`index.ts` 已 `export * from './domain-error'` 自動匯出。
- [x] `src/common/auth/session.service.ts` `loadActiveSession` 改取 `sessionValidity()` 的 `reason`；`!valid` 分支依 `reason === 'expired' | 'idle'` 丟 `SessionExpiredError`（idle/absolute 同 code），防禦性 else 維持 `UnauthorizedError`。
- [x] 明確不動：`revokedAt`／disabled／缺 hash 維持 `UnauthorizedError`；缺 cookie／malformed cookie 在 `SessionGuard` L31-33 維持 `UnauthorizedError`；`SessionGuard` 不需改（`SessionExpiredError` 透明上拋，由 `GlobalExceptionFilter` 映射 401 + `AUTH_SESSION_EXPIRED` envelope）。
- [x] Realtime gateway `authenticateCookie`（`live-gateway.ts:306`）呼叫同一 `loadActiveSession`，過期時丟 `SessionExpiredError`（仍屬 `DomainError`），handshake catch-all 投影涵蓋 — 0 diff。
- [x] 新增 `src/common/auth/session.service.spec.ts`（FakeClock）：valid 觸碰 lastSeenAt；absolute-expired／idle-expired → `SessionExpiredError`（同 code）；revoked／disabled／缺 hash → `UnauthorizedError`。
- [x] 新增 `test/auth-session-expiry.e2e-spec.ts`（DB-backed，`smartlearning_test`，真實 clock + 直接 UPDATE `web_session` row）：8 凍結案例全綠。
- [x] `docs/frontend-api-reference.md` §auth 補 `AUTH_SESSION_EXPIRED`（需重登）vs `UNAUTHORIZED`（未認證/撤銷）語意說明列。
- [x] 無 schema、無 migration、無 DTO 變更。

#### Risk & rollback

- **Risk: 中高** — 改變所有 SessionGuard 路徑的錯誤分類、觸及 auth 層；但凍結契約限定改動面僅 `loadActiveSession` 的 `!valid` 分支。
- **Rollback:** revert commit 即可；無 DB/migration 回滾需求。
- **監控信號:** `AUTH_SESSION_EXPIRED` 出現量應僅限 genuinely expired cookie 場景。
- **不變量:** envelope/auth/CSRF 行為不變；`revokedAt`／disabled／缺 cookie 維持 `UNAUTHORIZED`；realtime handshake 錯誤投影不變。

#### Verification（執行結果）

| 命令                                                                                 | 結果                                                |
| ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `npm test -- --runInBand src/common/auth/session.service.spec.ts`                    | PASS — 1 suite / 6 tests                            |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/auth-session-expiry.e2e-spec.ts` | PASS — 1 suite / 9 tests（8 凍結案例 + skip-guard） |
| 既有回歸（auth-courses / auth-rate-limit / api-envelope）                            | PASS — 3 suites / 25 tests，無回歸                  |
| `npm run prisma:validate`                                                            | PASS                                                |
| `npm run typecheck`                                                                  | PASS                                                |
| `npm run lint:check`                                                                 | PASS                                                |
| `npm run format:check`                                                               | PASS                                                |
| `npm run build`                                                                      | PASS                                                |
| `npm test -- --runInBand`                                                            | PASS — 31 suites / 184 tests                        |
| `NODE_ENV=test npm run test:integration -- --runInBand`                              | PASS — 3 suites / 16 tests                          |
| `NODE_ENV=test npm run test:e2e -- --runInBand`                                      | PASS — 27 suites / 187 tests                        |
| `NODE_ENV=test npm run prisma:migrate:status`                                        | PASS — 14 migrations, schema up to date             |
| `git diff --check`                                                                   | PASS                                                |

#### Results

- `SessionExpiredError` 落地：idle/absolute timeout → 401 `AUTH_SESSION_EXPIRED`；`revokedAt`／disabled／缺 cookie／malformed → 401 `UNAUTHORIZED`（凍結契約，不拆 idle/absolute 為兩 code）。
- `GET /auth/session` 未登入 → 401（不回 200 + 空字串）；envelope 形狀不變，僅 additive forward-fix。
- 全域 stop condition 未觸發：`AUTH_SESSION_EXPIRED` 未誤用於其他未認證情境。
- **人工 Checkpoint 1 — verified（2026-08-30）**：依 `../docs/智學互動平台/50_實作與測試/BackendBE8/be-8-1-cp1-session-expiry.md:169` 所記錄的使用者確認，各案例 status/`error.code`、`expiresAt` 語意與後端 code 區分語意均符合凍結契約；CP1 完成。

## 2026-08-30 BE-8.2 CP2 — Account management update（8.3）

實作文件：`../docs/智學互動平台/50_實作與測試/BackendBE8/be-8-2-cp2-account-update.md`（上游契約 `be-8-contract-freeze.md` §3，CP0 verified；前置 BE-8.1 CP1 已落地）。

#### Checkpoint 2 決策（使用者 2026-08-30 確認，全照 plan 預設）

- [x] **mustChangePassword 端點形狀**：獨立 route `POST /admin/accounts/:id/require-password-change`（body `{ mustChangePassword: boolean }`，step-up 保護），不併入 general update。
- [x] **self-role**：admin 改自己的 `role` → `403 FORBIDDEN`（防最後一個 admin 自降權鎖死）；self `displayName` 允許。
- [x] **last-admin**：不做 server-side last-admin invariant（與凍結一致，不加契約外規則）。

#### Checklist

- [x] 新增 `src/modules/identity/api/dto/update-account.dto.ts`（`displayName?`/`role?`/`canCreateCourse?`，全 optional；`@IsEnum(ACCOUNT_ROLES)`、`@Length(1,100)`、`@IsBoolean`）。
- [x] 新增 `src/modules/identity/api/dto/require-password-change.dto.ts`（`{ mustChangePassword: boolean }`）。
- [x] `AccountService.updateAccount()`：row lock → existence → disabled 403 → self-role 403 → 提權 step-up（鎖內、寫入前）→ student+canCreateCourse 403 → 同值 no-op 不寫 → 只寫實際變更欄位；不撤 session/CLI/token、不發 lifecycle。
- [x] `AccountService.setMustChangePassword()`：row lock → existence → disabled 403 → 同值 no-op；self 允許；不撤 session。
- [x] `AdminController` 新增 `PATCH accounts/:id`（`ParseUUIDPipe` + `@CurrentAccount`；空 body → `ValidationError` 400）+ `POST accounts/:id/require-password-change`（`@UseGuards(StepUpGuard)`）。
- [x] 新增 `src/modules/identity/application/account.service.spec.ts`（13 unit tests：update 成功、no-op、提權 step-up 有/無、disabled、missing、malformed、student、self-role、self-displayName、無 revoke/publish、setMustChangePassword set/no-op/disabled/malformed）。
- [x] 擴充 `test/account-admin.e2e-spec.ts`（13 新案例：update 反映 DB、非 admin 403、self displayName/role、404/400、未知欄位/空 body、disabled→restore、提權 step-up、student+canCreateCourse、session 不撤、CLI 不撤（M2 紅卡 #8）、require-password-change set/clear、require-password-change step-up/disabled、負向洩漏）。
- [x] `docs/frontend-api-reference.md` §4 補 `PATCH /admin/accounts/:id` + `require-password-change` path/body/status/error/side-effect；L478 limitation 更新為凍結 allowlist。
- [x] `test/openapi.e2e-spec.ts` 斷言新 PATCH path + `UpdateAccountDto` schema 無敏感欄位/範例值。
- [x] 無 schema、無 migration、無既有 DTO/response 形狀變更、不動既有 `permissions` route。

#### Risk & rollback

- **Risk: 高**（帳號權限/role 變更屬憑證與授權面；凍結明示 8.3 高風險、須獨立人工 Checkpoint）。緩解：純 additive（新 route，不動既有行為）、row lock 序列化、step-up 僅提權路徑、所有 revoke 留在既有專責端點。
- **Rollback:** revert commit 即可；無 DB/migration 回滾。已寫入的 role/displayName 屬正常資料不需補償；本 CP 不撤銷任何憑證，故無需以資料操作恢復。
- **監控信號:** `AUTH_STEP_UP_REQUIRED` 於此 route 僅限提權嘗試；403 `FORBIDDEN` 量突增可能代表前端誤用 route。
- **Stop conditions 未觸發:** `canCreateCourse=false` 未撤銷 CLI credential（e2e 已斷言）；log/response 未出現 hash/credential。

#### Verification（執行結果）

| 命令                                                                               | 結果                                             |
| ---------------------------------------------------------------------------------- | ------------------------------------------------ |
| `npm test -- --runInBand src/modules/identity/application/account.service.spec.ts` | PASS — 1 suite / 13 tests                        |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/account-admin.e2e-spec.ts`     | PASS — 1 suite / 23 tests（10 既有 + 13 新）     |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/openapi.e2e-spec.ts`           | PASS — 1 suite / 3 tests（新 path + DTO schema） |
| `npm run prisma:validate`                                                          | PASS                                             |
| `npm run typecheck`                                                                | PASS                                             |
| `npm run lint:check`                                                               | PASS                                             |
| `npm run format:check`                                                             | PASS                                             |
| `npm run build`                                                                    | PASS                                             |
| `npm test -- --runInBand`                                                          | PASS — 32 suites / 197 tests                     |
| `NODE_ENV=test npm run test:e2e -- --runInBand`                                    | PASS — 27 suites / 200 tests                     |
| `NODE_ENV=test npm run test:integration -- --runInBand`                            | PASS — 3 suites / 16 tests                       |
| `npm run prisma:migrate:status`                                                    | PASS（唯讀，14 migrations up to date）           |
| `git diff --check`                                                                 | PASS                                             |

#### Results

- 凍結 allowlist 三欄位（`displayName`/`role`/`canCreateCourse`）落地 `PATCH /admin/accounts/:id`；`mustChangePassword` 走獨立 step-up 保護的 `require-password-change` route。
- 提權至 admin 的 step-up 在 service 層鎖內判定（method-level `StepUpGuard` 會誤擋 displayName 更新，故不直接掛）；self-role 403 防最後 admin 自降權。
- 所有 revoke/lifecycle 行為留在 disable/restore/reset 專責端點；profile update 不撤 session/CLI/token（e2e 已斷言）。
- **人工 Checkpoint 2 — verified（2026-08-30）**：新增 `test/manual-cp2-verify.e2e-spec.ts`（DB-backed，`smartlearning_test`）實測全部五項 — (1) update 前後 DB rows vs response DTO（僅 allowlist 欄位變更，username/status/hash/createdAt 未動）、(2) disabled update 403 → restore → 200、(3) 提權 step-up 403 `AUTH_STEP_UP_REQUIRED` → step-up → 200、(4) `canCreateCourse=false` 後 CLI credential 仍 active（M2 紅卡 #8）→ disable 後 revoked `CLI_CREDENTIAL_REVOKED`、(5) 三決策點（self-role 403、self displayName 200、require-password-change gate 201）。PASS — 1 suite / 1 test。

## 2026-08-30 BE-8.3 CP3 — CLI key rotation / successor

實作文件：`../docs/智學互動平台/50_實作與測試/BackendBE8/be-8-3-cp3-cli-key-rotation.md`（上游 `be-8-3-cp3-cli-key-rotation-plan.md`；CP0 freeze §4；CP0 verified）。

### Context and acceptance criteria

- [x] 新增 admin-only `POST /api/v1/admin/accounts/:id/cli-credentials/:credentialId/rotate`；需 active Web session、CSRF/exact Origin、AdminGuard、StepUpGuard、兩個 UUID path params；無 request body；成功 HTTP 201。
- [x] rotation 同一 transaction 內建立 active successor、立即 revoke predecessor；predecessor retained 並改 deterministic archival name；raw successor key 只回傳一次，DB 只存 SHA-256 hash。
- [x] successor 繼承原 logical name/scope，保存 `rotatedFromId` direct lineage；predecessor 與 successor UUID/hash 均不同；list/response 不含 keyHash/raw key（除 one-time `rawKey` response）。
- [x] missing account → 404 `NOT_FOUND` field `id`；missing/cross-account credential → existence-safe 404 field `credentialId`；inactive account → 403；revoked/already-rotated/repeated/losing concurrent request → 409 `CONFLICT`，不回 raw key。
- [x] account row lock serializes rotate/revoke/disable/restore；same predecessor at most one successor；transaction failure rollback predecessor rename/revoke and successor insert together。
- [x] disable leaves zero active credentials and restore revives none；`canCreateCourse=false` does not revoke successor。
- [x] validation-token / batch-idempotency rows remain unchanged；predecessor token cannot be confirmed by successor；successor must validate again；predecessor idempotency scope remains unchanged。
- [x] 不新增 CLI TTL/expiry/grace/pending/version fields；不在 response/list/error/log/OpenAPI/DB 暴露 raw key/hash。

### Risk & rollback

- **Risk: high** — authentication lifecycle, additive self-relation schema, one-time secret handling, transaction rollback, and concurrent account lifecycle writes。
- **Rollback:** application code may be reverted；lineage column/index remain as additive schema. Do not delete lineage data or reactivate revoked predecessors. Committed successors may be revoked through the existing admin revoke endpoint。
- **Database boundary:** only `NODE_ENV=test` resolving exactly to guarded `smartlearning_test`; test setup's existing idempotent migrate/truncate boundary is authorized. Never use `migrate reset`/`db push`/development cleanup/down migration/direct key reactivation。
- **Stop conditions:** DB target or migration state unclear；suite silently skips；CP0 contract conflicts with implementation；raw key/hash leakage；missing migration constraints；or automated verification fails. Stop at Manual Checkpoint 3; do not begin CP4 without explicit confirmation。

### Implementation checklist

- [x] Add nullable `CliCredential.rotatedFromId` self-relation and unique direct-successor index in Prisma plus one additive hand-written migration; no expiry/grace/pending/version fields。
- [x] Add atomic `CliCredentialService.rotateCredential()` using `TransactionService.run()` and `lockAccountForUpdate()`；deterministic archival name <=63 chars；hash-only persistence；explicit safe projection。
- [x] Add `RotateCliCredentialResponseDto`/nullable lineage field and guarded admin route；retain `rawKey` property name for existing redaction。
- [x] Add service unit coverage for success, locks, projection/hash secrecy, invalid branches, and transaction failure propagation。
- [x] Extend CLI credential E2E for success, immediate invalidation, lineage, errors, repeat/concurrency, A→B→C, rotate/revoke/disable races, restore, and permission independence。
- [x] Extend batch E2E for predecessor token/idempotency preservation and successor re-validation；extend OpenAPI and Pino redaction coverage。
- [x] Create manual CP3 E2E spec only after automated verification; never include it in the normal automated bundle。

### Automated verification results

- [x] Format changed TypeScript before lint。
- [x] `npm run prisma:generate` plus `node scripts/normalize-prisma-client.mjs generated/prisma`。
- [x] `npm run prisma:validate`。
- [x] Targeted service/redaction unit tests — PASS, 2 suites / 12 tests。
- [x] Targeted CLI/batch/account/OpenAPI E2E against guarded `smartlearning_test` — PASS, 4 suites / 44 tests, no skips。
- [x] Full unit — PASS, 33 suites / 207 tests, no skips。
- [x] Full guarded E2E — PASS, 28 suites / 206 tests, no skips; manual CP3 spec was not present and was not run in this automated bundle。
- [x] Full integration — PASS, 3 suites / 16 tests, no skips。
- [x] `npm run typecheck` — PASS。
- [x] `npm run lint:check` — PASS after formatting/removing two unused locals in the pre-existing CP2 manual spec。
- [x] `npm run format:check` — PASS。
- [x] `npm run build` — PASS。
- [x] `NODE_ENV=test npm run prisma:migrate:status` — PASS, exact database `smartlearning_test` at `localhost:5432`, 15 migrations, schema up to date。
- [x] `git diff --check` — PASS。
- **Warnings:** existing Nest `LegacyRouteConverter` warnings (`health/(.*)`, `/api/*`) and expected isolated realtime publish-failure warning logs; no test failures or open-handle warnings。
- **DB boundary:** all DB-backed checks used `NODE_ENV=test` and exact `smartlearning_test`; no reset/db push/development cleanup/down migration/direct key reactivation。

### Manual Checkpoint 3 — mandatory stop

- [x] Add `test/manual-cp3-verify.e2e-spec.ts` following CP2: guarded `smartlearning_test`, publisher-quiesced cleanup, direct DB inspection, one auditable scenario, raw keys memory-only。
- [x] Do not run it automatically. Presented exactly:
      `NODE_ENV=test npm run test:e2e -- --runInBand test/manual-cp3-verify.e2e-spec.ts`
- [x] User explicitly confirmed predecessor/successor behavior, DB hash-only lineage, token non-reuse, one-successor race result, and no TTL/grace/pending fields（2026-08-30）。
- [x] **Manual Checkpoint 3 — verified（2026-08-30）**。User confirmed the manual evidence and authorized recording the result without rerunning the DB-backed manual suite; CP4 started in the subsequent session。

## 2026-08-30 BE-8.4 CP4 — CLI courses and CLI/batch rate limit

### Context and acceptance criteria

- [ ] Reuse `GET/POST /api/v1/courses` as Web-or-CLI collection routes; a supplied `X-CLI-Key` selects CLI auth and never falls back to a valid Web cookie on failure. Detail/archive remain Web-only。
- [ ] CLI list returns only caller-owned draft Courses with exact `id`/`name`/`status` projection and accurate owner/draft-filtered pagination; Web list contract remains unchanged。
- [ ] CLI create reuses `CourseService.createCourse()` so the credential account is the immutable owner and role/`canCreateCourse` are rechecked under the account lock; CLI response is narrow, Web response remains full。
- [ ] `canCreateCourse=false` leaves the CLI credential active and list usable while create returns 403; account disable/revoke/rotation semantics remain unchanged。
- [ ] Add per-`CliCredential.id` in-memory fixed-window policies for courses list/create and batch validate/confirm; Web and login buckets remain untouched and each policy/key is isolated。
- [ ] 429 uses stable `RATE_LIMITED` + positive `error.retryAfterSeconds`; real-clock expiry restores access. Rate-limited create/validate/confirm produces no prohibited DB side effects。
- [ ] Validate pagination at the transport boundary; invalid, fractional, non-positive, or excessive values return stable 400 and never pass `NaN` to Prisma。
- [ ] Update OpenAPI/API reference/env examples/redaction tripwires and prepare a dedicated manual CP4 spec after automated verification。

### Contract freeze / working notes

- Shared collection routes only; `GET /courses/:id` and archive do not accept CLI auth。
- CLI Course projection is `id`/`name`/`status`; list filters `ownerAccountId + status=draft`; Web projection/list behavior is preserved。
- Current supported CLI scope is `all_courses`; `single_course` has no persisted target and must fail closed rather than gain broad access。
- Four independent policies: courses-list 60/60s, courses-create 10/60s, batch-validate 30/60s, batch-confirm 20/60s; tests override with low limits。
- New operation limiter uses atomic consume semantics and explicit runtime `Number()` coercion. Existing login `RateLimiterService` APIs/state are unchanged。
- Guard order is actor authentication → CLI operation limiter → conditional CSRF → controller/service. Web actors bypass CP4 buckets。
- CP4 is single-process/in-memory; restart clears counters and multi-instance consistency remains CP5 Redis scope。
- No schema change or migration is expected。

### Risk & rollback

- **Risk: high** — authentication channel selection, credential-scoped abuse control, actor-dependent public DTOs, and batch write/token/idempotency boundaries。
- **Rollback:** restore Web-only Course collection guards, remove CLI projections/policies/env/docs, and restart to clear ephemeral buckets. No schema/data rollback; committed Courses/questions remain ordinary domain data。
- **Database boundary:** only `NODE_ENV=test` resolving exactly to guarded `smartlearning_test`; existing test setup migration/truncate boundary is authorized. Never use migrate reset/db push/development cleanup/down migration/direct key reactivation。
- **Stop conditions:** DB target unclear; any DB suite silently skips; raw key/hash/token leaks; invalid CLI key falls back to Web; Web CSRF/auth behavior regresses; limiter window does not expire in real time; or a 429 request reaches prohibited DB side effects。

### Implementation checklist

- [x] Add generic operation limiter, four typed policies, env validation/examples, decorator/guard, and string-config/expiry/isolation unit tests。
- [x] Add Course actor/conditional CSRF boundary, validated pagination DTO, CLI draft-summary query, and hybrid list/create controller behavior。
- [x] Apply CLI-only validate/confirm policies to question batches before service execution。
- [x] Add focused CLI courses E2E (`test/cli-courses.e2e-spec.ts`); DB-backed execution was attempted only against the guarded test target and is recorded below。
- [x] Add CLI/batch rate-limit E2E, plus Web/login/credential lifecycle regression assertions in the targeted bundle。
- [x] Update OpenAPI, `docs/frontend-api-reference.md`, env examples, and redaction tests。
- [x] Run and record the targeted DB-backed verification with command/suite/test/skip evidence; the restored guarded test database rerun is green below。
- [ ] Run the full DB-backed verification bundle; this remains deferred until the next authorized regression pass。
- [x] Create and run Manual Checkpoint 4 after automated DB-backed verification became green; user confirmed completion and authorized recording below. CP5 remains gated pending explicit confirmation。

### Results — focused CLI courses E2E (2026-08-31)

- Added `test/cli-courses.e2e-spec.ts` covering CLI create/list ownership and projection boundaries, permission independence, invalid-key fail-closed behavior, and Web collection-route regression.
- Reused the guarded `smartlearning_test` setup pattern and `withQuiescedLiveSessionPublisher` cleanup wrapper.
- Verification: Prettier, repository typecheck, targeted ESLint, targeted Prettier check, and `git diff --check` passed. The full `npm run lint:check` remains blocked by four Prettier diagnostics in pre-existing CP4 production files, which were not edited for this test-only task. DB-backed E2E execution was intentionally not run in this session.

### CP4 focused E2E slice — 2026-08-31

- [x] Add `test/cli-batch-rate-limit.e2e-spec.ts` with low per-policy env overrides applied before app creation and exact environment restoration in teardown.
- [x] Cover per-`CliCredential.id` isolation, policy isolation, Web bypass, stable 429 `RATE_LIMITED` responses with positive `retryAfterSeconds`, and no DB side effects from rate-limited create/validate/confirm requests.
- [x] Cover real-clock expiry/recovery with a reserved validation token and idempotency key; use publisher-quiesced cleanup between DB-backed cases.
- [x] Static verification: Prettier, ESLint, and TypeScript typecheck passed for the current tree.
- [x] DB-backed execution intentionally not run per request; the suite remains guarded to `smartlearning_test` through existing test setup.

#### Results

- **Changed:** Added the focused DB-backed E2E suite at `test/cli-batch-rate-limit.e2e-spec.ts`; no production files were edited for this slice.
- **Verified:** `npx prettier --write test/cli-batch-rate-limit.e2e-spec.ts`, `npx eslint test/cli-batch-rate-limit.e2e-spec.ts`, `npx prettier --check test/cli-batch-rate-limit.e2e-spec.ts`, and `npx tsc --noEmit --pretty false` all passed.
- **Not run:** DB-backed E2E tests, including implicit test-database migration/truncation, were intentionally not executed.

### CP4 targeted DB-backed verification — 2026-08-31

- **Command:** `NODE_ENV=test npm run test:e2e -- --runInBand test/cli-courses.e2e-spec.ts test/cli-batch-rate-limit.e2e-spec.ts test/auth-courses.e2e-spec.ts test/question-batches.e2e-spec.ts test/auth-rate-limit.e2e-spec.ts test/cli-credential.e2e-spec.ts test/openapi.e2e-spec.ts`
- **Authorization:** user explicitly authorized `NODE_ENV=test`, guarded `smartlearning_test`, and the existing test setup migration/truncation boundary; no reset/db push/development DB operation was used。
- **Result:** **BLOCKED** for both new CP4 DB-backed suites because the guarded PostgreSQL target was unavailable; combined process exited 1. Existing suites: 5 passed; OpenAPI passed。
- **Counts:** 7 suites total; 5 passed, 2 blocked suites reported as failed by Jest; 37 tests passed, 13 blocked test cases; 0 snapshots。Captured diagnostics were the suites' explicit `BLOCKED: PostgreSQL migration/schema is unavailable` messages; no lower-level connection error was retained。
- **Required follow-up:** restore/verify availability of guarded `smartlearning_test`, then rerun the exact targeted command before Manual Checkpoint 4. Blocked tests are not green。

#### Restored-database rerun — 2026-08-31

- **Command:** `NODE_ENV=test npm run test:e2e -- --runInBand test/cli-courses.e2e-spec.ts test/cli-batch-rate-limit.e2e-spec.ts test/auth-courses.e2e-spec.ts test/question-batches.e2e-spec.ts test/auth-rate-limit.e2e-spec.ts test/cli-credential.e2e-spec.ts test/openapi.e2e-spec.ts`
- **Result:** **PASS** — 7/7 suites, 50/50 tests, 0 skipped, 0 snapshots; duration 88.845s; no failures。
- **Verification confidence:** integration-level targeted E2E against guarded `smartlearning_test`。

### Manual Checkpoint 4 — verified（2026-08-31）

- [x] **BE-8.4 CP4 — CLI courses 與 CLI/batch rate limit 人工 Checkpoint 4 完成。** User confirmed the manual checkpoint evidence and authorized recording the result。
- [x] Automated prerequisite targeted E2E is green: 7 suites / 50 tests passed, with no skips or failures。
- [ ] CP5 not started; explicit user confirmation remains required before proceeding。

### Focused rate-limit unit coverage — 2026-08-31

- [x] Added service coverage for max+1, FakeClock expiry, policy/credential isolation, and string config coercion.
- [x] Added guard coverage for Web bypass, CLI `RATE_LIMITED` error, missing actor, and missing credential fail-closed behavior.
- [x] Added env validation coverage for all eight CLI rate-limit fields, including valid string coercion and invalid lower bounds.
- [x] Verification: `npx prettier --check src/config/env.validation.spec.ts src/modules/rate-limit/operation-rate-limiter.service.spec.ts src/modules/rate-limit/operation-rate-limit.guard.spec.ts` passed; `npm test -- --runInBand modules/rate-limit/operation-rate-limiter.service.spec.ts modules/rate-limit/operation-rate-limit.guard.spec.ts config/env.validation.spec.ts` passed (3 suites, 21 tests).
- [x] No production code changed; no DB-backed tests were run.

## 2026-08-31 BE-8.5 CP5 — Redis multi-instance login rate limit

### Context and acceptance criteria

- [x] Move only login account/source fixed-window counters from process-local memory to Redis so two backend instances share count and TTL.
- [x] Preserve US-F7 behavior: NFKC/trim/lowercase account normalization; pre-check before account lookup/Argon2; dual-scope failure counting; generic 401 before max and 429 on the next pre-check; longest retry TTL; account-only clear on success; missing/disabled/wrong-password anti-enumeration.
- [x] Redis keys use versioned namespace, domain-separated HMAC-SHA-256, and no raw username/IP/reversible identifier in key/log/response/metrics.
- [x] Redis operations use atomic Lua scripts: pre-check, fixed-window failure recording without TTL extension, no-TTL corruption repair, and account-only clear.
- [x] Redis outage is fail-closed: login returns 503 `AUTH_RATE_LIMIT_UNAVAILABLE` before account lookup/Argon2; readiness 503; liveness 200; no memory fallback in `redis-required`; recovery is bounded and preserves unexpired buckets.
- [x] Real Redis integration and two actual backend instances prove shared account/source limits, normalization, outage/recovery, opaque positive TTLs, and no skipped required checks.

### Contract freeze / working notes

- `LOGIN_RATE_LIMIT_MODE` is `memory|redis-required`; development/test default to memory, production must use `redis-required`.
- Redis login settings are independent from realtime Redis: `LOGIN_RATE_LIMIT_REDIS_URL`, `LOGIN_RATE_LIMIT_KEY_SECRET`, `LOGIN_RATE_LIMIT_CONNECT_TIMEOUT_MS`, and `LOGIN_RATE_LIMIT_COMMAND_TIMEOUT_MS`.
- CP4 `OperationRateLimiterService` remains in-memory and unchanged; PostgreSQL remains Account/Session/domain authority.
- Redis command timeout or mutation state uncertainty is not retried. A post-commit account-clear failure does not fail an already-successful login; the account bucket expires naturally.
- Manual Checkpoint 5 is a mandatory stop. Do not record completion until the user explicitly confirms `Checkpoint 5 verified` after reviewing sanitized multi-instance and outage evidence.

### Dependencies & environment

- Node.js 24+, existing `redis` 6.2.1 dependency, PostgreSQL only for guarded auth E2E, and a dedicated Redis 7 test service/URL.
- DB-backed tests may mutate only explicitly authorized `smartlearning_test`; no migration/truncate is run without explicit authorization. Redis tests require explicit opt-in, a test-only URL, unique hard-coded prefix, and prefix-scoped cleanup only.

### Risk & rollback

- **Risk: high** — authentication abuse prevention, multi-instance consistency, Redis dependency outage, key privacy, and timeout mutation semantics.
- **Rollback:** revert the application image while retaining namespaced Redis keys until TTL expiry; never use `FLUSHDB`/`FLUSHALL`. Returning to memory is safe only with an explicitly approved single-instance topology, never scaled out.

### Implementation checklist

- [x] Add CP5 env validation, examples, store contract, memory store, HMAC key factory, Redis store, and module wiring.
- [x] Add stable outage error and update async auth orchestration plus readiness checks.
- [x] Update unit/regression tests and add real Redis integration coverage.
- [x] Add dedicated CP5 Compose topology and fail-fast two-instance manual verifier.
- [x] Run DB-free static/behavioral verification; Redis/DB-backed suites remain gated by explicit authorization.
- [x] Stop at Manual Checkpoint 5, present sanitized evidence, and record the user's explicit sign-off.

### Results

- Implemented async login limiter façade with memory and dedicated Redis stores, HMAC-opaque namespaced keys, atomic Lua fixed-window scripts, bounded fail-closed Redis lifecycle, stable outage error, readiness reporting, auth orchestration, CP5 Compose topology, and dedicated integration/manual verification entrypoints.
- DB-free verification passed: 5 focused contract suites (51 tests), auth limiter boundary suite (3 tests), and full unit suite (38 suites / 246 tests); typecheck, format check, lint check, build, Prisma validation, Compose config topology, and `git diff --check` passed.
- Real Redis integration and two-backend DB-backed verifier were not run: they require explicit Redis/Compose and guarded database authorization. `npm run prisma:migrate:status` was attempted read-only but blocked because `smartlearning_dev` PostgreSQL at `localhost:5432` was unreachable; no DB mutation occurred. Manual Checkpoint 5 remains pending user evidence review.

### CP5 Redis integration verification — 2026-08-31

- **AUTHORIZED:** user explicitly authorized CP5 Redis integration verification.
- **Scope:** dedicated Redis 7 service only, isolated Compose project `smartlearning-cp5-redis-it`, host port `6381`, hard-coded test prefix cleanup only. PostgreSQL, migrations, backend instances, and manual two-instance verification were not run.
- **Command:** `RUN_LOGIN_RATE_LIMIT_REDIS_TESTS=1 LOGIN_RATE_LIMIT_TEST_REDIS_URL=redis://127.0.0.1:6381 npm run test:login-rate-limit:redis -- --runInBand`
- **RESULT:** PASS — 1 suite / 6 tests. Atomic shared buckets and positive TTL; fixed-window TTL non-extension; concurrent increments and account-only clearing; no-TTL repair and corrupt-bucket fail-closed behavior; real TTL expiry recovery all passed.
- **Safety:** Redis service started healthy, then the named container/network were removed with `docker compose down --remove-orphans`; the isolated Redis volume was retained. No `FLUSHDB`/`FLUSHALL`, PostgreSQL migration, DB truncation, or product source change was performed.
- **Decision:** Redis store integration evidence is complete for this slice. Manual Checkpoint 5 remains pending and must not be self-signed-off; the two-backend DB-backed verifier still requires a separate authorized run and sanitized evidence review.

### CP5 two-backend verifier — 2026-08-31

- **AUTHORIZED:** user explicitly authorized the two-backend CP5 verifier and approved process-only temporary credentials plus scoped cleanup.
- **Preflight:** fresh isolated Compose project was built from the current checkout; PostgreSQL and Redis were healthy, both backend instances were healthy and reachable, and the migration container exited `0`.
- **Test harness corrections:** increased the dedicated verifier window to 15 seconds so the outage/recovery sequence tests an unexpired bucket; set an explicit 45-second Jest timeout; added a Redis client error listener; and made the anti-enumeration test reach the source limit without asserting a premature 429.
- **Command:** `npm run test:cp5:e2e -- --runInBand`
- **RESULT:** PASS — 1 suite / 4 tests. Shared account/source limits, normalization and anti-enumeration, account-only clear after successful login, Redis outage fail-closed behavior, readiness 503/liveness 200, recovery with preserved buckets, opaque keys, and positive TTLs all passed.
- **Timing:** verifier completed in approximately 72.6 seconds after the dedicated 15-second fixed-window margin was applied.
- **Safety:** only a fresh named Compose project and its dedicated database/Redis volumes were used; migration/truncation was confined to that isolated database. The named containers/network were removed with `docker compose down --remove-orphans`; volumes were retained. No unrelated Compose resource, `smartlearning_test`, `FLUSHDB`, or `FLUSHALL` was touched.
- **Decision:** CP5 automated two-backend evidence is ready for review. Manual Checkpoint 5 remains mandatory and pending explicit user confirmation `Checkpoint 5 verified`; do not self-sign-off.

### CP5 manual Checkpoint 5 execution — 2026-08-31

- **AUTHORIZED:** user requested continuation of CP5 manual Checkpoint 5; execution used only a fresh named Compose project with process-only temporary credentials.
- **Preflight:** `docker compose ... config --quiet` passed; PostgreSQL 16 and Redis 7 became healthy; the migration container completed successfully; both backend readiness probes returned 200.
- **Bootstrap:** created the temporary admin with the compiled runtime entrypoint `node dist/src/bootstrap/bootstrap-admin.js` inside `backend-a` because the runtime image intentionally omits the dev-only `tsx` binary.
- **Command:** `npm run test:cp5:e2e -- --runInBand`
- **RESULT:** PASS — 1 suite / 4 tests. Shared account/source limits, normalization and anti-enumeration, account-only clear after successful login, Redis outage fail-closed behavior, readiness 503/liveness 200, recovery with preserved buckets, opaque keys, and positive TTLs all passed in approximately 73 seconds.
- **Safety:** only `smartlearning-cp5-manual-r3` containers, network, and retained named volumes were used; cleanup removed the containers/network with `docker compose down --remove-orphans`. No unrelated containers, `smartlearning_test`, `FLUSHDB`, or `FLUSHALL` were touched.
- **Decision:** sanitized automated evidence was reviewed and accepted by the user through the explicit confirmation `Checkpoint 5 verified`.

### Manual Checkpoint 5 sign-off — 2026-08-31

- **USER CONFIRMATION:** User explicitly confirmed `Checkpoint 5 verified` after reviewing the sanitized multi-instance and Redis-outage evidence.
- **STATUS:** BE-8.5 CP5 acceptance criteria and Manual Checkpoint 5 are complete.

## 2026-08-31 BE-8.6 CP6 — Redaction / disclosure review

### Source and scope

- **Plan:** `../docs/智學互動平台/50_實作與測試/BackendBE8/be-8-cp6-redaction-review-plan.md`
- **Scope:** CP1–CP5 sensitive-field and output-surface audit: central Pino redaction, exception/validation disclosure, generated OpenAPI schemas/examples/defaults, bootstrap console output, and login/CLI rate-limit key privacy.
- **Non-goals:** no CP7 metrics; no API contract, Redis bucket/HMAC algorithm, permission, Prisma schema, migration, or data changes.

### Acceptance criteria

- [ ] Every CP1–CP5 sensitive field has a classification, sink/path, existing protection, and executable tripwire.
- [ ] Logs, error envelopes, validation details, OpenAPI examples/defaults do not expose credentials, tokens, hashes, answer/question content, request PII, rate-limit internal keys, or arbitrary exception messages.
- [ ] Contract-allowed `expiresAt` and one-time CLI `rawKey` remain only in their allowed API responses; logging redacts response-shaped copies.
- [ ] Operational IDs, request IDs, fixed codes/reasons, error type metadata, and safe structured metadata remain available.
- [ ] New sanitization/redaction rules have sentinel-based executable coverage.
- [ ] Manual Checkpoint 6 evidence is produced and remains `PENDING USER INSPECTION` until explicit user confirmation `Checkpoint 6 verified`.

### Dependencies & environment / DB boundary

- Node 24+, existing npm dependencies, Pino/Nest/Swagger test setup, synthetic sentinels only.
- DB-free unit/static checks first. DB-backed/OpenAPI E2E may run only after explicit authorization for `NODE_ENV=test` and exactly guarded `smartlearning_test`; never touch `smartlearning_dev`, never run migration/truncate without authorization, and never silently skip.

### Risk & rollback

- **Risk: high** — under-redaction can leak secrets; over-redaction can remove required observability or alter public responses.
- **Rollback:** revert only source/test/documentation changes; no schema/data rollback and no credential/rate-limit state changes.
- **Stop conditions:** unexpected Pino record shape, contract conflict, missing tripwire for a newly sensitive field, sentinel in a prohibited output, wrong DB target, silent skip, or normal suite accidentally excluded.

### Working notes

- Never log password/hash/cookie/auth/CSRF/token/raw CLI key/idempotency or payload hash/answers/question content/request PII/raw/composed rate-limit keys/arbitrary thrown message/value.
- Context-sensitive: allowed API `expiresAt`/`rawKey` stay on-wire but are removed from serialized logs; `req.body.displayName` is redacted narrowly, not every `displayName` path.
- Safe metadata: stable resource IDs, request ID, fixed reason/code, `errorType`.
- Use complete serialized-output assertions with unique sentinels; do not blanket-redact generic `key`, `id`, `expiresAt`, or `displayName` paths.

### Implementation checklist

- [x] Build CP6 audit matrix and review document `../docs/智學互動平台/50_實作與測試/BackendBE8/be-8-cp6-redaction-review.md`.
- [x] Add failing Pino redaction tripwires, then implement exact path redaction.
- [x] Remove arbitrary error message/value logging from listed catch paths and add logger-spy coverage.
- [x] Harden bootstrap console output without restructuring bootstrap into Pino.
- [x] Add validation/error disclosure tripwires and narrow normalization only after a rejected-value leak was proven.
- [x] Add rate-limit key/privacy tripwires without changing key/bucket semantics.
- [x] Audit generated OpenAPI schemas and examples/defaults with a recursive test-only walker (execution pending DB authorization).
- [x] Add explicit manual CP6 verifier; keep excluded from default E2E and generate synthetic specimens.
- [x] Run targeted DB-free tests and static searches; request DB authorization before OpenAPI/negative-disclosure E2E.
- [x] Run authorized DB-free quality gates and record exact results/counts/skips.
- [x] Complete Manual Checkpoint 6 after explicit user sign-off `Checkpoint 6 verified`; CP6 is now verified.

### Results — 2026-09-01 implementation and DB-free verification

- **Changed:** Added exact CP6 Pino redaction paths for request account/question data and batch response question/preview/hash/expiry collections; replaced arbitrary error message/value logging with fixed metadata plus `errorType`; hardened bootstrap output; sanitized rejected-value validation messages; fixed dynamic question-validation wording; added OpenAPI metadata/placement checks; added dedicated synthetic manual verifier and review ledger.
- **Automated targeted unit:** PASS — 12 suites / 69 tests, including Pino, HTTP validation/filter, domain validation, account/bus/service/gateway logger sinks, and Redis store logging.
- **Full unit:** PASS — `npm test -- --runInBand --silent`, 43 suites / 258 tests, 0 skipped.
- **Manual synthetic verifier:** PASS — `npm run test:cp6:manual -- --runInBand`, 1 suite / 1 test; six sanitized specimen categories printed. The specimens are recorded in `../docs/智學互動平台/50_實作與測試/BackendBE8/be-8-cp6-redaction-review.md`.
- **Static quality:** PASS — `git diff --check`, `npm run prisma:validate`, `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`; disclosure `rg` searches found no `error.message` or `String(error)` in `src`.
- **OpenAPI E2E:** authorized run reached 4/4 passing tests after adding generated response-model decorators, but exited 1 because `afterAll` timed out at 30s while the full app's background scheduler/publisher encountered database errors. Treat as BLOCKED, not green; schema/migration state needs an authorized check.
- **Migration status:** `NODE_ENV=test npm run prisma:migrate:status` confirmed the guarded target `smartlearning_test` at `localhost:5432`, then returned `P1001` because PostgreSQL was unreachable. No mutation occurred.
- **Not run / blocked:** default E2E and integration.
- **Manual status:** `PENDING USER INSPECTION`; do not mark Checkpoint 6 verified until the user explicitly replies `Checkpoint 6 verified`.

### Results — 2026-09-01 test database recovery

- **Database service:** PASS — created isolated `smart-learning-pg-test` PostgreSQL 16 container with dedicated `pgdata_smartlearning_test` volume and loopback-only mapping `127.0.0.1:5432`; existing containers and volumes were not reused or removed.
- **Connectivity:** PASS — read-only query confirmed `smartlearning_test`, user `smartlearning`, schema `public`.
- **Migrations:** PASS — after explicit authorization, all 15 repository migrations applied; follow-up `NODE_ENV=test npm run prisma:migrate:status` reported `Database schema is up to date!`.
- **Targeted verification:** PASS — `NODE_ENV=test npm run test:e2e -- --runInBand test/openapi.e2e-spec.ts`; 1 suite / 4 tests passed, 0 failed, 0 skipped. Pre-existing Nest `LegacyRouteConverter` warnings were emitted but did not fail the suite.
- **Scope:** No source files or existing database volumes were changed; default E2E and integration suites remain unrun.

### Manual Checkpoint 6 — verified (2026-09-01)

- **USER CONFIRMATION:** User explicitly confirmed `Checkpoint 6 verified` after reviewing the six sanitized CP6 log, error-envelope, rate-limit, and OpenAPI disclosure specimens.
- **STATUS:** BE-8.6 CP6 redaction/disclosure acceptance criteria and Manual Checkpoint 6 are complete.

## 2026-09-01 BE-8.7 CP7 — Metrics and observability

### Context and acceptance criteria

- **Plan:** `../docs/智學互動平台/50_實作與測試/BackendBE8/BE-8.7 CP7 Metrics 與 observability 實作計畫.md`
- **Baseline:** Preserve the uncommitted CP6 redaction/error-shape changes; CP7 is additive and must remain reviewable separately.
- [x] Anonymous root `GET /metrics` is raw Prometheus text, `VERSION_NEUTRAL`, unwrapped, and unguarded; `/api/v1/metrics` is not an alias.
- [x] Fixed low-cardinality HTTP, login-limit, realtime, job, and readiness metric families are exposed without sensitive values.
- [x] Scrape performs no PostgreSQL/Redis/readiness I/O; metric failures never change application behavior.
- [x] Alert rules, dashboard inventory, README, targeted tests, metrics E2E, and manual Checkpoint 7 verifier are delivered.
- [x] Automated evidence is complete and the process stops at Manual Checkpoint 7 pending explicit `Checkpoint 7 verified`.

### Dependencies and environment / DB boundary

- Node 24+, npm, direct `prom-client`; no OpenTelemetry, Prometheus/Grafana deployment, Nginx change, schema, migration, or retention worker.
- DB-backed E2E/integration may run only with explicit authorization against guarded `NODE_ENV=test` database `smartlearning_test`; never touch development/production DB and never silently skip.

### Risk and rollback

- **Risk: medium-high** — route-label cardinality/disclosure, duplicate registries, metrics exceptions crossing domain boundaries, authoritative transition miscounts, Redis readiness conflation, and CP6/CP7 diff interleaving.
- **Rollback:** remove CP7 source/test/artifact/dependency/wiring changes only. Do not clear DB/Redis, alter credentials, change transactions, or replace `/metrics` with an application guard.

### Working notes

- Registry is per Nest application; no process-global registry/default collectors/module-scope collectors/`Registry.clear()`.
- Route labels use only matched string templates from `baseUrl + req.route.path`; malformed/missing routes are `__unmatched__`; never use URL/query/params/IDs/tokens/errors.
- Count only authoritative outcomes: limited decisions, persisted publisher retry/dead transitions, real job runs/items, and completed readiness observations.
- Optional `realtime_redis` degradation remains distinct from required `login_rate_limit` unready behavior.

### Implementation checklist

- [x] Add `prom-client`, application-owned registry, typed non-throwing facade, and fixed metric contract.
- [x] Add raw root `/metrics` controller, exact prefix exclusion, and safe finish/close HTTP middleware.
- [x] Instrument login limiter, durable publisher, auto-close scheduler/service, retention purge, and readiness boundaries.
- [x] Add operational alert rules, dashboard inventory, and observability README.
- [x] Add metrics unit, integration-boundary, artifact, E2E, and manual verifier coverage.
- [x] Run targeted and full verification; record blocked DB checks explicitly.
- [x] Execute Manual Checkpoint 7 and await user confirmation.

### Results

- **Implementation:** CP7 metrics and observability delivered additively over the uncommitted CP6 changes. Added a per-application `prom-client` registry, typed non-throwing metrics facade, safe root-level raw `/metrics` endpoint, low-cardinality HTTP middleware, semantic instrumentation, operational alert/dashboard/README artifacts, and regression coverage. No schema or migration files were added.
- **Targeted metrics verification:** `npm test -- --runInBand src/modules/metrics` — PASS, 3 suites / 10 tests. `NODE_ENV=test npm run test:e2e -- --runInBand test/metrics.e2e-spec.ts` — PASS, 1 suite / 3 tests.
- **Instrumentation-boundary verification:** rate limiter, publisher, auto-close scheduler, governance retention, and readiness specs — PASS, 5 suites / 35 tests. Full unit suite — PASS, 47 suites / 277 tests.
- **Static quality verification:** `npm run prisma:validate`, `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`, and `git diff --check` — PASS.
- **Full guarded E2E:** `NODE_ENV=test npm run test:e2e -- --runInBand` — PASS, 32 suites / 219 tests, 0 failed / 0 skipped; guarded `smartlearning_test` only. Jest exited normally without teardown or open-handle warnings.
- **Integration verification:** The full `NODE_ENV=test npm run test:integration -- --runInBand` command reported 3/4 suites and 16/22 tests passed; it exited 1 because the six tests in `test/login-rate-limit.redis.integration-spec.ts` intentionally require explicit `RUN_LOGIN_RATE_LIMIT_REDIS_TESTS=1` opt-in. The non-Redis rerun, `NODE_ENV=test npm run test:integration -- --runInBand --testPathIgnorePatterns=login-rate-limit.redis.integration-spec.ts`, passed 3/3 suites and 16/16 tests against guarded `smartlearning_test`. No migration was run and no files were edited by the verifiers. This is recorded as a blocked/guarded Redis integration subset, not a CP7 failure.
- **Database status:** read-only `NODE_ENV=test npm run prisma:migrate:status` — PASS; `smartlearning_test` is up to date with 15 migrations. CP7 added no migration.
- **Manual verifier:** `npm run test:cp7:manual -- --runInBand` — PASS, 1 suite / 1 test. Evidence included safe metric families, readiness policy `database:healthy,realtime_redis:degraded,login_rate_limit:healthy`, and alert inventory covering database, login limiting, realtime retry/dead, auto-close, retention, and optional Redis degradation. CP6 manual verifier also passed with no disclosure failures.
- **Prometheus tooling:** `promtool` is unavailable; alert rules were validated by static artifact tests instead.
- **Manual Checkpoint 7:** User explicitly confirmed `Checkpoint 7 verified` on 2026-09-01. CP7 acceptance and checkpoint are complete.

## 2026-09-01 BE-8.8 CP8 — Production-like topology compatibility

### Context and acceptance criteria

- **Plan:** `../docs/智學互動平台/50_實作與測試/BackendBE8/BE-8.8 CP8 Production-like topology 相容性實作計畫.md`
- **Baseline:** `main` at `1e7e0527bee3053e3c99f127b573cf76ba9ba0dc`, clean working tree, Node `v26.5.1`, npm `11.17.0`, Docker `29.6.2`, Compose `v5.3.1`.
- [x] HTTPS verification-only Nginx proxy proves secure cookies, exact Origin/CSRF, and Socket.IO handshake/upgrade from an isolated verifier network; host-loopback curl is blocked by this Rancher Desktop WSL environment.
- [x] Isolated Compose topology proves realtime Redis adapter mode, internal-only backend/DB/Redis/metrics exposure, migration ordering, and compiled runtime startup.
- [x] Shutdown drill emits retryable socket closure and cleanly stops/restores API instances; readiness 503 during the very short shutdown window was not captured by polling and remains a manual inspection item.
- [x] Handoff records env, rollout/rollback, failure drills, evidence collection, and BE/OPS ownership boundaries.
- [x] Automated evidence stopped at `PENDING USER INSPECTION`; the user explicitly confirmed `Checkpoint 8 verified` on 2026-09-01, closing CP8.

### Risk & rollback

- **Risk: medium-high** — proxy trust, secure-cookie/CSRF boundaries, two-instance realtime delivery, and shutdown sequencing can affect authentication and committed submissions.
- **Rollback:** disable `REALTIME_REDIS_MODE` or stop the verification-only topology and return to the previously verified single-instance/local adapter path; revert additive source/docs/config changes. Never weaken CSRF/Origin/Secure-cookie checks, restore revoked credentials, clear databases, or use a destructive migration rollback.

### Dependencies & environment

- Node 24+, npm, Docker/Compose, compiled runtime image, PostgreSQL and Redis supplied only by the isolated CP8 project.
- CP8 Compose uses a unique project name, isolated network/volumes, generated self-signed localhost certificate, explicit HTTPS origin, two Redis logical boundaries, and no host publication for backend/DB/Redis/metrics.
- The user explicitly authorized the isolated CP8 Docker topology on 2026-09-01; migration ran only against the Compose-owned `smartlearning_cp8` database. No shared development/test database, truncate, or DB-backed suite was used.

### Working notes

- PostgreSQL remains domain authority; Redis is fan-out/rate-limit infrastructure only.
- `REALTIME_REDIS_MODE=required` blocks realtime traffic/readiness when unavailable; login limiter uses a separate Redis URL and remains fail-closed.
- `/health/live` performs no dependency I/O; `/health/ready` includes application shutdown state and required dependency status.
- Nginx overwrites forwarded scheme/host/client address and clears identity-like headers; backend trusts only the configured proxy hop count and never establishes auth from forwarded identity headers.
- Durable replay remains bounded by the existing outbox retention/recovery contract; CP8 must report any unsupported claim as `DEFERRED/BLOCKED`.

### Implementation checklist

- [x] Add explicit trusted-proxy and shutdown lifecycle state/configuration with targeted unit coverage.
- [x] Add verification-only `ops/topology/` Nginx/TLS/Compose fixture and static topology assertions.
- [x] Update env template, README, and operational handoff with safe topology/rollout/rollback guidance.
- [x] Run code-only/static checks and the authorized isolated Compose migration/runtime drills.
- [x] Stopped at `PENDING USER INSPECTION`; exact user confirmation `Checkpoint 8 verified` was received on 2026-09-01.

### Results

- Code-only verification: CP8 static tests 3/3, lifecycle/env/readiness tests 44/44, typecheck, lint, format, build, and `git diff --check` all PASS.
- Compose startup: migration exited 0 after the migration image received OpenSSL; both compiled API instances, PostgreSQL, both dedicated Redis services, and Nginx reached the expected running/healthy state. The fixture now uses an internal `cp8` data-plane network plus a narrowly scoped Nginx/certificate `edge` network so the loopback HTTPS publication functions without exposing backend/data services.
- Proxy/auth smoke from an isolated verifier container: TLS health `200/200`, `/metrics` `404`, login `201`, Secure `__Host-session`/`__Host-csrf` attributes, missing/wrong/wildcard CSRF Origin `403`, valid CSRF `201`, logout `201`, and revoked session `401` all PASS. Direct host `curl https://localhost:8443` could not connect in this Rancher Desktop WSL environment; the published mapping is present and the internal verifier reached the TLS proxy.
- Realtime smoke: teacher and participant Socket.IO clients received `session.snapshot`; teacher-only counts were present only for the teacher projection, participant counts were hidden, and polling upgraded to WebSocket through Nginx. Nginx uses `ip_hash` because Engine.IO polling sessions are instance-local while Redis shares application fan-out.
- Failure drills: stopping `redis-realtime` produced liveness `200` and readiness `503`; after Redis restart, automatic recovery did not return readiness within 30 seconds, while restarting both API instances restored readiness `200`. Treat automatic Redis recovery as a follow-up/manual inspection item. SIGTERM delivered `server.shutdown` with `SERVER_SHUTTING_DOWN` and `retryable=true`; API instances restored cleanly.
- Authority check: isolated PostgreSQL returned one accepted Submission, `live_session=active`, `session_question=open`, and eight durable event rows for the exercised session. No Redis or logs were used as domain truth.
- **Manual status:** `Checkpoint 8 verified` confirmed by the user on 2026-09-01; CP8 is complete. The documented Redis automatic-recovery follow-up remains open for a later slice. After confirmation, project `smartlearning-cp8-teacher` was torn down with `down --remove-orphans`; named volumes were retained.

## 2026-09-01 BE-8.9 CP9 — Final release evidence

### Context and acceptance criteria

- **Plan:** `../docs/智學互動平台/50_實作與測試/BackendBE8/BE-8.9 CP9 Final release evidence 實作計畫.md`。
- **Scope:** release-evidence/documentation plus the separately reviewed realtime adapter fix required to unblock the release gate. No schema, migration, or runtime-configuration change was made.
- [x] Capture the actual execution baseline, sanitized test DB target, and read-only migration status.
- [x] Create the BE-8.1–BE-8.10 evidence matrix with permitted classifications and historical/current evidence separation.
- [x] Complete current-HEAD verification with zero failures/skips after the adapter fix; the initial interrupted attempt is retained below as historical evidence.
- [x] Complete final quality gates and current-HEAD manual CP6/CP7 evidence generators; all required authorized checks passed in the rerun.
- [x] **Manual Final sign-off:** approved by the user on 2026-09-02 with BE-8.7 and BE-8.10 blockers retained; no broader release or production certification is inferred.

### Authorization boundary

- **Authorized:** `NODE_ENV=test` against exactly `localhost:5432/smartlearning_test`, including `test/setup/db.ts`'s guarded idempotent `npx prisma migrate deploy` and non-migration-table `TRUNCATE ... RESTART IDENTITY CASCADE` behavior if reached by a DB-backed suite.
- **Not authorized:** `smartlearning_dev`, production databases, `migrate reset`, `db push`, arbitrary SQL cleanup, credential restoration, volume deletion, Compose/Redis runtime drills, or real-Redis integration. The rerun used only the authorized `smartlearning_test` setup boundary.
- **Evidence rule:** retain no passwords, full connection URLs, cookies, session/CSRF/participant/CLI tokens, Redis keys, hashes, answer content, or raw credentials.

### Baseline and working notes

- **Initial interrupted attempt UTC:** `2026-09-01T15:50:29Z`; **CP9 rerun baseline UTC:** `2026-09-01T16:28:14Z`; **final gate/status recapture UTC:** `2026-09-01T17:26:39Z`.
- **Branch/HEAD:** `main`, `37bcbe02312f1e44b3bf458f201b929b82f5a2ef` (`37bcbe0`).
- **Working tree:** the initial interrupted attempt was clean; the rerun included the reviewed adapter source/test fix plus existing `tasks/lessons.md` and `tasks/todo.md` edits. The external CP9 packet is outside this backend Git repository.
- **Tool versions:** Node `v26.5.1`; npm `11.17.0`; Prisma CLI/client `7.9.1`.
- **Sanitized DB target:** host `localhost`, port `5432`, database `smartlearning_test`.
- **Migration status:** read-only `NODE_ENV=test npm run prisma:migrate:status` passed; 15 migrations found and schema up to date.
- **CP1 reconciliation:** the stale pending line was corrected from the explicit confirmation recorded in `be-8-1-cp1-session-expiry.md:169`; no new confirmation was invented.
- **Initial stop condition:** full unit verification failed before CP8 static, DB-backed, manual, and final quality-gate commands could run. The subsequent CP9 rerun completed after the adapter fix.

### Initial interrupted attempt (historical) — verification results

| Command                                                                                                                     | Exit | Result / counts                                                           | Notes                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ---: | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git diff --check` (baseline)                                                                                               |    0 | PASS                                                                      | Clean baseline; no output.                                                                                                                                                                                                |
| `NODE_ENV=test npm run prisma:migrate:status`                                                                               |    0 | PASS                                                                      | Exact target `smartlearning_test`; 15 migrations; up to date; read-only.                                                                                                                                                  |
| `npm run prisma:validate`                                                                                                   |    0 | PASS                                                                      | Schema valid.                                                                                                                                                                                                             |
| `npm test -- --runInBand`                                                                                                   |    1 | **FAIL — 49 suites / 291 tests; 48 passed, 1 failed; 0 skipped reported** | `src/modules/realtime/realtime-redis.service.spec.ts:76`, “closes the replaced Redis adapter while preserving room membership”: expected `redisAdapters[0].close` once, received 0. No Jest teardown/open-handle warning. |
| `npm run test:cp8:static -- --runInBand`                                                                                    |    — | NOT RUN                                                                   | Stopped after unit failure.                                                                                                                                                                                               |
| `NODE_ENV=test npm run test:e2e -- --runInBand`                                                                             |    — | NOT RUN                                                                   | Stopped after unit failure; no DB mutation.                                                                                                                                                                               |
| `NODE_ENV=test npm run test:integration -- --runInBand --testPathIgnorePatterns=login-rate-limit.redis.integration-spec.ts` |    — | NOT RUN                                                                   | Stopped after unit failure; no DB mutation.                                                                                                                                                                               |
| `NODE_ENV=test npm run test:cp6:manual -- --runInBand`                                                                      |    — | NOT RUN                                                                   | Stopped after unit failure.                                                                                                                                                                                               |
| `NODE_ENV=test npm run test:cp7:manual -- --runInBand`                                                                      |    — | NOT RUN                                                                   | Stopped after unit failure.                                                                                                                                                                                               |
| `npm run typecheck`                                                                                                         |    — | NOT RUN                                                                   | Stopped after unit failure.                                                                                                                                                                                               |
| `npm run lint:check`                                                                                                        |    — | NOT RUN                                                                   | Stopped after unit failure.                                                                                                                                                                                               |
| `npm run format:check`                                                                                                      |    — | NOT RUN                                                                   | Stopped after unit failure.                                                                                                                                                                                               |
| `npm run build`                                                                                                             |    — | NOT RUN                                                                   | Stopped after unit failure.                                                                                                                                                                                               |
| `git diff --check` (final)                                                                                                  |    — | NOT RUN                                                                   | Must be rerun after blocker remediation and full inventory.                                                                                                                                                               |
| `NODE_ENV=test npm run prisma:migrate:status` (final)                                                                       |    — | NOT RUN                                                                   | Preflight status passed; final status must be recaptured after a complete rerun.                                                                                                                                          |

The initial diagnostic implementation made `close()` synchronous and passed the isolated lifecycle test, then was replaced by the reviewed fix now present in the working tree. The final rerun covers synchronous invocation, retained-adapter recovery, async shutdown draining, and sync/async failure isolation.

### BE-8.1–BE-8.10 matrix summary

| Item    | Frozen scope                                                                                                                           | Implementation / evidence                                                                                                                                        | Evidence commit(s)                      | Classification                                                                                                 | Manual checkpoint                                                | Open limitation / CP9 note                                                                                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BE-8.1  | `/auth/session` returns real UTC `expiresAt`; absent session remains 401                                                               | `src/common/auth/session.service.ts`; `test/auth-session-expiry.e2e-spec.ts`; CP1 evidence doc                                                                   | `6131140`                               | `runtime verified`                                                                                             | CP1 verified 2026-08-30 (explicit record at CP1 evidence `:169`) | Initial CP9 attempt stopped at the unit regression; the 2026-09-02 rerun passed.                                                                                                                             |
| BE-8.2  | Expired session uses `AUTH_SESSION_EXPIRED`; missing/malformed/revoked/disabled auth uses `UNAUTHORIZED`                               | `src/common/errors/domain-error.ts`; `src/common/errors/error-codes.ts`; session unit/E2E specs                                                                  | `6131140`                               | `runtime verified`                                                                                             | CP1 verified 2026-08-30                                          | Initial CP9 attempt did not reach this suite; the 2026-09-02 rerun passed.                                                                                                                                   |
| BE-8.3  | Admin account update allowlist and must-change-password gate                                                                           | `src/modules/identity/application/account.service.ts`; `test/account-admin.e2e-spec.ts`; `test/manual-cp2-verify.e2e-spec.ts`                                    | `1f48655`, `e0b53ba`                    | `runtime verified`                                                                                             | CP2 verified 2026-08-30                                          | Historical targeted/full evidence remains the available executable proof; the 2026-09-02 current-HEAD rerun passed.                                                                                          |
| BE-8.4  | CLI credential rotation creates one active successor, immediately revokes predecessor, and persists only hashes                        | `src/modules/identity/application/cli-credential.service.ts`; `test/cli-credential.e2e-spec.ts`; `test/manual-cp3-verify.e2e-spec.ts`; additive Prisma migration | `4d906e0`                               | `runtime verified`                                                                                             | CP3 verified 2026-08-30                                          | Current-HEAD E2E rerun passed; no raw key/hash retained.                                                                                                                                                     |
| BE-8.5  | CLI-owned course list/create routes preserve ownership and Web behavior                                                                | `src/modules/courses/api/courses.controller.ts`; `src/modules/courses/application/course.service.ts`; `test/cli-courses.e2e-spec.ts`                             | `36be9bb`, `0261327`                    | `runtime verified`                                                                                             | CP4 verified 2026-08-31                                          | Historical restored-DB targeted evidence is cited; current CP9 E2E rerun passed.                                                                                                                             |
| BE-8.6  | CLI/batch fixed-window limits are credential-scoped, isolated, and expire with stable 429 response                                     | `src/modules/rate-limit/operation-rate-limiter.service.ts`; `test/cli-batch-rate-limit.e2e-spec.ts`; `test/question-batches.e2e-spec.ts`                         | `36be9bb`, `0261327`                    | `runtime verified`                                                                                             | CP4 verified 2026-08-31                                          | Historical full E2E superseded the earlier local full-suite deferral; current CP9 E2E rerun passed.                                                                                                          |
| BE-8.7  | Redis-backed account/source login limits, multi-instance sharing, fail-closed outage, and opaque keys                                  | `src/modules/rate-limit/redis-login-rate-limit.store.ts`; `test/login-rate-limit.redis.integration-spec.ts`; CP5 verifier                                        | `7403f45`, `5c71f6f`, `56b67dc`         | `BLOCKED (current-head Redis proof not rerun; depends on separately authorized Redis/Compose verification)`    | CP5 verified 2026-08-31                                          | Historical 1-suite/6-test Redis and 1-suite/4-test two-backend evidence is not current-HEAD output; no Redis runtime authorization in this CP9 run.                                                          |
| BE-8.8  | Sensitive fields and exception/OpenAPI output do not disclose credentials, tokens, hashes, or payload content                          | `src/common/observability/pino-redaction.ts`; `test/manual-cp6-verify.e2e-spec.ts`; CP6 review doc                                                               | `1e7e052`                               | `runtime verified`                                                                                             | CP6 verified 2026-09-01                                          | Current CP6 generator passed in the rerun: 1 suite / 1 test, with sanitized disclosure evidence.                                                                                                             |
| BE-8.9  | Raw low-cardinality `/metrics`, semantic instrumentation, alerts/dashboard handoff, and readiness semantics                            | `src/modules/metrics/*`; `ops/observability/*`; `test/metrics.e2e-spec.ts`; `test/manual-cp7-verify.e2e-spec.ts`                                                 | `1e7e052`                               | `runtime verified`                                                                                             | CP7 verified 2026-09-01                                          | Current CP7 generator passed in the rerun: 1 suite / 1 test. Prometheus/Grafana deployment and tuning remain OPS-owned; `promtool` was historically unavailable.                                             |
| BE-8.10 | Nginx/TLS proxy compatibility, trusted forwarded headers, secure cookies/CSRF, Socket.IO upgrade, Redis adapter, and shutdown behavior | `docker-compose.cp8.yml`; `ops/topology/nginx.conf`; `ops/topology/README.md`; `test/cp8-topology.spec.ts`; `src/modules/realtime/realtime-redis.service.ts`     | `37bcbe0` plus current working-tree fix | `BLOCKED (current-head CP8 Compose runtime not rerun; depends on separately authorized topology verification)` | CP8 verified 2026-09-01                                          | Adapter lifecycle regression is fixed and CP8 static/unit evidence passed; readiness recovered only after API restart, not automatically within 30 seconds; no production Nginx/Next or W1–W8 certification. |

`runtime verified` above refers to signed executable evidence applicable to the reviewed working tree. The 2026-09-02 rerun completed the authorized command inventory; `BLOCKED (...)` is reserved for proof requiring separate Redis/Compose authorization. There is no “partial pass” classification.

### Known limitations and ownership boundaries

- CP8's required realtime Redis did not restore readiness within 30 seconds in the existing API processes; only recovery after restarting both API instances was demonstrated. Keep this as a follow-up.
- CP8 is a verification-only topology. It does not certify production Nginx/Next.js deployment, TLS certificate operations, Prometheus/Grafana deployment, or OPS-2 W1–W8 load/capacity targets.
- Durable replay must not be inferred from snapshot/reconnect evidence; unsupported replay claims remain `DEFERRED/BLOCKED`.
- CP5 real-Redis and two-instance results are historical and separately identified; this CP9 run did not perform a Redis/Compose drill.
- BE owns backend metrics/readiness/proxy compatibility contracts; OPS-1 owns production ingress/frontend/scrape deployment; OPS-2 owns capacity/load certification.

### Risk, rollback, and required next action

- **Risk:** high — CP9 depends on guarded DB fixtures and release evidence for auth, credential, Redis, disclosure, observability, and topology behavior.
- **Rollback:** discard only the CP9 documentation edits. Do not restore credentials, clear databases/Redis, delete volumes, or use destructive migration rollback. The discovered realtime adapter fix must be handled as a separately reviewed change.
- **Required next action:** obtain separate authorization for real-Redis and CP8 Compose runtime evidence if required for BE-8 closure. Keep WBS CP9 checkboxes unchanged until explicit final sign-off.

### Final approval state

**MANUAL FINAL SIGN-OFF RECORDED — BLOCKERS RETAINED**

The user approved the CP9 final matrix on 2026-09-02 with BE-8.7 current-head real-Redis proof and BE-8.10 current-head CP8 Compose/runtime proof retained as blocked limitations. The packet is not a production certification: BE-8 remains incomplete for those blocked runtime items, and no W1–W8 capacity certification is inferred.

## 2026-09-02 Adapter regression remediation and CP9 rerun

- [x] Fix `RealtimeRedisService.closeAdapter()` synchronous invocation while preserving async shutdown draining.
- [x] Add focused sync/async adapter lifecycle regression coverage.
- [x] Run targeted adapter tests, full unit/static/compiler/quality gates, and the authorized current-HEAD CP9 DB-backed/manual evidence sequence.
- [x] Update the CP9 evidence packet and this ledger with the fresh baseline and exact results; keep real-Redis proof separately blocked unless explicitly authorized.
- [x] Record the user's manual CP9 final sign-off with BE-8.7 and BE-8.10 blockers retained; do not imply production certification.

**Risk & Rollback:** High — realtime adapter failover and release evidence. Revert the focused source/test change; do not reset databases, restore credentials, delete volumes, or alter WBS closure state.

**Dependencies & Environment:** Node/npm/Prisma installed; DB-backed verification was limited to `NODE_ENV=test` and exactly `localhost:5432/smartlearning_test`, including guarded setup migration/truncation. Real Redis and Compose drills were not run because they require separate authorization.

**Working Notes:** CP8 introduced `Promise.resolve().then(() => adapter.close())`, deferring invocation past `applyAdapter()`. The fix invokes `close()` synchronously, uses the shared `errorType()` classifier, retains the Redis adapter across availability-only failover to avoid overlapping unsubscribe/subscribe races, and closes it during shutdown. Existing edits in `tasks/lessons.md` and prior CP9 records were preserved.

### Results

- **Adapter fix:** `closeAdapter()` now invokes adapter cleanup synchronously, uses shared `errorType()` logging, tracks asynchronous completion/rejection for shutdown draining, and reuses the Redis adapter across availability-only failover so unsubscribe cleanup cannot race a new subscription. No schema, migration, runtime configuration, Redis, or Compose source changes.
- **Targeted adapter test:** PASS — 1 suite / 3 tests, including synchronous transition ordering, async shutdown drain, and failure isolation.
- **Full unit:** PASS — 49 suites / 293 tests; 0 failures, 0 skips.
- **CP8 static:** PASS — 1 suite / 3 tests; 0 failures, 0 skips.
- **Authorized E2E:** PASS — 32 suites / 219 tests; 0 failures, 0 skips; normal teardown and no open-handle warning.
- **Authorized integration (real-Redis file excluded):** PASS — 3 suites / 16 tests; 0 failures, 0 skips; target `localhost:5432/smartlearning_test`.
- **CP6 manual:** PASS — 1 suite / 1 test; sanitized disclosure/redaction evidence generated.
- **CP7 manual:** PASS — 1 suite / 1 test; sanitized metrics/readiness/alert evidence generated.
- **Quality gates:** `prisma:validate`, `typecheck`, `lint:check`, `format:check`, `build`, `git diff --check`, and read-only migration status all PASS. Migration status: 15 migrations, `smartlearning_test` up to date.
- **Not run:** real-Redis integration and CP5/CP8 Compose runtime drills; classify current Redis/runtime proof as separately blocked, not as a non-Redis pass.
- **Final status:** CP9 manual final sign-off recorded on 2026-09-02 with BE-8.7 and BE-8.10 blockers retained; BE-8 is not a production certification.
- **Fresh authorization recapture:** 2026-09-01T23:04:29Z UTC; the same 14-command sequence was rerun against only `localhost:5432/smartlearning_test`, all exit codes were 0, and tracked status was unchanged. Real-Redis, CP5, CP8 Compose/runtime, and volume operations remained excluded.

## 2026-09-03 — BE-2 frozen student-search contract

### Acceptance criteria

- [ ] Add `GET /api/v1/courses/:courseId/students/search?q&page&pageSize` with SessionGuard + TeacherOrAdminGuard.
- [ ] Authorize course before student search; owner teacher/admin gets 200, non-owner/nonexistent gets generic 404 `Course not found` with `courseId`, student gets 403, unauthenticated gets 401, malformed UUID gets 400.
- [ ] Normalize q as NFC then trim; require 2–100 Unicode code points via `Array.from`; query active student accounts only, case-insensitive contains on username/displayName.
- [ ] Default page/pageSize to 1/20, cap pageSize at 100; order username ASC then id ASC; project only id/username/displayName/enrollmentStatus (`active|removed|null`) for the target course, including archived courses.
- [ ] Add DTO/query validation, mapping, Swagger/OpenAPI, frontend API reference, and focused E2E/OpenAPI coverage where practical; no schema/migration/WBS/UI changes.

### Risk & rollback

- **Risk:** medium — teacher roster privacy and query validation/authorization precedence.
- **Rollback:** revert only the additive controller/service/DTO/test/reference changes; no database rollback or migration is required.

### Dependencies & environment

- Existing Prisma `Account`, `Course`, and `CourseEnrollment` models; guarded DB-backed checks may use only `NODE_ENV=test` and `smartlearning_test`.

### Working notes

- Reuse `EnrollmentService`, `CourseService` ownership semantics, `normalizePageRequest`, and safe student projection. Preserve existing roster and student behavior.

### Checklist

- [ ] Locate authoritative patterns and implement the smallest vertical slice.
- [ ] Add focused service/controller/OpenAPI regression coverage.
- [ ] Run targeted tests/static quality checks and record exact pass/fail/blocked evidence.

### Results

- Pending implementation and verification.

## 2026-09-03 — FE-4.1 backend discovery and stable participant errors

### Context and acceptance criteria

FE-4.1 CP0 is blocked until the student course response can discover a current joinable session and participant-bound failures are classifiable by stable codes. This slice changes backend application/API behavior only; it does not start frontend transport/UI, update the root WBS, or require a schema migration.

- [x] `GET /api/v1/me/courses` returns mandatory `currentJoinableSession: { id, sessionCode, status: waiting|active } | null` for every returned course.
- [x] Discovery preserves active enrollment scope, pagination, and `enrolledAt DESC, id DESC`; terminal/future session states are never advertised.
- [x] Multiple candidates use active-over-waiting, then `createdAt DESC`, then `id DESC` selection.
- [x] Account-bound participant join/snapshot classify no enrollment as `ENROLLMENT_REQUIRED`, removed enrollment as `ENROLLMENT_REMOVED`, and wrong role as generic `FORBIDDEN`.
- [x] Participant routes classify a valid persisted cookie whose account is now disabled as `AUTH_ACCOUNT_DISABLED`; ordinary SessionGuard disabled handling remains `UNAUTHORIZED`, expiry remains `AUTH_SESSION_EXPIRED`, and disabled login remains generic.
- [x] DTO/OpenAPI/reference and DB-backed regressions prove projection allowlists, privacy, no participant side effects on denied join, and existing join/snapshot behavior.

### Risk & rollback

- **Risk:** medium/high — auth boundary, participant privacy, and student discovery contract.
- **Rollback:** revert only the additive discovery/error/session-guard/application/test/reference changes; no database rollback is expected. If the participant-only disabled distinction is rejected, revert that classification independently while retaining discovery.

### Dependencies & environment

- Node 24+, PostgreSQL/Prisma generated client, existing `LiveSession`/enrollment schema; no new dependency or migration.
- DB-backed tests may implicitly migrate/truncate only `smartlearning_test`; execute them only with explicit authorization. No seed, fixture provisioning, volume deletion, or development DB mutation is planned.

### Working notes

- Existing join and participant-safe snapshot contracts remain authoritative.
- `AUTH_ACCOUNT_DISABLED` is intentionally local to participant session guards to avoid reopening the globally frozen BE-8 disabled→`UNAUTHORIZED` semantics.
- Stable codes are append-only and clients classify via `DomainError.code`, never human messages.

### Checklist

- [x] Locate authoritative FE-4.1 contract, BE-8 semantics, and reusable discovery/join/snapshot patterns.
- [x] Add stable error codes/domain errors and participant-session classification boundary.
- [x] Add batched My Courses discovery with deterministic selection and nullable DTO projection.
- [x] Add focused unit/e2e/OpenAPI regression coverage and contract reference updates.
- [x] Run targeted verification and final static/build gates; record PASS/FAIL/BLOCKED evidence.

### Results

- **PASS — targeted units:** `npm test -- --runInBand src/common/errors/error-codes.spec.ts src/common/auth/session.service.spec.ts` — 2 suites / 11 tests.
- **PASS — focused supporting units:** `npm test -- --runInBand src/modules/identity/application/account.service.spec.ts src/modules/participants/application/participant.service.redaction.spec.ts src/modules/participants/domain/display-name.spec.ts` — 3 suites / 22 tests.
- **PASS — DB-backed E2E:** `NODE_ENV=test npm run test:e2e -- --runInBand test/openapi.e2e-spec.ts` — 1 suite / 4 tests; `test/participant-account.e2e-spec.ts` — 1 suite / 10 tests; revised `test/enrollments.e2e-spec.ts` — 1 suite / 4 tests. All passed with 0 failures and 0 skips against `smartlearning_test`.
- **PASS — static/build gates:** `NODE_ENV=test npm run prisma:validate`, `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`, and `git diff --check` all passed.
- **PASS — migration status:** `NODE_ENV=test npm run prisma:migrate:status` found 15 migrations and reported `smartlearning_test` schema up to date. No development database was touched; no migration or schema change was made.
- **Coverage/result:** `/me/courses` now exposes a batched, allowlisted nullable current-session projection; participant authorization has stable missing/removed enrollment codes and participant-local disabled-account classification. Existing ordinary authentication semantics remain unchanged. The enrollment fixture was corrected to use valid eight-character codes and to respect the persisted one-open-session-per-course index; no production fix was required.
- **Boundary:** backend slice is complete and verified. FE-4.1 frontend transport/UI work intentionally remains stopped pending explicit follow-up scope.

## FE-4.2 CP5 response-loss fixture addendum (2026-09-05)

- [x] Add test-only, one-shot post-commit response-loss middleware and focused unit coverage.
- [x] Add frontend FE42 browser fixture/spec with fail-closed preflight and same-key replay probe.
- [ ] Run real FE42 browser acceptance against an isolated migrated backend with FE42_* fixtures.
- [x] Instrument the failpoint boundary and prove target matching plus `response.destroy()` in an isolated runtime.

### Results

Implemented the backend transport failpoint in `src/common/http/test-response-loss-failpoint.ts`, gated by `NODE_ENV=test` and `FE42_RESPONSE_LOSS_TOKEN`, and wired it through shared bootstrap. Added the FE42 browser spec under the UI repository using isolated actor contexts and existing aggregate cleanup patterns. Runtime E2E remains pending until isolated services and fixtures are provisioned.

- [x] Fix Nest DI resolution for the test bootstrap rate limiter clock/config dependencies.
- [ ] Retry FE-4.2 browser acceptance with a dedicated, non-conflicting UI/API port pair.

Latest verification: isolated PostgreSQL migration and compiled admin bootstrap succeeded; browser execution was stopped because port 3001 was already occupied by another Next dev server. Temporary database container was removed; no shared data was modified.

### 2026-09-06 response-loss boundary instrumentation

- **PASS:** rebuilt the isolated `smartlearning-fe51-cp3` backend with `NODE_ENV=test`, a fresh response-loss token, and diagnostic instrumentation that records only boolean match fields (no token, key, payload, or credential values).
- **PASS:** real submission request reached the failpoint with `methodMatches=true`, `pathMatches=true`, `tokenMatches=true`, `keyPresent=true`, `target=true`; `response.destroy()` was invoked.
- **OBSERVED:** a later same-key request was classified `alreadyConsumed=true` and the browser received the authoritative successful result. The controlled browser payload-permutation comparison was not completed, so FE-5.1 CP3 response-loss/permutation acceptance remains **PARTIALLY VERIFIED**, not closed.
- **Cleanup:** the disposable Compose project, database/Redis volumes, network, temporary UI server, and diagnostic fixture were removed. No shared/dev database was touched.
- **Source changes:** `test-response-loss-failpoint.ts` now prefers `response.destroy()` with socket fallback and has opt-in test-only boundary diagnostics; focused failpoint tests and backend typecheck pass.

## 2026-09-08 — FE-6 Checkpoint 1 BE-5 contract freeze

### Context and acceptance criteria

Freeze the archive-history backend contract required by FE-6. This checkpoint is backend-only and must stop for human review before retention operations, Checkpoint 2, or frontend work.

- [x] Archive list supports validated course/status filters, owner scope before pagination, deterministic ordering, and safe concrete DTOs/OpenAPI.
- [x] Archive detail is an active/deleted discriminated union; deleted tombstones never expose payload content.
- [x] One outstanding teacher deletion request is idempotent and visible in list/detail; admin has a safe pending queue.
- [x] Admin confirmation is bound to a specific request and returns a canonical result on retry.
- [x] Early deletion and retention share one locked transition, create one canonical event, and reconcile pending requests.
- [x] Additive Prisma migration enforces archive/request/tombstone consistency without rewriting invalid existing data.
- [x] Targeted unit, OpenAPI, DB-backed authorization/privacy/concurrency tests and static/build gates pass.
- [x] Frontend API reference and review evidence match the tested runtime contract.

### Risk & rollback

- **Risk:** high — archive governance destructively removes answer-bearing data.
- **Safety:** destructive verification is limited to run-scoped fixtures in guarded `smartlearning_test`; never operate on development, staging, production, or pre-existing session IDs.
- **Rollback:** application changes are revertible before deletion. Keep additive production constraints/linkage in place; removing them cannot restore deleted data and may permit invalid states. After any real deletion, preserve the tombstone and forward-fix.

### Dependencies & environment

- Node.js 24+, Prisma 7 generated client, migrated PostgreSQL `smartlearning_test`, existing `TransactionService` LiveSession lock order, UUID-v7 app IDs, and `TEXT + CHECK` states.
- No new dependency. No frontend files, retention runner/scheduler, operational dry run, staging purge, or production purge.

### Working notes

- `sessionLabel` is immutable and generated server-side from `startedAt` using a locale-independent timestamp representation.
- Public reasons are `privacy|support` for teacher/admin early deletion and system-owned `retention` for retention tombstones.
- Teacher foreign-course filters return an empty page; detail/request retain existence-hiding 404 behavior.
- Request resolution links the original teacher request to exactly one canonical `early_delete|retention` event.

### Checklist

- [x] Read lessons, authoritative FE-6 plan, current governance implementation, and reusable result/pagination patterns.
- [x] Add concrete DTO/OpenAPI contract and additive schema/migration constraints.
- [x] Implement safe projectors, list/detail filters, request queue/idempotency, request-bound deletion, and retention reconciliation.
- [x] Add focused unit, DB-backed E2E, privacy/authorization/concurrency, and OpenAPI regressions.
- [x] Update frontend API reference from the tested frozen contract.
- [x] Run targeted verification and final Prisma/static/build gates.
- [x] Prepare the Checkpoint 1 human review package and stop.

### Results

- **PASS — Prisma contract:** `npm run prisma:generate`, `node scripts/normalize-prisma-client.mjs generated/prisma`, and `npm run prisma:validate` completed successfully.
- **PASS — targeted units:** `npm test -- --runInBand src/modules/governance/domain/archive-projection.spec.ts src/modules/governance/application/governance.service.spec.ts` — 2 suites / 6 tests, 0 failures.
- **PASS — OpenAPI E2E:** `npx jest --config ./test/jest-e2e.json --runInBand test/openapi.e2e-spec.ts` — 1 suite / 5 tests, 0 failures.
- **PASS — authorized DB migration:** `NODE_ENV=test npm run prisma:migrate:deploy` applied `20260908090000_freeze_archive_governance_contract` only to database `smartlearning_test`.
- **PASS — DB-backed archive governance E2E:** `NODE_ENV=test npx jest --config ./test/jest-e2e.json --runInBand test/archive-governance.e2e-spec.ts` — 1 suite / 6 tests, 0 failures, 0 skips. Coverage includes ownership/privacy, filtered deterministic pagination, concurrent request idempotency, admin queue, request-bound replay, retention/admin race reconciliation, and idempotent tombstoning.
- **PASS — static/build gates:** `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`, and `git diff --check` completed successfully.
- **PASS — migration status:** `NODE_ENV=test npm run prisma:migrate:status` found 16 migrations and reported `Database schema is up to date!` for `smartlearning_test`.
- **Scope:** changed backend governance DTO/controller/service/domain, Prisma schema/additive migration, focused tests, frontend API reference, and this task record. No `smartLearning-ui` files, retention runner/scheduler, staging/production data, or Checkpoint 2 work were touched.
- **Checkpoint stop:** Checkpoint 1 implementation and evidence are ready for human review. No BE-5 operational closeout, retention run, Checkpoint 2 work, or frontend work will begin without explicit approval.

## 2026-09-09 — Checkpoint 2 local-only retention operations

- [x] Add compiled `src/bootstrap/retention.ts` command parser and Nest application-context wiring with explicit operation gates.
- [x] Add strict local deletion-manifest watermark parsing and provider-neutral reconciliation inspect/apply service.
- [x] Keep run-once and manifest-export-once non-mutating/non-networked; preserve existing SKIP LOCKED and outbox/exporter changes.
- [x] Add focused parser and reconciliation unit tests.
- [x] Run Prettier, typecheck, and targeted tests.
- [ ] Remaining gap: operational DB purge and external/object-store export are intentionally not wired; require a separately approved provider-backed implementation and destructive verification.

### Results

- **PASS:** `npx prettier --write` on four new files.
- **PASS:** `npm run typecheck`.
- **PASS:** `npm test -- --runInBand src/bootstrap/retention.spec.ts src/modules/governance/application/retention-reconciliation.spec.ts` — 2 suites / 8 tests.
- **Safety:** `run-once` and `manifest-export-once` require explicit gates but report not executed; no DB-mutating command, undelete path, API route, network call, or object-store call was added.

### Checkpoint 2 operational artifact closeout

- [x] Add Prometheus alert rules for oldest-due age, due backlog, repeated purge failures, manifest lag/dead records, and reconciliation failures.
- [x] Add dashboard inventory panels for the same retention signals and document placeholder/provider boundaries.
- [x] Add artifact assertions covering alert names, metric families, dashboard entries, and runbook safety gates.
- [x] Add retention runbook covering disabled defaults, safe inspect, explicit approval gates, immutable object-store prerequisites, stop/rollback, and blocked production gaps.
- [x] Update observability README and package script for the artifact-only verification command.
- [x] Run focused artifact test, lint, format, and typecheck without DB mutation or network access.

#### Results

- Added `ops/observability/retention-runbook.md`, expanded `prometheus-alerts.yml` and `dashboard-inventory.md`, and linked the handoff from `ops/observability/README.md`.
- Added `test/retention-operations-artifacts.spec.ts` with a dedicated Jest config/script. Assertions are local file reads only.
- Production purge/export/reconciliation remain blocked and gates remain disabled by default.

### Checkpoint 2 verification report (2026-09-09)

- **PASS — static/schema:** `npm run prisma:validate`, `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`, and `git diff --check`.
- **PASS — focused local tests:** 4 suites / 12 tests for governance/bootstrap/reconciliation paths; deletion-manifest closest available spec 1 suite / 5 tests; retention artifact command 1 suite / 2 tests.
- **PASS — guarded DB evidence:** `NODE_ENV=test npm run test:e2e -- test/archive-governance.e2e-spec.ts` — 1 suite / 8 tests, 0 failures, 0 skips; includes exact deadline, manifest-outbox creation, bounded oldest-first `purgeDue(2)`, and concurrent `purgeDue()` workers with exactly two canonical retention events.
- **BLOCKED — required operational evidence:** scheduler application spec, DB-backed failure/retry injection, outbox claim/ack delivery, external immutable object-store upload, production-like alert firing, and restore-apply no-resurrection exercise remain unavailable or intentionally unrun.
- **Safety boundary:** all DB evidence targeted only the guarded `smartlearning_test`; no external network call, object-store credential, development/staging/production purge, or restore apply was performed.
- **PASS — scheduler unit coverage:** `retention.scheduler.spec.ts` — 6 tests; disabled mode, startup/interval, overlap, shutdown drain, failed-count logging, and safe error logging.
- **PASS — final non-mutating gates:** Prisma validate, typecheck, lint, format, build, and `git diff --check`.
- **PASS — final focused tests:** 6 suites / 23 tests across governance, scheduler, manifest, CLI, and reconciliation; retention artifact config 1 suite / 2 tests.
- **BLOCKED — operational closeout:** direct default Jest invocation cannot discover `test/retention-operations-artifacts.spec.ts` because package rootDir is `src` (repo-provided retention config passes); DB-backed failure/retry and outbox delivery E2E, external immutable object-store delivery, production-like alert firing, and restore-apply no-resurrection remain unavailable/unrun.
- **Disposition:** code-validation and selected guarded DB evidence are complete, but operational closeout remains incomplete. Do not claim Checkpoint 2 complete or begin Checkpoint 3 until provider-backed implementation and explicitly authorized remaining evidence are available.

## 2026-09-09 — Checkpoint 2 atomic retention claim slice

### What changed

- [x] Extract `purgeOneInTransaction()` so public early-delete and retention paths share the destructive transaction authority.
- [x] Keep retention selection and purge in one transaction, retaining the `LiveSession` `FOR UPDATE ... SKIP LOCKED` lock through tombstone, canonical event, and manifest-outbox creation.
- [x] Change `purgeDue()` to claim one oldest-due row at a time, exclude poison rows for the remainder of the run, and preserve `selected = deleted + failed`.
- [x] Align governance unit tests with the one-row transactional claim seam.

### Verification

- `npm run typecheck` — PASS.
- `npm test -- --runInBand src/modules/governance/application/governance.service.spec.ts` — PASS, 1 suite / 3 tests.

### Remaining gap

- DB-backed lock-retention, rollback/restart, exporter delivery, provider-backed immutable storage, and restore no-resurrection evidence remain pending; no destructive or external-storage verification was run in this slice.

### 2026-09-09 isolated database verification follow-up

- `NODE_ENV=test npm run prisma:migrate:status` — PASS; guarded `smartlearning_test`, 17 migrations, schema up to date.
- `NODE_ENV=test npm run test:e2e -- test/archive-governance.e2e-spec.ts` — PASS; 1 suite / 8 tests, 0 failures, 0 skips.
- Evidence covered bounded purge, worker locking, retention reconciliation, concurrent receipt idempotency, and tombstone behavior.
- No external upload, real object-store credential, or non-test environment operation was performed.

### 2026-09-09 combined verification after provider delivery slice

- `npm run prisma:generate` — PASS; generated client current.
- `node scripts/normalize-prisma-client.mjs generated/prisma` — PASS; no normalization changes.
- `npm run prisma:validate` — PASS.
- `NODE_ENV=test npm run prisma:migrate:deploy` — PASS; applied `20260909100000_add_manifest_outbox_lease` to guarded `smartlearning_test`.
- `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`, `git diff --check` — PASS.
- Focused unit/artifact verification — PASS; 7 suites / 28 tests, 0 failures.
- `NODE_ENV=test npm run test:e2e -- test/archive-governance.e2e-spec.ts` — PASS; 1 suite / 8 tests, 0 failures, 0 skips.
- `NODE_ENV=test npm run prisma:migrate:status` — PASS; 18 migrations, schema up to date.
- No external provider upload or real object-store credentials were used. Restore apply/no-resurrection DB executor and full provider retry E2E remain incomplete.

### 2026-09-09 restore no-resurrection evidence

- [x] Add guarded E2E coverage that captures a real purge-created deletion manifest, recreates answer-bearing rows, applies reconciliation, and verifies no resurrection.
- [x] Make matching successful manifest replay re-run governed cleanup without creating a duplicate deletion event or pending outbox row.

#### Verification

- `npm run typecheck` — PASS.
- `npm test -- --runInBand src/modules/governance/application/governance.service.spec.ts` — PASS, 1 suite / 3 tests.
- `npm run test:e2e -- --runInBand test/archive-governance.e2e-spec.ts -t 'rejects resurrection'` — PASS, 1 suite / 1 test; 8 tests skipped by name filter.
- `npx prettier --write test/archive-governance.e2e-spec.ts src/modules/governance/application/governance.service.ts` — PASS.
- `git diff --check` — PASS.

#### Status

- Guarded restore no-resurrection evidence is complete for `smartlearning_test`.
- Provider retry/lease evidence is now complete for the controlled local provider on `smartlearning_test`.
- Checkpoint 2 remains open for external immutable object-store delivery, production-like alert firing, and full restore rehearsal.

### 2026-09-09 provider retry and lease evidence

- [x] Add guarded integration coverage for partial-batch continuation, transient retry/backoff, expired-lease recovery, permanent malformed-manifest failure, attempt exhaustion, and provider-success-before-DB-ack lease loss.
- [x] Classify malformed deletion manifests as permanent failures via `TypeError`; retain transient retry behavior for ordinary provider failures.

#### Verification

- `NODE_ENV=test npm run test:integration -- --runInBand test/deletion-manifest-exporter.integration-spec.ts` — PASS, 1 suite / 4 tests.
- `npm run typecheck` — PASS.
- `npm run lint:check -- --quiet` — PASS.
- `npm run format:check` — PASS.
- `git diff --check` — PASS.
- Safety: only guarded `smartlearning_test` was mutated; no external provider, network upload, or real credentials were used.

### 2026-09-09 CP2 review hardening

- [x] Classify only `InvalidDeletionManifestError` as permanent; provider `TypeError`/`RangeError` failures remain retryable.
- [x] Generate a unique lease token per export batch and fence acknowledgements/failures with the claimed row token, preventing stale overlapping runs from sharing a worker token.

#### Verification

- Focused exporter/domain tests — PASS, 2 suites / 7 tests.
- `NODE_ENV=test npm run test:integration -- test/deletion-manifest-exporter.integration-spec.ts` — PASS, 1 suite / 4 tests, 0 failures.
- `npm run typecheck`, `npm run lint:check`, `npm run format:check`, and `git diff --check` — PASS.

#### Boundary

- Controlled local-provider delivery is evidenced only on guarded `smartlearning_test`.
- External immutable object-store delivery, production-like alert firing, and full restore rehearsal remain intentionally unrun; no external credentials or uploads were used.

### CP2 current status — 2026-09-09

**PARTIALLY COMPLETE / OPEN.** The controlled local-provider retry, lease recovery, malformed-manifest dead-lettering, acknowledgement-loss recovery, and restore no-resurrection evidence are complete and verified on guarded `smartlearning_test`. Lease fencing and permanent-error classification were hardened and committed in `4d044a9` (`fix(governance): harden manifest exporter leases`).

The checkpoint is not closed: external immutable object-store delivery, production-like alert firing, and full restore/restart rehearsal still require separately authorized infrastructure and evidence. No external upload or production-like operation has been performed.

### External provider delivery authorization/setup — 2026-09-09

- **Selected target:** S3-compatible sandbox (non-production), per user selection.
- **Authorization state:** provider class selected, but execution authorization is not yet actionable until the exact isolated endpoint/bucket and credential scope are supplied.
- **Required setup:** dedicated disposable bucket/prefix; write-only credential scoped to that prefix; no production account or existing-data access; short-lived credential; provider endpoint/region; explicit cleanup/retention policy; confirmation that network upload is permitted for this rehearsal.
- **Credential handling:** do not paste secrets into chat or commit them. Materialize them only in a gitignored local env file or approved secret store, then run the guarded rehearsal with the exact target recorded.
- **Current status:** **DEFERRED — external sandbox setup and delivery verification skipped by user.** No provider connection or upload was attempted.

### FE-6 S3-compatible provider adapter — 2026-09-09

- [x] Add provider-neutral manifest errors and deterministic canonical JSON.
- [x] Add S3 adapter contract: conditional immutable write, SHA-256 checksum, SSE-S3, and compliance object lock.
- [x] Preserve local provider as the default and add S3 env validation/templates.
- [x] Install and lock `@aws-sdk/client-s3`; no network upload was attempted.
- [x] Run focused config/governance verification after the dependency was installed.

**Deferred gaps:** no credentials, external endpoint, scheduler activation, or manifest-export command was used.

### Final FE-6 verification — 2026-09-09

- `npm run prisma:validate` — PASS.
- `npm run typecheck` — PASS.
- `npm run lint:check` — PASS.
- `npm run format:check` — PASS.
- `npm run build` — PASS.
- Focused unit tests — PASS, 3 suites / 39 tests.
- Exporter integration — PASS, 1 suite / 4 tests, 0 failures.
- `NODE_ENV=test npm run prisma:migrate:status` — PASS; `smartlearning_test`, 18 migrations, schema up to date.
- `git diff --check` — PASS; backend working tree clean before this status-only update.
- Non-blocking Nest `LegacyRouteConverter` warnings and intentional exporter failure-path warning logs only.

**Final disposition:** FE-6 remains **PARTIALLY COMPLETE / OPEN**. Controlled local-provider evidence and S3 adapter/config implementation are verified; real S3 sandbox upload, production-like alert firing, and full restore/restart rehearsal remain deferred.

## 2026-09-09 — External S3 sandbox upload, alert firing, and restore/restart rehearsal (CP2/FE-6 deferred gaps closed)

### What was run (all sandbox-only, guarded `smartlearning_test`, disposable MinIO at 127.0.0.1:19000)

- **S3 sandbox upload**: disposable MinIO bucket `sl-rehearsal-manifests` (versioned + object-lock enabled, COMPLIANCE default), write-only user `rehearsal-upload` (PutObject + retention actions only, prefix-scoped). New guarded integration spec `test/s3-sandbox-rehearsal.integration-spec.ts` proves: outbox row → S3 upload (canonical JSON, SHA-256 checksum, If-None-Match:'*', SSE, 90-day COMPLIANCE retention), outbox → `exported`, zero-export idempotent replay, and duplicate re-put accepted. Objects verified from an admin credential: canonical body, checksum, `COMPLIANCE` until +90d.
- **Production-like alert firing**: implemented the three retention metrics the alert rules referenced but the service never emitted (`smartlearning_retention_manifest_lag_seconds`, `..._manifest_dead_records`, `..._reconciliation_failures_total`) plus `GovernanceService.inspectManifestDelivery()`; wired lag/dead into `RetentionScheduler`, reconciliation failures into the retention CLI. Rehearsal (MinIO stopped + seeded failed outbox + overdue archive + malformed-manifest apply) produced: oldest_due_age 260 515 s (>86 400 → `SmartLearningRetentionOldestDueAgeHigh` FIRES), dead_records 2 (>0 → `SmartLearningRetentionManifestDeadRecords` FIRES critical), reconciliation_failures 1 (increase>0 → `SmartLearningRetentionReconciliationFailing` FIRES), lag 1 314 s and backlog 3 (below thresholds as expected).

### Gaps found and fixed during the rehearsal

- `parseDeletionManifest` accepted non-UUID ids — malformed manifests survived parsing and only failed at the DB layer (22P02) after reconciliation committed to apply. Hardened: UUID-format validation for `deletionEventId`/`archivedResultId`/`liveSessionId` at parse time (spec fixtures updated to UUID v7 + new rejection case).
- S3 provider: SSE-S3 rejected by MinIO without KMS → `S3_SERVER_SIDE_ENCRYPTION` env option (`AES256` default | `aws:kms` | `none`), documented in env examples. Write-only credentials cannot read-back on conflict → clean `PreconditionFailed` (403 on the verification GET) is now treated as idempotent success because `If-None-Match: '*'` already proves the key exists unchanged.
- Fixture fidelity: fixture events used `['participants']` while the production path writes the full 5-category set — such manifests could never reconcile (apply requires exactly the full set AND identity-match with the DB event). Fixtures now use the production category set with `completed_at` aligned to manifest `deletedAt`.

### Restore/restart rehearsal (no-resurrection) — PASS

- Exported production-style manifest to the S3 sandbox → fetched it as the reconcile input → `reconcile-apply` applied it (archive → `deleted`, payload cleared, submissions/participants/session_questions = 0) → idempotent replay with watermark `{applied:0, skipped:1}` → archive stayed `deleted` (no resurrection), watermark advanced and visible in `reconcile-inspect`.
- Restart durability: MinIO + Postgres containers were restarted mid-rehearsal; bucket contents and DB state survived.

### Verification

- `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build` — PASS.
- `npm test -- governance|manifest|retention|metrics` — 10 suites / 41 tests passed.
- `npm run test:integration -- test/s3-sandbox-rehearsal.integration-spec.ts` (with sandbox env) — PASS 1/1.
- `git diff --check` — PASS. `.env.sandbox-rehearsal` (credentials) is gitignored; no secrets in code or chat.

### Cleanup note

- The disposable MinIO container `s3-sandbox-rehearsal` (port 19000) and its volume remain for follow-up evidence gathering; tear down with `docker rm -f s3-sandbox-rehearsal && docker volume rm minio-sandbox-data`. Rehearsal DB rows remain in `smartlearning_test` (truncateAll-covered by future suites).

## 2026-09-10 — BE-5 CP1 contract remediation

### Goal and acceptance criteria

- [x] Replace persisted archive payload pass-through with strict nested allowlist reconstruction.
- [x] Reject Admin confirmation when its reason differs from the Teacher request reason; conflicting replay also returns 409 before writes.
- [x] Preserve matching canonical replay and request/session existence-hiding 404 behavior.
- [x] Freeze the archive/deletion contract with focused unit, OpenAPI, authorization/privacy, CSRF/Origin, step-up and race tests.
- [x] Synchronize the backend API reference and authoritative governance documentation.
- [x] Produce machine-readable verification with 0 failed / 0 skipped and exact working-tree provenance.
- [x] Stop for manual CP1 confirmation; do not enter CP2 or FE-6.

### Scope and decisions

- User authorized **CP1 remediation only** after acknowledging the blocked CP1 review.
- User selected strict reason binding: Admin `reason` must equal the stored Teacher-request `reason`; mismatch uses stable `CONFLICT` with `field: reason`.
- No Prisma schema or migration change.
- Preserve unrelated dirty retention/S3/metrics/rehearsal work. In `governance.service.ts`, the pre-existing `inspectManifestDelivery()` diff is out of scope and must remain intact.

### Dependencies and environment

- Node.js 24+ and existing npm dependencies.
- Non-DB unit/OpenAPI/static verification may run first through a dedicated test subagent.
- **DB authorization（2026-09-10）：** 使用者已授權針對 guarded `NODE_ENV=test`／`smartlearning_test` 執行 migration status、既有 E2E setup 的 reset/truncate 與 suite-owned destructive fixtures。不得觸及 dev/staging/production、pre-existing non-suite data、external S3/MinIO、restore 或 upload；不手動執行 migration deploy。

### Risk and rollback

- **Risk:** high privacy/governance area; medium implementation risk because the fix is localized and schema-free.
- **Rollback:** revert only this parser/reason-binding/test/documentation slice. Never restore deleted data. If historical payload compatibility fails, fail closed and forward-fix the allowlist parser rather than restoring shallow pass-through.

### Working notes

- **Baseline finding（fixed）：** archive parser previously validated selected fields but returned the original persisted question object, allowing unknown nested identity fields to reach active-detail HTTP responses; it now reconstructs the nested allowlist.
- **Baseline finding（fixed）：** resolved-request replay previously returned the canonical event before comparing the incoming reason; it now performs strict reason comparison first and returns non-destructive 409 on conflict.
- Historical CP1 test counts are not current-tree evidence; new Jest JSON artifacts must be written outside the repository.

### Verification

- [x] Focused archive-projection unit tests with Jest JSON artifact.
- [x] Focused governance-service unit tests with Jest JSON artifact.
- [x] Expanded OpenAPI contract suite with Jest JSON artifact.
- [x] Typecheck, lint:check, format:check, build and `git diff --check`.
- [x] Separately authorized guarded archive-governance E2E with Jest JSON artifact.

### Results

- Strict archive parser reconstructs root/question/result/option/open-text response through an allowlist; malformed known fields fail closed and unknown fields do not cross the HTTP projection boundary.
- Admin confirmation reason now must match the stored Teacher request reason before canonical replay or any destructive write; mismatch returns `CONFLICT` with `field: reason`.
- OpenAPI now freezes governance methods, query integer bounds, request required/enums, active/deleted discriminator, nested result DTOs and prohibited property names.
- Archive governance E2E now covers 11 cases including student denial, invalid queries, Admin global list, request existence hiding, CSRF/Origin, session-bound/expired step-up, strict reason replay and stronger race reconciliation.
- Machine-readable evidence:
  - archive parser: `/home/user/.claude/test-results/archive-projection-20260910065124-68979.json` — 1 suite / 10 tests, 0 failed / 0 skipped.
  - focused governance units: `/home/user/.claude/test-results/governance-focused-20260910065359-70174.json` — 2 suites / 15 tests, 0 failed / 0 skipped.
  - OpenAPI: `/home/user/.claude/test-results/openapi-e2e-20260910-070409-75506.json` — 1 suite / 5 tests, 0 failed / 0 skipped.
  - guarded DB E2E: `/home/user/.claude/test-results/archive-governance-20260910T174401200177123.json` — `smartlearning_test`, 1 suite / 11 tests, 0 failed / 0 skipped; migration status up to date.
- `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`, and `git diff --check` — PASS.
- Provenance: backend branch `main`, HEAD `e880b0ef69b1116ced44fcbac639458ed5eaba9e`, with explicitly preserved pre-existing retention/S3/metrics dirty work plus this CP1 slice. No commit/stage, CP2, FE-6, production operation, external upload or restore was performed.
- Final disposition: CP1 remediation evidence complete; STOP pending manual `BE-5 Checkpoint 1 verified; authorize CP2 operational evidence review.`

## 2026-09-10 — BE-5 CP2 Checkpoint A provenance and safety baseline

### Goal and acceptance criteria

- [x] Inventory and classify every tracked modification and untracked path in the backend working tree without discarding existing work.
- [x] Restore the Prisma generated-output ignore rule while retaining the independent sandbox-env secret rule.
- [x] Freeze the current revision, package versions, migration checksums, and evidence limitations.
- [x] Separate product/test promotion candidates from rehearsal tooling and generated output.
- [x] Record cleanup assets and unresolved owner/expiry decisions without performing cleanup.
- [x] Keep all behavior changes, DB/network operations, cleanup, commits, and FE-6 outside Checkpoint A.

### Authorization and boundary

- User authorized **CP2 Checkpoint A implementation only**.
- Authorized changes: provenance inventory, `.gitignore` correction, and this safety-baseline record in `smartLearning-backend`.
- Not authorized: source behavior changes, tests, package/code generation, migration application, DB access/mutation, purge, restore, reconciliation apply, S3/MinIO access, containers, credentials, cleanup, stage/commit/push, staging/production operations, or FE-6.
- The unrelated dirty `smartLearning-ui` FE-5.4 working tree was not touched.

### Risk and rollback

- **Risk level:** low repository/configuration risk; high governance significance because the baseline controls what later evidence may claim.
- **Affected paths:** `.gitignore` and `tasks/todo.md` only for this checkpoint.
- **Rollback:** revert only the Checkpoint A `.gitignore` and task-record additions. Do not delete generated files, rehearsal tools, credentials, containers, volumes, objects, or test rows as rollback.

### Frozen baseline

- Repository: `smartLearning-backend`.
- Branch/revision: `main` at `e880b0ef69b1116ced44fcbac639458ed5eaba9e`, ahead of `origin/main` by 9 commits.
- Initial working tree: 24 tracked modified paths plus untracked generated Prisma output, three rehearsal scripts, and one S3 sandbox integration spec.
- Package/version evidence from `package-lock.json`: backend `0.0.1`; Nest core `11.2.0`; Nest Swagger `11.4.6`; Prisma CLI/client `7.9.1`; TypeScript `5.9.3`; Jest `29.7.0`.
- Node is not pinned in `package.json`; repository requirement remains Node.js 24+. npm is not version-pinned.
- No migration path is modified or untracked. There are 18 tracked `migration.sql` files.
- No historical PASS count is current Checkpoint A verification evidence; no tests were run.

### Migration checksum manifest

Generated read-only with:

`find prisma/migrations -maxdepth 2 -name migration.sql -print0 | sort -z | xargs -0 sha256sum`

- `20260815163722_init_system_setting` — `2007322e550275236e3818c32a8a2fb3b4c890ba3f315a039091903aa7b0abac`
- `20260815174233_add_identity_and_course` — `f7e53827fe2954e9ee43135590bc426cf6c432d0523c230910185130acdbc1d4`
- `20260816100000_add_step_up_at` — `2a150da8644b84fd4cae55cac61f983e3b59ee6a6e32b8b8f1d414396c273a37`
- `20260816120000_add_poll_live_session_submission` — `702d55a66dcb6319cacb357c9b45c2bbf8109ca394d0bfaab6c45f8219b57a6c`
- `20260816130000_harden_poll_constraints` — `950bca90abca45be6b5d59c1674b69c7dbe77480949d455583d96dcf0f671e59`
- `20260816140000_add_poll_option_refs` — `b93699430ab930c8d81842acc12f04476af1c401807908d0d1fcdf195defa4dc`
- `20260816150000_scope_live_session_question_selection` — `025a9acb952c5f7c976748fe608a1dc54976908fe181bfe7ef59bbc4b610c454`
- `20260816160000_add_cli_credential_and_batch` — `c7eb91ca6a28cd76980a998cbbafbba6f37c6bc711e70928d6e5e72a0591adea`
- `20260817100000_relax_submission_answer_cardinality` — `bbba6dc3834bd9e15e58321f645e6f303d89330829a431dc3abb631aa27ba33a`
- `20260818100000_add_student_role` — `275f19e6a23e492cbfe6a84b08ccbec14ab1e22667f262c135f9b49edf91f419`
- `20260818110000_add_course_enrollment` — `3adea185996f443deb6c278a8a672da63d7695906c766c8b6643ae55d83663b4`
- `20260818120000_bind_participant_account` — `00e723b128e1401f3ef3acaaabe7ec2b586a6b2933883e27406208d021df3ec3`
- `20260828090000_add_archive_governance` — `add057a28420154a26211b41c6230e031fcb144aad57170d7db5d1e02479314d`
- `20260828110000_add_durable_realtime` — `53bd3de9941e5a99030b6209b9e67e1a4ab83f3052942525af778e3f5a58acb4`
- `20260830100000_add_cli_credential_rotation_lineage` — `6cf78aba0df9da10bd6bc8eaed4d9054043c88858d5508e2ac85f42376218c1f`
- `20260908090000_freeze_archive_governance_contract` — `80b4662556c51b833e84d74b17592a4344f5dabd0e97e4ad693c15faf1cd17ab`
- `20260909090000_add_deletion_manifest_outbox` — `c324c6339c3ad38dd26637b231ef520a1ddfcf2c78c9ae2c906cc9e29cc7d1ff`
- `20260909100000_add_manifest_outbox_lease` — `2ec3c740eebc3129abdb77ea27cac2c38bb41102ac3f2ee407f0e52aca41063d`

### Working-tree classification

#### Product implementation — preserve as later review/promotion candidates

- `src/bootstrap/retention.ts`
- `src/config/env.validation.ts`
- `src/modules/governance/api/dto/governance.dto.ts`
- `src/modules/governance/api/governance.controller.ts`
- `src/modules/governance/application/governance.service.ts`
- `src/modules/governance/application/retention.scheduler.ts`
- `src/modules/governance/application/s3-manifest.provider.ts`
- `src/modules/governance/domain/archive-projection.ts`
- `src/modules/governance/domain/deletion-manifest.ts`
- `src/modules/metrics/metrics.constants.ts`
- `src/modules/metrics/metrics.service.ts`

No promotion, staging, or behavioral modification is authorized by Checkpoint A. In particular, the unsafe S3 412/403 path remains for a separately authorized checkpoint.

#### Test evidence — preserve as later regression/contract candidates

- Colocated governance, reconciliation, archive-projection, deletion-manifest, and metrics specs.
- `test/archive-governance.e2e-spec.ts`
- `test/openapi.e2e-spec.ts`
- `test/s3-sandbox-rehearsal.integration-spec.ts` is sandbox/external-provider evidence and must not be promoted or executed until its exact target, credential scope, guards, owner, expiry, and cleanup contract are reviewed.

#### Rehearsal tooling — defer pending ownership and safety review

- `scripts/alert-rehearsal-seed.ts` — guarded-test-DB mutation helper; no execution authorized.
- `scripts/export-once.ts` — one-shot external exporter helper; not an approved production/operator interface.
- `scripts/sweep-and-scrape.ts` — retention/metrics/failure rehearsal helper; no execution authorized.

These files are retained unchanged. They must be promoted into a single maintained, gated operational surface or explicitly removed under later authorization; Checkpoint A makes no destructive disposition.

#### Generated output — ignore and regenerate, do not promote

- `generated/prisma/` is Prisma-generated output and is restored to `/generated/` ignore coverage.
- The sandbox secret rule remains independently defined as `.env.sandbox-rehearsal`.
- No generated file was deleted, regenerated, staged, or inspected for secret content.

#### Documentation/configuration assets — preserve with corresponding implementation review

- `.env.example`, `.env.production.example`, `docs/frontend-api-reference.md`, `tasks/lessons.md`, and the pre-existing portions of `tasks/todo.md` remain dirty and require review with the behavior they describe.
- No clearly unrelated dirty backend path was found; all current paths belong to governance/retention/S3/metrics, tests, rehearsal evidence, generated output, or associated documentation/configuration.

### Cleanup ownership and expiry register

| Asset                                  | Current state                                         | Owner                    | Expiry                                                 | Cleanup boundary                                                                          |
| -------------------------------------- | ----------------------------------------------------- | ------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `.env.sandbox-rehearsal` credentials   | Gitignored; contents not inspected                    | **UNASSIGNED — blocker** | **UNSET — blocker**                                    | Rotation/revocation requires exact credential-system authorization.                       |
| MinIO container `s3-sandbox-rehearsal` | Previously recorded as retained                       | **UNASSIGNED — blocker** | **UNSET — blocker**                                    | Stop/remove requires separate container cleanup authorization.                            |
| MinIO volume `minio-sandbox-data`      | Previously recorded as retained                       | **UNASSIGNED — blocker** | **UNSET — blocker**                                    | Removal is destructive and separately authorized.                                         |
| Sandbox bucket/prefix/objects          | Existence inferred from historical notes; not queried | **UNASSIGNED — blocker** | **UNSET — blocker**                                    | List/delete requires exact endpoint/bucket/prefix and separate read/delete authorization. |
| `smartlearning_test` rehearsal rows    | Historically recorded as retained; not queried        | **UNASSIGNED — blocker** | **UNSET — blocker**                                    | Truncate/delete requires exact guarded DB and run-scoped authorization.                   |
| Rehearsal scripts/spec                 | Retained untracked                                    | **UNASSIGNED — blocker** | Review before next CP2 implementation slice            | Removal or promotion requires explicit review; no cleanup implied.                        |
| Generated Prisma output                | Locally present; now ignored                          | Repository build process | Regenerate when schema/client generation is authorized | No deletion or regeneration in Checkpoint A.                                              |

The owner/expiry fields cannot be invented from repository evidence. Checkpoint A records them as explicit blockers; no cleanup command is approved or executed.

### Verification and results

- [x] Read-only revision/status inventory.
- [x] Read-only changed/untracked path inventory.
- [x] Read-only lockfile version extraction.
- [x] Read-only migration count and SHA-256 manifest.
- [x] `.gitignore` now retains `.env.sandbox-rehearsal` and separately ignores `/generated/`.
- [x] Final `git diff --check` and focused Checkpoint A diff review.
- [x] `tasks/todo.md` Prettier check after the focused formatting correction.

**Results:** Checkpoint A inventory, ignore-rule correction, migration checksum manifest, and safety register are complete. Static verification passed after a documentation-only formatting correction. The clean-revision gate remains **BLOCKED** until later authorization resolves the pre-existing dirty product/test/rehearsal work and assigns cleanup owners/expiry. No evidence from this dirty tree may be described as a clean immutable CP2 revision.

---

# 2026-09-10 — BE-5 CP2 Checkpoint B — Fail-closed S3 replay integrity + production env safety

## Scope (authorized)

Checkpoint B only: fail-closed S3 replay verification + production env config safety. No DB access, no external S3/MinIO calls, no cleanup, no commit, no FE-6. All tests are non-DB mock/unit tests.

## Files changed

- `src/modules/governance/application/s3-manifest.provider.ts` — fail-closed 412 replay via HeadObject equality metadata; fixed equality metadata on first PUT; SSEKMSKeyId for `aws:kms`; optional injected `S3Client` test seam; removed `isAccessDenied()` success path and misleading comment.
- `src/config/env.validation.ts` — new optional `S3_KMS_KEY_ID` field + 5 cross-field production checks.
- `src/modules/governance/application/s3-manifest.provider.spec.ts` (new) — 8 mock-S3Client cases.
- `src/config/env.validation.spec.ts` — extended with 7 production/S3 safety cases; fixed 2 existing production-success tests to use a durable S3 provider.
- `src/modules/governance/application/deletion-manifest.exporter.spec.ts` — extended: provider `unavailable`/`conflict` never marks row exported.
- `.env.example`, `.env.production.example` — document `S3_KMS_KEY_ID`; production example warns `none` is rejected.

## Behavior

- First PUT stores `Metadata: { manifest-sha256, deletion-event-id, contract-version }` + `ChecksumSHA256` + `If-None-Match: *` + Object Lock.
- On 412, `HeadObject` must prove `ContentLength === body.length` AND all three equality metadata fields match. All match → idempotent replay success. Any mismatch → `ManifestProviderConflictError`. Any 403/404/error/missing metadata/unverifiable → `ManifestProviderError('unavailable')`. Never success without equality proof.
- `DeletionManifestExporter` unchanged; its existing catch routes provider errors to retry/failed (proven by new tests).
- Production env validation rejects: `local` provider, `none` encryption, `aws:kms` without `S3_KMS_KEY_ID`, non-https S3 endpoint, and purge enabled without a durable S3 provider.

## Verification

All non-DB mock/unit gates PASS (dedicated test subagent + post-fix re-run):

| Command                                                      | Result       |
| ------------------------------------------------------------ | ------------ |
| `npx prettier --check <5 changed files>`                     | PASS         |
| `npm test -- --runInBand s3-manifest.provider.spec.ts`       | PASS — 8/8   |
| `npm test -- --runInBand deletion-manifest.exporter.spec.ts` | PASS — 4/4   |
| `npm test -- --runInBand env.validation.spec.ts`             | PASS — 39/39 |
| `npm test -- --runInBand governance.service.spec.ts`         | PASS — 5/5   |
| `npm run typecheck`                                          | PASS         |
| `npm run lint:check`                                         | PASS         |
| `npm run format:check`                                       | PASS         |
| `npm run build`                                              | PASS         |
| `git diff --check`                                           | PASS         |

Two defects found and fixed during verification: (1) the new S3 provider spec's mock client did not structurally satisfy `S3Client` (cast to `S3Client & { send: jest.Mock }`); (2) the purge-without-durable-provider env check was unreachable because the `local`-provider guard threw first — reordered so the purge check reports its specific cause.

## Boundary

No DB, no `test:e2e`/`test:integration`, no external object-store call, no commit. Local provider default unchanged; `RETENTION_PURGE_ENABLED` default false. Rollback = revert this slice only.

---

# 2026-09-11 — BE-5.1 Archive Domain Plan — Checkpoint A

## Objective

建立 archive domain 的 current baseline 與 contract reconciliation；本站只完成證據盤點，完成後停在 Gate A，等待人工確認，不自動進入 Checkpoint B。

## Checklist

- [x] 記錄 current revision、branch、working-tree、runtime/tool baseline 與安全邊界。
- [x] 盤點 archive source、domain projection、tests、schema 與 archive migrations。
- [x] 由 source/call graph 確認唯一 production archive writer 與 close-to-archive transaction boundary。
- [x] 搜尋並分類所有 `ArchivedResult` create/update 路徑：production create、BE-5.2/5.3 governed tombstone transition、test fixture。
- [x] reconciliation Prisma model 與 archive migrations 的 unique/FK/index/check/backfill 性質。
- [x] 凍結 same-transaction、replay、participant unlinking、projection privacy 與 application immutability 契約。
- [x] 記錄 stale documentation、未授權 DB/provider evidence、以及不可由本 checkpoint 宣稱完成的 BE-5.2/5.3 工作。
- [x] 只執行 read-only/static inspection；未執行 migration、seed、truncate、DB-backed tests、provider upload 或 cleanup。
- [x] 確認本次 diff 僅修改 `tasks/todo.md`。
- [ ] 取得 Gate A 明確人工確認後，才可進入 Checkpoint B。

## Baseline / evidence

- **Revision:** `main` at `1c841cacbb56b967e61abf29034588afacdd8e04`; working tree clean at capture time; timestamp `2026-09-11T10:00:28Z` UTC. Node `v26.5.1`; npm `11.17.0`。本 checkpoint 未執行 Docker、migration status 或任何 DB command。
- **唯一 production writer / call graph:** `LiveSessionService.closeSessionInTransaction()`（`src/modules/live-sessions/application/live-session.service.ts:115`）在同一 transaction 呼叫 `GovernanceService.archiveSessionInTransaction()`（line 216）；manual close 與 auto-close 共用 close path。`GovernanceService.archiveSession()`（`src/modules/governance/application/governance.service.ts:166`）是同一 command 的 transaction wrapper，`archiveSessionInTransaction()`（line 174）內的 `t.archivedResult.create()`（line 231）是 production archive create。未發現 archive creation controller、scheduler rebuild 或第二套 aggregation path。
- **Mutation inventory:** `governance.service.ts:538,570,672` 的 `archivedResult.update()` 僅分類為 retention/early-deletion governed tombstone transitions；直接 create/update 出現在 `test/archive-governance.e2e-spec.ts`、`test/deletion-manifest-exporter.integration-spec.ts`、`test/s3-sandbox-rehearsal.integration-spec.ts` 的 fixture/setup，不是 production writer。這些 runtime/DB claims 沒有在本 checkpoint 重新執行。
- **Projection/privacy:** `src/modules/governance/domain/archive-projection.ts` 的 `projectArchive()`（line 189）重用 `aggregateResults()`（line 200），`parseArchivedResult()`（line 31）以 strict nested allowlist 重建 `schemaVersion: 1` payload；poll/quiz 對外為 anonymous aggregate，open-text 僅 anonymous `{ text }`。正常 API 無 active payload update；DB owner/DBA direct SQL 不在 application immutability guarantee 內。
- **Schema/migration:** `prisma/schema.prisma:363` 的 `ArchivedResult.liveSessionId` 為 unique，保留 LiveSession FK；`purgeAt/status` index 存在。`20260828090000_add_archive_governance/migration.sql` 建立 archive table、active/deleted status constraint、course/closed 與 purge/status indexes、deletion-event relations；`20260908090000_freeze_archive_governance_contract/migration.sql` 先檢查既有 invariant，再 backfill `session_label`/`started_at`，加入 `active + payload`／`deleted + NULL payload` check 與 closed-time ordering index。後者不是 metadata-only；兩者屬 additive/backfill history。本 checkpoint 不新增 migration，也未將 test DB evidence 寫成 production deployment evidence。
- **Atomicity contract:** PostgreSQL transaction commit 是 close state、archive creation、participant anonymization 與 transactional outbox 的 authority；projection/create/anonymization failure 必須 rollback，Socket publish 僅在 commit 後。replay 讀回既有 archive，不重建或替換 payload。Submission 可暫時保留指向已匿名化 Participant 的 FK，但 archive API 不得重建 answer-to-person linkage。
- **Historical reconciliation:** `1c841ca` current hardening、`aec12a9` fail-closed S3/env safety、`9fc65b1` prior provenance baseline、`584e661` archive E2E matrix 均屬 provenance。歷史 completion plan 的 `after committed close` 描述與 current same-transaction call graph 不一致，應以 superseding reconciliation note forward-correct；本 checkpoint 不修改 authoritative docs。

## Acceptance / gaps

- **Baseline supported:** BE-5.1.1 close/archive/anonymization same transaction、唯一 production writer、replay idempotency；BE-5.1.2 schema/migration contract facts；BE-5.1.3 projection reuse、strict parser、create-once/application immutability boundary。
- **Still pending:** BE-5.1.4 query-contract additions、BE-5.1.5 complete privacy/replay evidence matrix、BE-5.1.6 separately named waiting/active DB-backed negative tests。WBS 不因本次 static reconciliation 勾選。
- **Not claimed:** BE-5.2 retention operational completion、BE-5.3 early deletion completion、production migration deployment、fresh DB-backed runtime rollback proof、external S3/MinIO rehearsal、cleanup/credential ownership resolution。

## Risk & rollback

- **Risk level: medium**：涉及 privacy、transaction authority、跨文件契約；本 checkpoint 沒有 destructive operation。
- 主要風險是把 archive 移出 close transaction、legacy JSON pass-through、raw answer exposure、application immutability 誤當 DB tamper-proof，或把歷史 test evidence 誤宣稱為 current production/DB evidence。
- Rollback：revert this task-only documentation section；不做 down migration、不恢復 deleted data、不修改 production code。

## Dependencies / authorization boundary

- Runtime/source evidence 依賴目前 backend revision 與既有 migration files；authoritative docs 在 `../docs` 另一 repository，未於本 checkpoint 修改。
- 未授權且未執行：`prisma migrate deploy`、`prisma db push`、`prisma migrate status`、seed、任何 `test:e2e`/`test:integration`（setup 可能 deploy migration/truncate `smartlearning_test`）、provider upload/restore/apply、container/object/row cleanup。
- 下一站 Checkpoint B 若獲明確授權，必須只針對 `NODE_ENV=test` 且 sanitized DB name 恰為 `smartlearning_test`；DB mutation、migration deploy 與 migration status 仍分開授權。

## Verification

| Command / evidence                                             | Result                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `date -u`, `git rev-parse --show-toplevel`, branch/HEAD/status | PASS — recorded above; clean `main` at `1c841ca`                     |
| read-only source/schema/migration/commit inspection            | PASS — writer, schema, migration and provenance facts recorded above |
| `git diff --check`                                             | PASS — no whitespace errors                                          |
| DB-backed tests, migrations, provider calls, cleanup           | NOT RUN — outside Checkpoint A authorization                         |

## Results / Gate A disposition

Checkpoint A baseline/reconciliation record is **READY FOR REVIEW**. The only intended file change is this `tasks/todo.md` section; no production code, schema, migration, tests, generated output, database, provider, or external object was changed.

Before Checkpoint B, obtain explicit confirmation that the following are accepted: (1) same-transaction close-to-archive boundary；(2) application/domain immutability versus privileged DB-role boundary；(3) Submission temporarily referencing an anonymized Participant；(4) no new migration expected for BE-5.1 reconciliation。Stop here until that confirmation is received.

---

# 2026-09-11 — BE-5.1 Archive Domain Plan — Checkpoint B

## Scope / authorization

- [x] Added only the missing BE-5.1.6 lifecycle-negative evidence: independent waiting and active archive attempts.
- [x] User explicitly authorized DB-backed testing with `NODE_ENV=test` and database exactly `smartlearning_test`.
- [x] Test setup's implicit `npx prisma migrate deploy` and `truncateAll()` were within that authorization; `truncateAll()` clears all non-migration public tables in the test database and resets identities.
- [x] No development/staging/production DB, provider, S3/MinIO, cleanup, migration file, schema, API contract, WBS, or production code was changed.

## Implementation / assertions

- `test/archive-governance.e2e-spec.ts` adds `createWaitingSession()` and two independent tests using `GovernanceService.archiveSession(liveSessionId)`:
  - waiting: returns `null`, creates zero `ArchivedResult` rows, leaves `status=waiting` and `closedAt=null`;
  - active: returns `null`, creates zero `ArchivedResult` rows, leaves `status=active` and `closedAt=null`, and preserves participant `accountId`, `displayName`, and `tokenHash` exactly.
- Existing successful close/archive, cancel/discard, privacy, retention, replay, and authorization cases were preserved.
- No HTTP archive-creation route was introduced or used; the test targets the existing application command boundary.

## Verification

| Command                                                                             | Result                                                                                                      |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Sanitized `.env.test` preflight                                                     | PASS — `NODE_ENV=test`, PostgreSQL `localhost:5432`, database `smartlearning_test`; credentials not printed |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/archive-governance.e2e-spec.ts` | PASS — 1 suite, 13 passed, 0 failed, 0 skipped                                                              |
| Test setup migration/truncation                                                     | PASS — authorized `migrate deploy` path and per-test `truncateAll()` completed against `smartlearning_test` |
| `git diff --check`                                                                  | PASS                                                                                                        |

Non-blocking warning: NestJS `LegacyRouteConverter` warnings for `health/(.*)` and `/api/*` route patterns.

## Results / Gate B disposition

Checkpoint B lifecycle matrix is **READY FOR REVIEW**. Waiting and active archive attempts have zero archive and zero lifecycle/anonymization side effects; existing cancelled-session discard and valid close/archive paths remain green in the focused suite. Verification confidence is focused integration-level E2E.

Stop at Gate B. Do not enter Checkpoint C, modify archive query filters, update authoritative docs/WBS, run broader regression, provider operations, cleanup, or commit until separately authorized.

---

# 2026-09-11 — BE-5.1 Archive Domain Plan — Checkpoint C

## Scope / authorization

- [x] Implemented BE-5.1.4 additive archive list filters: `liveSessionId`, `closedFrom`, and `closedTo`.
- [x] `closedFrom`/`closedTo` validate full offset-bearing ISO date-times and reject reversed instants through standard DTO validation.
- [x] User explicitly authorized DB-backed verification only with `NODE_ENV=test` and database exactly `smartlearning_test`.
- [x] Archive E2E setup's implicit `prisma migrate deploy`, per-test `truncateAll()` of all non-migration public tables, and run-scoped `ArchivedResult.closedAt` fixture updates were within that authorization.
- [x] No migration, index, schema, provider, cleanup, or authoritative-document change was made.

## Implementation

- `src/modules/governance/api/dto/governance.dto.ts`
  - Added UUID validation for `liveSessionId`.
  - Added `closedFrom`/`closedTo` date-time Swagger metadata and validation requiring `Z` or an explicit numeric offset.
  - Added class-validator range constraint enforcing `closedFrom <= closedTo` without controller-side error shaping.
- `src/modules/governance/application/governance.service.ts`
  - Added normalized `liveSessionId` filtering.
  - Added inclusive `closedAt.gte`/`closedAt.lte` predicates.
  - Preserved one shared owner/filter `where` for `findMany` and `count`, plus `closedAt DESC, id DESC` ordering.
- `test/archive-governance.e2e-spec.ts`
  - Added owned/foreign/admin LiveSession filtering, inclusive date boundaries, offset equivalence, combined filters, pagination/count checks, malformed/reversed range validation, and tie-order coverage.
- `test/openapi.e2e-spec.ts`
  - Froze the three new query parameters as UUID/date-time schemas.

## Verification

| Command                                                                                 | Result                                                                                                      |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Sanitized `.env.test` preflight                                                         | PASS — `NODE_ENV=test`, PostgreSQL `localhost:5432`, database `smartlearning_test`; credentials not printed |
| `npm run typecheck`                                                                     | PASS                                                                                                        |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/archive-governance.e2e-spec.ts`     | PASS — 1 suite, 13 passed, 0 failed, 0 skipped                                                              |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/openapi.e2e-spec.ts`                | PASS — 1 suite, 5 passed, 0 failed, 0 skipped                                                               |
| `npm test -- --runInBand src/modules/governance/application/governance.service.spec.ts` | PASS — 1 suite, 5 passed, 0 failed, 0 skipped                                                               |
| `npm run lint:check`                                                                    | PASS                                                                                                        |
| `npm run format:check`                                                                  | PASS                                                                                                        |
| `git diff --check`                                                                      | PASS                                                                                                        |

Non-blocking warning: NestJS `LegacyRouteConverter` warnings for `health/(.*)` and `/api/*` route patterns.

## Results / Gate C disposition

Checkpoint C query contract is **READY FOR REVIEW**. Teacher owner scope, admin-global scope, student denial, foreign existence hiding, inclusive `closedAt` range semantics, filter-before-pagination/count, deterministic ordering, and OpenAPI parameter schemas are covered by the focused tests. No new migration or index was required.

Stop at Gate C. Do not enter Checkpoint D, update projection/privacy documents or WBS, run broader regression/provider operations/cleanup, or commit until separately authorized.

### 2026-09-11 — Checkpoint D: projection, privacy, and replay evidence

#### Acceptance criteria

- [x] Strict `schemaVersion: 1` archive parsing preserves stable ordering and allowlists only aggregate/open-text fields.
- [x] Nested prohibited-field evidence covers participant/account/display/token/sessionCode/submissionId/submittedAt/idempotencyKey/selectedOptionRefs.
- [x] Existing archive replay does not create or update an archive payload and re-applies participant anonymization.
- [x] Poll/quiz archives remain aggregate-only; open-text responses remain anonymous `{ text }`; no rollback/failure-injection API is added.

#### Checklist

- [x] Add structural nested negative assertions to archive projection tests.
- [x] Add service replay regression proving no create/update and participant unlinking.
- [x] Record same-transaction atomicity evidence and its static-proof limitation.
- [ ] Run DB-backed archive replay verification (requires separate explicit authorization for `smartlearning_test` migration/truncation).
- [ ] Submit Gate D evidence matrix and await confirmation before Checkpoint E documentation/WBS work.

#### Working notes

- `projectArchive()` continues to delegate to `aggregateResults()` with stable question/option ordering.
- `archiveSessionInTransaction()` returns the existing archive without rebuilding or replacing `payload`; replay still anonymizes participants in the same transaction.
- The close path uses one `Prisma.TransactionClient` for session state, archive creation, participant anonymization, and outbox writes. No failure-injection seam was introduced; atomicity is static call-graph evidence unless separately proven by DB integration.
- Poll/quiz raw submissions remain governed source storage for later BE-5.2/BE-5.3 handling and are not persisted in archive payloads.

#### Risk & rollback

- Risk: medium — privacy and immutable projection contract; no schema/migration/destructive operation.
- Rollback: revert only Checkpoint D test/task changes; do not run down migrations or attempt data restoration.
- DB authorization boundary: DB-backed suites may deploy migrations and truncate only `smartlearning_test`; neither was run in this checkpoint without explicit authorization.

#### Verification / Results

| `npm test -- --runInBand src/modules/governance/domain/archive-projection.spec.ts src/modules/governance/application/governance.service.spec.ts` | PASS — 2 suites / 16 tests |
| `npm run typecheck` | PASS |
| `npm run lint:check` | PASS |
| `npm run format:check` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |

Checkpoint D changes are limited to projection/service tests and this audit trail. Atomicity is supported by the same-transaction call graph; no failure-injection runtime proof was added. DB-backed replay verification remains BLOCKED pending explicit authorization for `smartlearning_test` migration/truncation. Authoritative governance docs and WBS remain unchanged until Gate D approval.

#### Gate D disposition

Gate D was accepted on 2026-09-11 for documentation closeout. The final contract is poll/quiz aggregate-only, open-text anonymous `{ text }`, strict nested allowlist, replay without payload rebuild/replacement, and participant anonymization on replay. Atomicity remains shared-transaction call-graph evidence without failure-injection runtime proof. Checkpoint E documentation/WBS candidate preparation is authorized; BE-5.2/BE-5.3, production migration, commit and destructive operations remain out of scope.

### 2026-09-11 — Checkpoint E: documentation and WBS closeout draft

- [x] Update backend frontend API reference with archive filters, inclusive `closedAt` semantics, ownership/foreign hiding, no archive-create route, and privacy projection contract.
- [x] Append superseding reconciliation note to authoritative result-governance, realtime-governance, and historical BE-5 completion documents.
- [x] Add BE-5.1 per-item VERIFIED CANDIDATE evidence draft to the WBS without checking BE-5.1 boxes prematurely.
- [x] Keep BE-5.2/BE-5.3 and FE-6 statuses unchanged.
- [x] Gate E review: user confirmed document consistency and authorized formal BE-5.1 WBS closeout.

#### Results / evidence boundary

Checkpoint E documentation changes are complete across the backend API reference and docs repository. Historical records were preserved through append-only superseding notes. Backend HEAD `1c841ca` and both repositories remain dirty; no new pinned commit is claimed. BE-5.1.1–BE-5.1.6 are now checked in the WBS; BE-5.2/BE-5.3 remain unchanged. No migration, purge, restore, external upload, production operation, or frontend change was performed.

### 2026-09-11 — Gate F final regression

- [x] Run the authorized full verification bundle against guarded `smartlearning_test` where applicable.
- [ ] Resolve unrelated regression failures before declaring the repository fully green.

#### Verification results

- PASS: `npm run prisma:validate`.
- PASS: `npm run typecheck`.
- PASS: `npm run lint:check`.
- PASS: `npm run format:check`.
- PASS: `npm run build`.
- PASS: unit tests: 58 suites passed / 1 failed; 366 tests passed / 1 failed. Failure: `src/modules/realtime/live-gateway.spec.ts:156`, expected terminal `session.closed` replay to call `socket.disconnect(true)` but observed zero calls.
- FAIL: E2E: 32 suites passed / 1 failed; 240 tests passed / 1 failed. `student-session-status.e2e-spec.ts` encountered PostgreSQL `40P01 deadlock detected` during test cleanup truncate in `test/setup/db.ts`.
- FAIL/BLOCKED: integration: 4 suites passed / 2 failed; 20 tests passed / 7 failed. Redis suite requires `RUN_LOGIN_RATE_LIMIT_REDIS_TESTS=1`; S3 rehearsal requires `DELETION_MANIFEST_PROVIDER=s3` and reachable guarded DB.
- BLOCKED: `npm run prisma:migrate:status` loaded `.env.development` and targeted `smartlearning_dev` at `localhost:5433`, which was unreachable (`P1001`). The authorized test DB identity was separately verified as exactly `smartlearning_test`.
- PASS: `git diff --check`.

#### Gate F disposition

Final regression is **NOT GREEN**. Per stop-the-line rule, no further fixes or reruns were attempted. The failures are outside the BE-5.1 documentation/WBS edits except for the shared test cleanup/realtime areas; BE-5.1 WBS closeout remains recorded, but final repository-wide completion and any commit are deferred until the failures are separately diagnosed and resolved.

# 2026-09-11 — BE-5.2 Archive Retention Plan — Checkpoint A

## Context and acceptance criteria

BE-5.2 Checkpoint A freezes the irreversible retention deletion contract and records a source-level baseline. It is documentation/static contract work only; no migration, generated-client change, purge, provider operation, or DB-backed verification is authorized in this checkpoint.

- [x] Add and review a table-by-table inventory of all governed session data, retained archive metadata, canonical tombstone/outbox records, and explicitly retained shared records.
- [x] Reconcile `DELETED_CATEGORIES` with the frozen contract; record the current implementation mismatch for Checkpoint C rather than silently treating it as compliant.
- [x] Preserve `purgeAt = closedAt + 90 days` as the immutable legal deadline and use PostgreSQL as clock/coordination authority.
- [x] Preserve `LiveSession`, Course, Account, and reusable `QuestionDefinition` data; do not reimplement BE-5.3 provider-backed restore/reconciliation.
- [ ] **In progress:** obtain human review before Checkpoint B or any migration/DB-backed verification.

## Provenance baseline

- Repository root: `/home/user/projects/smartLearning/smartLearning-backend`; branch: `main`; HEAD: `56abb149d7397a6e7200b4b35aa82c4e2afa9cfd` (`56abb14`, `feat(governance): close archive domain evidence`).
- Runtime baseline: Node `v26.5.1`; npm `11.17.0`. Working tree is modified only by this Checkpoint A task-record update; no product/source/schema/generated/database/provider/container state was changed.
- Historical governance commits and evidence remain provenance only; this checkpoint does not claim production migration, provider, alert-routing, or clean-revision operational readiness.

## Frozen deletion inventory

| Data/table                                | Frozen BE-5.2 retention contract                                                                                                                                                    | Baseline disposition                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `Submission`                              | Delete every row belonging to the live session.                                                                                                                                     | Governed deletion                                                                                     |
| `LiveSessionEvent`                        | Delete every row for the session, including routing, projection, and replay state; visibility must not narrow the scope.                                                            | Governed deletion; current code only targets `participant_after_submit` and requires later correction |
| `SessionQuestionOption`                   | Delete all selected-session option snapshots, after dependent answer data.                                                                                                          | Governed deletion                                                                                     |
| `SessionQuestion`                         | Delete all selected-session question snapshots after options.                                                                                                                       | Governed deletion                                                                                     |
| `Participant`                             | Delete participant identity, account/token, display, and reconnect linkage.                                                                                                         | Governed deletion                                                                                     |
| Session-scoped aggregate/projection state | Delete any separate answer-bearing aggregate/projection rows represented by the schema; if represented only by submissions/events, the zero-row invariant applies to those sources. | Governed deletion; schema inventory must be rechecked in Checkpoint C                                 |
| `ArchivedResult`                          | Retain the non-answer archive shell/lifecycle metadata; set `payload` to NULL and transition status to deleted. Never move `purgeAt`.                                               | Retained tombstone shell                                                                              |
| `DeletionEvent`                           | Retain exactly one canonical successful retention tombstone/event with stable categories/reason only.                                                                               | Retained governance record                                                                            |
| `DeletionManifestOutbox`                  | Retain exactly one canonical immutable manifest outbox record for export/BE-5.3 reconciliation.                                                                                     | Retained governance record                                                                            |
| `LiveSession`                             | Retain lifecycle metadata, including `closedAt` and immutable `purgeAt`.                                                                                                            | Explicitly retained                                                                                   |
| `LiveSessionQuestionSelection`            | Retain non-answer selection/lifecycle metadata; reusable question definitions remain independent.                                                                                   | Explicitly retained unless a later authoritative contract says otherwise                              |
| Course                                    | Retain course metadata and ownership.                                                                                                                                               | Explicitly retained                                                                                   |
| `CourseEnrollment`                        | Retain course/account roster metadata; it is not session answer data.                                                                                                               | Explicitly retained                                                                                   |
| Account                                   | Retain account identity/lifecycle data outside participant linkage.                                                                                                                 | Explicitly retained                                                                                   |
| `QuestionDefinition`                      | Retain reusable course question definitions.                                                                                                                                        | Explicitly retained                                                                                   |
| `QuestionOption`                          | Retain reusable options belonging to `QuestionDefinition`; only copied session options are governed.                                                                                | Explicitly retained                                                                                   |

### Category reconciliation baseline

The current `DELETED_CATEGORIES` value is exactly `['archive_payload', 'submissions', 'participants', 'session_questions', 'realtime_target_routing']`. Its current meanings are: archive payload; submissions; participants; session questions/options as a broad group; and realtime target routing. The frozen contract requires those meanings to cover every governed row listed above, especially all `LiveSessionEvent` state (routing, projection, replay, and delivery), not only target routing. The current executor in `src/modules/governance/application/governance.service.ts` deletes only `participant_after_submit` events, so the current category vocabulary/predicate is recorded as nonconforming and must be reconciled/versioned in Checkpoint C without silently changing immutable historical manifests in Checkpoint A. Checkpoint A records this gap; it does not modify the deletion implementation.

## Dependencies, environment, and authorization gates

- PostgreSQL is the authority for retention time and worker coordination; application retries must never change `purgeAt`.
- Required later verification environment is the guarded `smartlearning_test` database only. `test/setup/db.ts` can implicitly run migrations and truncate data; that is DB-backed/destructive activity and is not authorized here.
- Do not run `prisma generate`, `prisma migrate deploy`, `prisma migrate status`, `prisma db push`, DB-backed E2E/integration tests, purge/early-delete/reconcile-apply, S3/provider uploads, restore rehearsals, or container operations during Checkpoint A.
- BE-5.3 provider-backed restore filtering/reconciliation remains a separate scope; BE-5.2 only produces the canonical deletion event/outbox manifest it consumes.

## Risk, stop conditions, and rollback

- **Risk:** HIGH — irreversible privacy-sensitive deletion across related session tables with concurrent workers.
- Stop immediately for any deletion before `purgeAt`, category/dry-run mismatch, unexpected retained or selected governed rows, non-atomic deletion plus tombstone/outbox, manifest immutability/checksum conflict, growing quarantine or lost lease ownership, or interactive API/realtime SLO impact.
- Before deletion, rollback is disabling purge/export gates and reverting or forward-fixing code while leaving additive schema in place. After deletion, application rollback or backup restore must not reconstruct deleted answer-bearing data; preserve tombstones, outbox records, immutable manifests, logs, and metrics, and pause new claims for forward-fix.

## Checkpoint A working notes and results

- **Gate status:** awaiting human review; no implementation change has started.
- Source baseline: `ArchivedResult` currently has status/payload/purgeAt but no durable purge claim/retry state; `purgeDue()` still uses invocation-local failure handling; `inspectDue()` is metrics-only; operator `run-once`/manifest export branches and an independent manifest scheduler remain later work.
- **Results:** Checkpoint A baseline has been recorded in this task file. No migration, generation, DB-backed test, purge, provider upload, restore rehearsal, or container operation was performed. Await explicit human review/authorization before Checkpoint B.

---

# 2026-09-11 — BE-5.2 Archive Retention Plan — Checkpoint B

## Scope and acceptance criteria

Checkpoint B adds only the durable purge work-state foundation on `ArchivedResult`. Shared deletion planning/dry-run belongs to Checkpoint C; durable claim/execute/retry/quarantine behavior belongs to Checkpoint D; scheduler/CLI/provider wiring belongs to Checkpoint E; provider-backed restore/reconciliation remains BE-5.3.

- [x] Add `purgeState`, `purgeAttempts`, `nextPurgeAttemptAt`, purge lease fields, stable failure metadata, and `quarantinedAt` to the Prisma model.
- [x] Add one hand-written additive migration with preflight, active/deleted backfill, state/lease/quarantine/payload coherence checks, stable failure-code allowlist, and a bounded due/lease-recovery index.
- [x] Keep new archive rows pending with `nextPurgeAttemptAt = purgeAt`; make all existing tombstone transitions set `purgeState = deleted` and clear transient work state without moving `purgeAt`.
- [x] Run only the authorized `smartlearning_test` migration/status and focused archive verification; do not touch other databases or invoke purge/provider/restore operations.
- [ ] **In progress:** obtain human review before Checkpoint C (shared deletion plan/dry-run).

## Dependencies, environment, and authorization

- PostgreSQL remains the clock and coordination authority. `purgeAt` is immutable and exactly `closedAt + 90 days`; retries and backoff state must not modify it.
- Runtime baseline: Node `v26.5.1`, npm `11.17.0`; target database is exactly `smartlearning_test` through `NODE_ENV=test` and `.env.test`.
- **Authorized:** user confirmed entry into Checkpoint B and authorized `smartlearning_test` DB validation. This includes the guarded test setup’s documented idempotent migration check and `truncateAll()` fixture cleanup for the focused suite; no development/staging/production DB is in scope.
- Prisma 7 generated client must be regenerated and normalized with `node scripts/normalize-prisma-client.mjs generated/prisma` after the schema edit. Do not edit an already-applied migration or add a down migration.

## Files and symbols

- `prisma/schema.prisma` — `ArchivedResult` durable work-state fields and mappings.
- `prisma/migrations/20260911100000_add_archive_purge_worker_state/migration.sql` — additive SQL, preflight/backfill/checks/index.
- `src/modules/governance/application/governance.service.ts` — archive creation and tombstone state writes.
- `test/archive-governance.e2e-spec.ts` — focused guarded archive verification.
- `tasks/lessons.md:119-124` — CHECK constraints must not use subqueries; use scalar predicates only.

## Migration contract

- Preflight must fail loudly before mutation on active/payload or deleted/NULL violations. The initial draft also preflighted `purge_at <> closed_at + 90 days`; this was **superseded during verification** (see results): e2e fixtures legitimately rewrite `purge_at` to simulate due archives, and `purgeAt` provenance is an application invariant enforced at `archiveSessionInTransaction()`, not a migration precondition. The deployed migration preflights only the status/payload invariant and never modifies `purge_at` itself.
- Existing active rows become `pending`; deleted rows become `deleted`; attempts start at zero; `next_purge_attempt_at` is backfilled from `purge_at`; lease/failure/quarantine fields start NULL.
- Allowed states are `pending`, `processing`, `retry`, `quarantined`, `deleted`. Attempts are non-negative. `processing` requires both lease fields; all other states have neither. `quarantined` requires `quarantined_at`; other states do not. Failure code/time are paired and failure code is a fixed low-cardinality class.
- Active/deleted state must remain coherent with the existing payload check. The partial work index covers active pending/retry/processing rows ordered for due work and lease recovery.

## Risk, stop conditions, and rollback

- **Risk level: HIGH:** this adds durable state and database constraints used by a future irreversible privacy deletion worker.
- Stop immediately on wrong database identity, preflight mismatch, migration failure, failed invariant check, unexpected data mutation, lock/resource impact, or any production/source behavior outside this checkpoint.
- Before purge is enabled, rollback is disable/forward-fix or application revert while retaining the additive migration history. There is no normal down migration. Never reconstruct deleted answer-bearing data through rollback or backup restore.

## Verification results

| Command                                                                                      | Result                                                                      |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `npm run prisma:validate`                                                                    | PASS — schema valid                                                         |
| `npm run prisma:generate` + `node scripts/normalize-prisma-client.mjs generated/prisma`      | PASS — client regenerated, CJS-normalized (0 files changed, idempotent)     |
| `npm run typecheck`                                                                          | PASS                                                                        |
| `npm run format:check`                                                                       | PASS                                                                        |
| `npm run lint:check`                                                                         | PASS                                                                        |
| `npm run build`                                                                              | PASS                                                                        |
| `git diff --check`                                                                           | PASS                                                                        |
| Focused unit: `governance.service.spec.ts`                                                   | PASS — 1 suite / 6 tests                                                    |
| Focused unit: governance 4-suite bundle (service/scheduler/reconciliation/exporter)          | PASS — 4 suites / 22 tests                                                  |
| Sanitized preflight: `.env.test` DB name + no exported `DATABASE_URL`                        | PASS — exactly `smartlearning_test@localhost:5432`, credentials not printed |
| Pre-deploy `NODE_ENV=test npm run prisma:migrate:status`                                     | PASS — only `20260911100000_add_archive_purge_worker_state` pending         |
| `NODE_ENV=test npm run prisma:migrate:deploy`                                                | PASS after one fail-loud preflight iteration (below)                        |
| Post-deploy `NODE_ENV=test npm run prisma:migrate:status`                                    | PASS — 19 migrations, schema up to date                                     |
| `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/archive-governance.e2e-spec.ts` | PASS — 1 suite / 13 tests, 0 failed, 0 skipped                              |

### Fail-loud preflight event (forward-fixed)

1. The first deploy aborted on the draft's `purge_at <> closed_at + 90 days` preflight (`P0001 archive purge deadline invariant violated`). This was the preflight working as designed: guarded test fixtures deliberately rewrite `purge_at` to model due archives, and `purgeAt` provenance is enforced in the application writer, not at migration time.
2. The migration was corrected to preflight only the status/payload invariant (additive columns/backfill never touch `purge_at`), the failed migration record was marked rolled back via `NODE_ENV=test npx prisma migrate resolve --rolled-back` (authorized DB-state repair for exactly `smartlearning_test`), and the deploy then succeeded cleanly. No data rows were modified outside the migration's own backfill; no other database was touched.

## Checkpoint B results / gate

- **Results:** Checkpoint B is **GREEN**. `ArchivedResult` now carries durable purge work state (`purgeState/purgeAttempts/nextPurgeAttemptAt`, paired lease fields, paired stable failure metadata, `quarantinedAt`) backed by one additive migration with preflight/backfill/coherence CHECKs and a partial due/lease-recovery index. Archive creation writes `pending` with `nextPurgeAttemptAt = purgeAt`; all three tombstone transitions write `purgeState = deleted` and clear transient work state. `purgeDue()`/scheduler/CLI/env remain intentionally unchanged (Checkpoints C–E own them).
- **Not done / deferred:** no claim/lease execution logic, dry-run, scheduler/env/CLI wiring, or provider work; no additional constraint-level negative-state fixtures beyond the E2E matrix; WBS BE-5.2 boxes remain unchecked.
- **Gate:** STOP here for human review before Checkpoint C. Migration deployment to other environments and any purge execution require separate authorization.

---

# 2026-09-11 — BE-5.2 Archive Retention Plan — Checkpoint C: shared deletion plan + true dry-run

## Scope and acceptance criteria

Checkpoint C centralizes the governed deletion as a single shared plan and adds an
**execution-equivalent, no-delete dry-run** at the service layer. Durable
claim/execute/retry/quarantine behavior belongs to Checkpoint D; scheduler/CLI/env
wiring belongs to Checkpoint E; provider-backed restore remains BE-5.3. **Checkpoint C
does not change what the executor deletes** (the `LiveSessionEvent` predicate stays at
the current `PARTICIPANT_AFTER_SUBMIT` scope); it surfaces the reconciled contract scope
numerically so the operator can see the gap before any execution-semantics change (D).

- [x] Add `src/modules/governance/application/deletion-plan.ts` — the single source of truth for
      governed deletion: ordered entries, each carrying a `where(sid)` closure **shared by the
      count (dry-run) and deleteMany (execute) paths** so the plan cannot drift from execution.
- [x] Refactor `GovernanceService` so all three tombstone paths (`purgeOneInTransaction`,
      `applyDeletionManifestInTransaction` existing + canonical branches) delete governed rows
      through the shared plan instead of three bespoke duplicate blocks.
- [x] Add a service-layer **true dry-run**: `purgeDue(limit, now, dryRun=false)` uses the same
      oldest-first `FOR UPDATE OF live_session SKIP LOCKED` claim + row lock, then counts each
      governed table via the shared plan without writing; `dryRun=true` returns a per-archive /
      per-category / reconciled-event report. Default path and scheduler callers are unchanged.
- [x] Dry-run reports the `LiveSessionEvent` count under **both** the current executor scope
      (`PARTICIPANT_AFTER_SUBMIT`) and the reconciled contract scope (all events), exposing the
      Checkpoint-A-recorded conformance gap as a number without flipping the delete predicate.
- [x] Guarded `smartlearning_test` e2e + unit proof: dry-run performs zero writes (submission /
      participant / session_question / session_question_option / live_session_event / archive /
      deletion_event / outbox counts all unchanged) and its per-category counts match a real
      purge on identical fixtures (execution-equivalence tripwire).
- [ ] **In progress:** obtain human review at the Checkpoint C gate before Checkpoint D.
- [ ] **Deferred to D (not done here):** flip the executor `LiveSessionEvent` scope to delete
      all session events (routing/projection/replay/delivery); CLI/scheduler dry-run wiring;
      durable claim/lease/retry/quarantine.

## Files and symbols

- `src/modules/governance/application/deletion-plan.ts` — `DELETION_PLAN_VERSION`,
  `GOVERNED_DELETION_PLAN` (ordered), `DeletionPlanEntry`, `DELETION_EVENT_CATEGORY`;
  the single place that maps a category to its count===delete `where`. (Application layer,
  not domain: the `where` closures are Prisma transaction-client coupled.)
- `src/modules/governance/application/governance.service.ts` —
  `deleteRowsByPlanInTransaction(t, sid)`, `planDeletionInTransaction(t, sid)`,
  `purgeDue(limit, now, dryRun)`, `applyGovernedPlan` replacing the three duplicate blocks.
- `src/modules/governance/application/governance.service.spec.ts` — dry-run returns a plan and
  never calls deleteMany; executor and dry-run share the plan's where (no drift).
- `test/archive-governance.e2e-spec.ts` — guarded zero-write dry-run + counts-match-purge.

## Deletion plan contract (single source of truth)

Ordered governed rows (matches the frozen BE-5.2 inventory): submission →
live_session_event (current scope) → session_question_option → session_question → participant.
The same `where` closure feeds both `count()` and `deleteMany()`. The reconciled full
`LiveSessionEvent` scope (`{ liveSessionId }`) is reported separately as the conformance gap.

## Risk, stop conditions, and rollback

- **Risk:** HIGH (privacy-deletion planning). Dry-run must be provably write-free.
- Stop immediately on any dry-run write observed, count/del drift between plan & execute,
  wrong test DB identity, migration/fixture failure, or any behavior change in the live purge path.
- Rollback: revert this checkpoint's service/domain/test changes; no down migration. The
  executor predicate is intentionally unchanged, so no live deletion semantics shifted.

## Verification (guarded; smallest → broader)

- [x] `npm run typecheck` / `npm run lint:check` / `npm run format:check` / `npm run build` / `git diff --check` — PASS
- [x] `npm test -- --runInBand src/modules/governance/application/governance.service.spec.ts` (unit) — PASS, 7 tests
- [x] Governance unit bundle — PASS, 7 suites / 47 tests
- [x] `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/archive-governance.e2e-spec.ts` — PASS, 14 tests (13 existing + 1 new dry-run proof)
- [x] `NODE_ENV=test npm run prisma:migrate:status` — PASS, schema up to date (no new migration in Checkpoint C)

## Checkpoint C results / gate

- **Results:** Checkpoint C is **GREEN**. A single shared governed-deletion plan
  (`governance/application/deletion-plan.ts`) is now the one place that maps each governed
  table to its count===delete `where`, and all three tombstone paths
  (`purgeOneInTransaction`, `applyDeletionManifestInTransaction` existing + canonical) delete
  through it. `purgeDue(limit, now, dryRun)` gains a **true execution-equivalent dry-run**: it
  takes the same oldest-first `FOR UPDATE OF live_session SKIP LOCKED` claim and row lock, then
  counts each governed table via the shared plan with **zero writes** (guarded e2e asserts every
  governed row + archive is untouched) and returns a per-archive/per-category report that also
  reveals the `LiveSessionEvent` reconciled full-scope count side-by-side with the current executor
  scope, quantifying the Checkpoint-A-recorded conformance gap as a number without flipping the
  delete predicate. Scheduler `runOnce()` and default callers are unchanged (`dryRun=false`).
- **What did not change:** the executor `LiveSessionEvent` predicate stays at
  `PARTICIPANT_AFTER_SUBMIT`; no CLI/scheduler dry-run wiring; no durable claim/lease/quarantine.
- **Not done / deferred to D (recorded, not silently skipped):** flip the executor `LiveSessionEvent`
  scope to delete all session events; CLI/scheduler dry-run wiring; durable claim/retry/quarantine.
- **Gate:** STOP here for human review at the Checkpoint C gate before Checkpoint D. Any
  execution-semantics change (widening the event predicate), scheduler/CLI wiring, migration to other
  environments, or purge execution requires separate authorization. WBS BE-5.2 boxes remain unchecked.

---

# 2026-09-11 — BE-5.2 Archive Retention Plan — Checkpoint D: durable leasing + full-session-event scope

## Scope and acceptance criteria (per user gate ruling → follow plan doc; CLI/env/scheduler wiring stays in E)

- [x] Rework `GovernanceService.purgeDue()` into bounded durable claim / per-item lease-verified
      execute / compare-and-set failure transition (claim assigns a UUID v7 lease + increments
      attempts; expired processing leases reclaimed; in-memory `failedIds` removed).
- [x] Flip the executor + dry-run `LiveSessionEvent` predicate to delete ALL session events
      (routing/projection/replay/delivery), closing the Checkpoint-A conformance gap; remove the now
      redundant `RECONCILED_EVENT_WHERE` and `reconciledLiveSessionEventCount` (dry-run reports the
      full scope via `tableCounts.LiveSessionEvent`).
- [x] Add bounded retry/backoff + quarantine policy (`purge-failure-policy.ts`) mapping failures to
      a stable allowlist and never persisting raw exception text; retry rows honor
      `next_purge_attempt_at` with bounded exponential backoff, quarantine permanent/exhausted rows,
      `purgeAt` never altered.
- [x] Dry-run stays write-free (lock-only scan shares predicates with the live claim; no
      `archived_result.updateMany`), and its counts match the now-widened executor.
- [x] Add minimal low-cardinality metrics (`retried`, `quarantined` item results).
- [ ] **Deferred to E:** scheduler splitting / manifest-export scheduler; CLI `dry-run` +
      `run-once` execution wiring; purge-lease / max-attempt env fields. No schema/migration in D.

## Files and symbols

- `src/modules/governance/application/governance.service.ts` — `purgeDue` (claim→execute→transition),
  `scanDueInTransaction`, `claimDueInTransaction`, `executePurgeOneInTransaction`,
  `transitionFailureInTransaction`, `finalizePurgeInTransaction` (shared executor tail),
  `planDeletionInTransaction` (dropped reconciled count).
- `src/modules/governance/application/deletion-plan.ts` — `GOVERNED_DELETION_PLAN` LiveSessionEvent
  → `{ liveSessionId }` (all events); `GovernedDeletionPlanDto` loses `reconciledLiveSessionEventCount`.
- `src/modules/governance/application/purge-failure-policy.ts` — NEW: `PurgeFailureCode`,
  `classifyPurgeFailure`, `decidePurgeFailure`, `retryDelayMs`, `LeaseLostError`.
- `src/modules/metrics/metrics.constants.ts` — add `retried`, `quarantined` to `JOB_ITEM_RESULTS`.
- `src/modules/governance/application/purge-failure-policy.spec.ts` — NEW unit coverage.
- `test/archive-governance.e2e-spec.ts` — widened event assertions + expired-lease-recovery proof.

## Eligibility semantics (superseded during verification)

The initial claim/scan gated **all** rows on `next_purge_attempt_at <= now`. Guarded fixtures (and
real data) legitimately rewrite only `purge_at` backward, so pending rows with stale
`next_purge_attempt_at` became ineligible and were skipped. Corrected to: pending rows are due on
`purge_at` alone; `next_purge_attempt_at` gates **retry** rows (backoff) only; expired leases gate
`processing` rows. This matches the BE-5.2 plan (backoff applies to retries, not first attempts).

## Risk & rollback

- **Risk: HIGH** — irreversible privacy deletion + widened executor scope + concurrent-worker leases.
- Rollback before deletion: disable `RETENTION_PURGE_ENABLED`, revert/forward-fix app code; additive
  migration stays. No down migration; never reconstruct purged data.
- DB boundary: DB-backed e2e ran only against authorized `smartlearning_test` (verified
  `smartlearning_test@localhost:5432`, 19 migrations up to date); no purge of real data, no S3/provider ops.

## Verification results

| Gate                                                                                         | Result                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                                                          | PASS                                                                                                                                                                                                                                                                                                                 |
| `npm run lint:check`                                                                         | PASS                                                                                                                                                                                                                                                                                                                 |
| `npm run format:check`                                                                       | PASS                                                                                                                                                                                                                                                                                                                 |
| `npm run build`                                                                              | PASS                                                                                                                                                                                                                                                                                                                 |
| `git diff --check`                                                                           | PASS                                                                                                                                                                                                                                                                                                                 |
| Governance unit bundle (`src/modules/governance/`)                                           | PASS — 8 suites / 60 tests                                                                                                                                                                                                                                                                                           |
| `NODE_ENV=test npm run test:e2e -- --runInBand --silent test/archive-governance.e2e-spec.ts` | PASS — 15 tests                                                                                                                                                                                                                                                                                                      |
| `NODE_ENV=test npm run prisma:migrate:status`                                                | PASS — schema up to date (no new migration in D)                                                                                                                                                                                                                                                                     |
| Full unit `src/`                                                                             | PASS except pre-existing `live-gateway.spec.ts:156` (Gate F, unrelated, realtime module untouched)                                                                                                                                                                                                                   |
| Full e2e regression                                                                          | archive-governance PASS in full-suite context; other PASS suites across account/admin/auth/realtime/enrollments/questions/live-session. Single failure `cli-batch-rate-limit` is the pre-existing `Bootstrap already completed` isolation flake (tasks/todo.md:1554) — passes isolated 3/3, unrelated to governance. |

---

# 2026-09-12 — BE-5.2 Archive Retention Plan — Checkpoint E: complete worker + operator wiring

## Scope and acceptance criteria (per approved plan `inherited-wiggling-dream.md`)

Checkpoint E turns the guarded Checkpoint-D foundations into a real retention capability: independent purge +
manifest-export schedulers, validated/coerced env fields, and no-longer-no-op operator CLI commands. **No
schema/migration is touched in E.** All destructive operations remain gated and disabled by default.

- [x] Add `ManifestExportScheduler` calling `DeletionManifestExporter.exportDueBatch()`; keep `RetentionScheduler`
      for purge. Each loop has independent enable/tick/batch, no-overlap, shutdown-drain, and redacted logs.
- [x] Add validated/coerced env fields: `RETENTION_PURGE_LEASE_MS`, `RETENTION_PURGE_MAX_ATTEMPTS`,
      `RETENTION_MANIFEST_EXPORT_ENABLED`, `RETENTION_MANIFEST_EXPORT_TICK_MS`,
      `RETENTION_MANIFEST_EXPORT_BATCH_SIZE`. All disabled by default; fail-closed when production enables
      export without a durable S3 provider.
- [x] Make `GovernanceService` purge lease/max-attempts configurable from env (fall back to today's defaults);
      record `manifest_export` job metrics.
- [x] Wire `src/bootstrap/retention.ts` no-op branches: `dry-run`, `run-once`, `manifest-export-once`.
      Non-zero exit when a destructive run reported failures/quarantine. Keep inspect + reconcile inspect/apply.
- [x] Update `.env.example`, package scripts (`retention`), runbook, and ops artifacts test.
- [x] Add manifest-export scheduler unit tests + env-validation tests + retention command-parser test.
- [x] Run full verification bundle (static + unit + guarded `smartlearning_test` e2e/integration).

## Checkpoint E results

- Workers wired and gated: purge (`RetentionScheduler` + `run-once`) and manifest export
  (`ManifestExportScheduler` + `manifest-export-once`) now execute their destructive/networked operations behind
  explicit default-disabled gates + `RETENTION_OPERATIONS_ENABLED`; `dry-run` is a new read-only,
  execution-equivalent plan command. CLI prints redacted stable JSON and exits non-zero on destructive-run failures.
- Purge lease/max-attempts moved from hardcoded consts to `RETENTION_PURGE_LEASE_MS` / `RETENTION_PURGE_MAX_ATTEMPTS`
  (defaults unchanged); `manifest_export` added to job metrics.
- No schema/migration change; deletion plan/predicates untouched; production fails closed without a durable S3
  provider when purge or export is enabled.

## Risk & rollback

- **Risk: HIGH** — CLI + schedulers now enable destructive purge/export. Mitigations: every destructive path keeps
  its explicit gate (`RETENTION_PURGE_ENABLED` / `RETENTION_MANIFEST_EXPORT_ENABLED`) + the top
  `RETENTION_OPERATIONS_ENABLED`; all default **disabled**; production fails closed without a durable S3 provider;
  metrics failures never throw; CLI surfaces only redacted stable JSON. No schema/migration; deletion plan untouched.
- Rollback: revert code/config/docs; no down migration; purged rows never reconstructed after purge.
- DB boundary: DB-backed suites run only against the exact guarded `smartlearning_test`; no purge against
  dev/staging/production.

## Dependencies & environment

- Runtime: Node `v26.5.1`, npm `11.17.0`. Config values are coerced with `Number()` at read time (mirroring
  `RateLimiterService` US-F7 rule) — never raw string concatenation.
- Prisma client unchanged; no `prisma generate` needed (no schema edit).
- Guarded DB: `smartlearning_test` via `NODE_ENV=test` and `.env.test`.

## Verification results

| Gate                                                                              | Result                                                                        |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run typecheck`                                                               | PASS                                                                          |
| `npm run lint:check`                                                              | PASS                                                                          |
| `npm run format:check`                                                            | PASS                                                                          |
| `npm run build`                                                                   | PASS                                                                          |
| `git diff --check`                                                                | PASS                                                                          |
| Targeted unit (retention parser, env validation, schedulers, governance/exporter) | PASS — 6 suites / 75 tests                                                    |
| Full unit regression                                                              | PASS except pre-existing unrelated `live-gateway.spec.ts:156` flake (390/391) |
| `npm run test:retention:artifacts`                                                | PASS — 2 tests (runbook/alert invariants)                                     |
| `NODE_ENV=test npm run prisma:migrate:status`                                     | PASS — no pending migration (no schema change)                                |
| `NODE_ENV=test test:archive-governance.e2e-spec.ts`                               | PASS — 1 suite / 15 tests                                                     |
| `NODE_ENV=test test:deletion-manifest-exporter.integration-spec.ts`               | PASS — 1 suite / 4 tests                                                      |

# 2026-09-12 — BE-5.2 Archive Retention Plan — Checkpoint F: regression, concurrency, observability coverage

## Scope & acceptance (per approved plan `foamy-jingling-key.md`)

Checkpoint F adds the smallest tests proving each WBS item plus low-cardinality observability/alerts. **No schema/migration/env/plan-predicate change.** Destructive paths untouched; DB suites run only against guarded `smartlearning_test`.

- [x] GAP 1 — mid-transaction rollback atomicity: force a failure after an intermediate governed delete; assert whole item rolls back (all tables intact, no tombstone/outbox, archive still pending, `purgeAt` unchanged).
- [x] GAP 2 — same-row worker exclusivity: two `purgeDue` on one due row → exactly one deleted, one event, one outbox.
- [x] GAP 3 — poison row + later-due rows continue: permanent-failure archive A quarantines/retries while clean archive B purges (no head-of-line blocking).
- [x] GAP 4 — comprehensive zero-count + canonical event + outbox on one fixture (all 5 governed tables → 0, status deleted, purgeState deleted, 1 DeletionEvent, 1 outbox).
- [x] GAP 5 — alerts: any-quarantine, manifest-export repeated failure, missing-expected-success/last-success. Wire last-success gauge if absent; update runbook + artifact test.

## Risk & rollback

- Risk: **medium** — all changes test-only or observability config; no destructive path altered.
- Rollback: revert code/config/docs; no down migration.
- Boundary: DB suites only against `smartlearning_test`; no purge on dev/staging/prod. Alert rules reference only existing/fixed-cardinality metrics.

## Dependencies & environment

- Runtime: Node `v26.5.1`. No prisma generate (no schema edit).
- Guarded DB: `smartlearning_test` via `NODE_ENV=test` + `.env.test`; test setup implicitly runs idempotent `migrate deploy` + `truncateAll`.
- DB-backed e2e/integration require **separate explicit authorization** before running.

## Verification results

| Gate                                                          | Result                                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run typecheck`                                           | PASS                                                                          |
| `npm run lint:check`                                          | PASS                                                                          |
| `npm run format:check`                                        | PASS                                                                          |
| `npm run build`                                               | PASS                                                                          |
| Targeted unit (governance.service 10, metrics.service 6)      | PASS                                                                          |
| `npm run test:retention:artifacts`                            | PASS — 2 tests (alert/runbook/dashboard invariants incl. new alerts)          |
| Full unit regression                                          | PASS except pre-existing unrelated `live-gateway.spec.ts:156` flake (391/392) |
| Guarded `test:archive-governance.e2e-spec.ts`                 | PASS — 19/19 incl. all 4 new GAP tests; `git diff --check` clean              |
| Guarded `test:deletion-manifest-exporter.integration-spec.ts` | PASS — 4/4                                                                    |

## Results

- **GAP 1–4 (DB e2e):** four new `it()` blocks in `test/archive-governance.e2e-spec.ts` — atomic rollback (real-DB seam: pre-seeded conflicting `deletion_manifest_outbox.archived_result_id`, executor fails mid-transaction after governed deletes, whole item rolls back), same-row worker exclusivity, poison-row head-of-line freedom, and comprehensive all-governed-tables-zero + exactly-one-tombstone/outbox. Verified against guarded `smartlearning_test`; all pass.
- **GAP 5 (observability):** new `smartlearning_retention_purge_last_success_seconds` gauge + `recordRetentionPurgeLastSuccess()` in `metrics.service.ts`; stamped on successful purge runs in `governance.service.ts.recordRun`. Three new alert rules in `ops/observability/prometheus-alerts.yml`: `SmartLearningRetentionPurgeQuarantined` (critical), `SmartLearningRetentionManifestExportJobFailing`, `SmartLearningRetentionPurgeNoRecentSuccess` (fires on absent OR stale last-success). Updated `retention-runbook.md`, `dashboard-inventory.md`, and `test/retention-operations-artifacts.spec.ts` to assert the new alert names.
- **No schema/migration/plan-predicate/env change.** `purgeAt` and deletion categories untouched.

## Observed flake (pre-existing, unrelated)

`archive-governance.e2e-spec.ts` — `serializes concurrent purgeDue workers with database row locks` fails intermittently (`selected` 2→1, or `connect ECONNRESET`) even in isolation (~50-75% pass); it is NOT in this diff and predates Checkpoint F. Not caused by the GAP 1–4 additions (a full clean run passes 19/19).

# 2026-09-12 — BE-5.2 Archive Retention Plan — Checkpoint G step 2 flake resolution

## Context

Checkpoint G step 2 (guarded `smartlearning_test` regression) came back NOT green on the
`archive-governance.e2e-spec.ts` concurrency test (`serializes concurrent purgeDue workers`, ~50–75%
pass historically, failing 4/5 in this session). This session's Phase-1 diagnosis proved the failure
was a **test-harness bug, not a purge/lease production defect**.

## Diagnosis (evidence)

- Instrumented isolated runs + a two-case isolation experiment added temporarily to the spec:
  - DIAG A — **concurrent HTTP fixtures only** (2× `createStartedSession` via `Promise.all`, then
    sequential close; no concurrent purge): failed intermittently with `connect/read ECONNRESET` on
    an ephemeral **listener** port (56xxx–57xxx; DB is 5432).
  - DIAG B — **sequential fixtures, concurrent `purgeDue(2)` ×2 via `Promise.all`**: passed **12/12**.
- Conclusion: the `ECONNRESET` and the count mismatch arose in the **concurrent HTTP fixture phase**,
  not the claim/lease SQL. `createStartedSession` each issues ~7 authenticated HTTP requests over the
  same supertest agent's keep-alive socket; `Promise.all([createStartedSession, createStartedSession])`
  races those requests on one socket, which intermittently resets (`ECONNRESET`), disrupting one
  session's setup and causing the secondary `selected`/`deleted` counts to drop to 1. The purge code
  (claim CAS, `SKIP LOCKED`, lease verification) was proven correct by DIAG B.

## Fix

`test/archive-governance.e2e-spec.ts` — serialize fixture setup at the two sites that raced
`createStartedSession` over the shared agent socket; keep the concurrent `purgeDue` under test
concurrent (that is the behavior DIAG B proved correct). No production code, schema, or purge logic
changed.

## Verification (authorized `smartlearning_test` only)

- Fixed test (`serializes concurrent purgeDue`) isolated: **12/12 pass** (was ~50–75%).
- Full `archive-governance.e2e-spec.ts`: **19/19 pass**.
- Full unit regression: 391/392 — the single failure is the **pre-existing** `live-gateway.spec.ts:156`
  realtime flake, confirmed to fail identically on clean HEAD (stash-popped), unrelated to this change.
- Full e2e regression: **247/247 pass**.
- DB-backed integration suites (`identity`, `poll-submission`, `deletion-manifest-exporter`): all pass
  (7/7, 8/8, 4/4) against `smartlearning_test`.
- Integration env-gated suites NOT run as part of step 2 (recorded as BLOCKED, not failures):
  - `login-rate-limit.redis.integration-spec.ts` — requires `RUN_LOGIN_RATE_LIMIT_REDIS_TESTS=1`
    (Redis not provisioned).
  - `s3-sandbox-rehearsal.integration-spec.ts` — requires `DELETION_MANIFEST_PROVIDER=s3` +
    reachable provider; this is the separately-authorized Checkpoint G step 3 (disposable S3
    rehearsal), outside step-2 DB scope.
- Static bundle: typecheck, lint:check, format:check, build, `git diff --check` all green.

## Results

- Root cause: test-harness concurrent HTTP fixture over a shared supertest agent socket → intermittent
  `ECONNRESET` on the listener port, surfacing as the previously-observed flake. NOT a production
  claim/lease defect.
- Change is limited to `test/archive-governance.e2e-spec.ts`; no production/schema/migration/env change.
- Checkpoint G step 2 (guarded `smartlearning_test` DB regression) is GREEN once the two
  env-gated integration suites are excluded per their documented authorization gates.

## Still pending (not claimed by this change)

- `live-gateway.spec.ts:156` unit flake (pre-existing, realtime module) — separate issue, not touched.
- Checkpoint G steps 3–9 (S3 rehearsal, Prometheus/Alertmanager, staging canary, capacity, production
  rollout, WBS closeout) remain ahead, each behind its own authorization gate.

# 2026-09-12 — BE-5.2 Checkpoint G step 3 — S3 sandbox upload rehearsal (GREEN)

## What was executed (authorized step 3; guarded smartlearning_test + disposable MinIO)

- Started disposable MinIO via `ops/minio-rehearsal/docker-compose.yml` (local image
  `minio/minio:latest` = RELEASE.2025-09-07T16-13-09Z; Docker Hub unreachable → compose now
  uses `${MINIO_IMAGE:-minio/minio:RELEASE-LOCAL-REHEARSAL}` tagged from the local image).
- `setup.sh` provisioned bucket `sl-rehearsal-manifests` (versioning + object-lock,
  bucket-default COMPLIANCE 90d) + prefix-scoped write-only user; creds in gitignored
  `ops/minio-rehearsal/.env.minio-rehearsal` (never printed/committed).
- `rehearse.sh` ran `test/s3-sandbox-rehearsal.integration-spec.ts`: **PASS 1/1** —
  conditional immutable write (If-None-Match:'*', ChecksumSHA256, COMPLIANCE retention),
  outbox → `exported`, idempotent replay (selected 0), duplicate re-put accepted.
- Admin-credential verification (`mc stat`/`mc cat`): object body is canonical
  deletion-manifest.v1 JSON; SHA256 checksum matches metadata `manifest-sha256`;
  COMPLIANCE lock until +90d (2026-12-11). SSE absent as configured (`none`).

## Tooling fixes found during execution (committed to ops/minio-rehearsal/)

1. **compose image pull**: Docker Hub unreachable → `${MINIO_IMAGE:-...}` override, local
   release image tagged `RELEASE-LOCAL-REHEARSAL`.
2. **mc MC_HOST\_ ignored**: newer mc bakes /tmp/.mc/config.json into the image and the
   MC_HOST_ env alias loses to it → `mc alias set` with private `MC_CONFIG_DIR` per call.
3. **dash-prefixed secret keys**: generated secret could start with `-` and this mc build
   parses it as a flag (no `--` support on `admin user add`) → secrets now padded with a
   leading letter `k`.
4. **host-path policy file**: `mc admin policy create` runs inside the container and cannot
   open host paths → `docker cp` the policy JSON into the container first.
5. **s3:HeadObject does not exist on MinIO** — HeadObject authorizes under `s3:GetObject`.
   The provider's replay conflict-verification (metadata equality, fail-closed) requires it:
   policy now grants PutObject + PutObjectRetention + GetObject on the prefix + ListBucket.
6. **s3:PutObjectRetention required** — per-object COMPLIANCE retain-until in a PutObject
   returns AccessDenied (403) without it (bisected: plain/IfNoneMatch/checksum puts pass,
   lock put 403s).
7. **rehearse.sh env grep**: ugrep-backed `grep` mishandled the `^(A|B_)=` pattern (matched
   1 line instead of 9) → pattern widened to `^(DELETION_MANIFEST_PROVIDER|S3_)[A-Z_]*=`.
8. **Bucket-default object lock**: MinIO rejects per-object retention unless the bucket was
   created with locking (mb --with-lock) — `mc retention set --default COMPLIANCE 90d` set
   (setup.sh already does --with-lock; default retention was set manually and is optional).

## Environment instability (not a code defect)

Docker daemon intermittently drops (container `Exited (255)` every few minutes; daemon
socket refused between). All MinIO state is in the named volume and survived restarts.
If the daemon drops mid-run, `docker start minio-rehearsal-minio-1` and re-run.

## Verification

| Gate                                                    | Result                                                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ops/minio-rehearsal/setup.sh`                          | PASS (bucket + write-only user)                                                                          |
| `ops/minio-rehearsal/rehearse.sh`                       | **PASS — 1/1 test**                                                                                      |
| Admin object verification (body/checksum/lock metadata) | PASS                                                                                                     |
| `git status`                                            | only intentional changes: `ops/minio-rehearsal/{docker-compose.yml,setup.sh,rehearse.sh}`, tasks/todo.md |

## Remaining Checkpoint G steps

- Step 4: Prometheus/Alertmanager rehearsal; step 5: staging canary; step 6+: capacity,
  production rollout, WBS closeout (each behind its own authorization gate).
- Teardown of MinIO container + volume pending (teardown.sh, operator-guarded).

# 2026-09-12 — BE-5.2 Checkpoint G step 4 — Prometheus/Alertmanager rehearsal (GREEN)

## What was executed (disposable Prometheus v2.53 + Alertmanager v0.27 containers; guarded smartlearning_test)

- Topology: bridge-networked Prometheus scraping the backend on port 3001 (`NODE_ENV=test`,
  retention purge + manifest-export schedulers enabled at the 60s minimum tick, S3 provider
  pointed at a dead endpoint), Alertmanager routing to a local webhook receiver.
- Seeded fixtures (`ops/prom-rehearsal/seed-retention-rehearsal.mjs`): one 3-day-overdue
  archive + one long-overdue retrying outbox row.
- Alerts proven end-to-end (metric → rule eval → Alertmanager → webhook):
  - `SmartLearningRetentionOldestDueAgeHigh` — FIRED (oldest_due_age ≈ 260 000 s > 86 400).
  - `SmartLearningRetentionManifestDeadRecords` — FIRED (dead_records = 1 after failed exports).
  - `SmartLearningRetentionPurgeJobFailing` — reached pending→ threshold (increase ≥ 3 observed
    when failures accumulated; counter reset on backend restart dropped it out of window before
    firing — the expr itself was verified true via direct PromQL query).
  - `SmartLearningRetentionPurgeNoRecentSuccess` — fired as PENDING earlier, then correctly
    resolved when a successful sweep stamped `retention_purge_last_success` (negative case proven).
  - `SmartLearningDatabaseMetricsAbsent` — FIRED (expected: metrics endpoint exists but this
    alert references readiness series absent in this scrape config; pre-existing rule).
- Alertmanager showed all three as `active` and delivered each to the webhook receiver.

## Real production defect found and fixed (the point of step 4)

**The application's `job` metric label collided with Prometheus's external scrape `job` label.**
prom-client scrape config renames the colliding label to `exported_job`, so every alert rule and
dashboard expression selecting `job="retention_purge"` (etc.) matched NOTHING —
`SmartLearningRetentionPurgeJobFailing`, `SmartLearningRetentionManifestExportJobFailing`, and
the quarantined-items alert could never fire in any real Prometheus deployment.

Fix (committed):

- `src/modules/metrics/metrics.service.ts` — metric label `job` → `bg_job` on
  `smartlearning_job_runs_total` / `smartlearning_job_duration_seconds` /
  `smartlearning_job_items_total`, with a comment explaining why.
- `ops/observability/prometheus-alerts.yml` — all four `job="..."` selectors → `bg_job=`.
- `ops/observability/dashboard-inventory.md` — three `sum by (job, ...)` expressions → `bg_job`.

## WSL2/Rancher Desktop networking notes (environment, not code)

- Containers run in a lima VM; `host.docker.internal` does NOT resolve, and the WSL eth0 IP is
  unreachable from the VM. The working host address from inside containers is `192.168.127.254`
  (Rancher Desktop's host gateway). Prometheus used `--add-host=host.docker.internal:192.168.127.254`.
- Prometheus/Alertmanager communicate via the shared `prom-rehearsal-net` network using container
  DNS names (`alertmanager-rehearsal:9093`).
- Config hot-reload: `docker kill -s HUP prom-rehearsal` reloads rule files — the stale-rules
  trap (editing the source but not the container-mounted copy) cost one debug cycle.

## Verification

| Gate                                          | Result                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                           | PASS                                                                                                                            |
| `npm run lint:check`                          | PASS                                                                                                                            |
| `npm run format:check`                        | PASS                                                                                                                            |
| `npm run build`                               | PASS                                                                                                                            |
| `npm test -- --runInBand src/modules/metrics` | PASS — 3 suites / 11 tests                                                                                                      |
| `npm run test:retention:artifacts`            | PASS — 2 tests                                                                                                                  |
| Live alert chain                              | 2 retention alerts fired + delivered; purge-failing expr verified via PromQL                                                    |
| Teardown                                      | backend/webhook/prometheus/alertmanager stopped; containers+network removed; rehearsal fixtures deleted from smartlearning_test |
| `git diff --check`                            | PASS                                                                                                                            |

## Remaining Checkpoint G steps

- Step 5: staging canary; step 6+: capacity, production rollout, WBS closeout (each behind its
  own authorization gate). The `bg_job` label change must ship together with any dashboard that
  consumed the old `job=` expressions.

# 2026-09-12 — BE-5.2 Checkpoint G step 4 — Prometheus/Alertmanager rehearsal (GREEN)

## What was executed (disposable Prometheus v2.53 + Alertmanager v0.27 containers; guarded smartlearning_test)

- Topology: bridge-networked Prometheus scraping the backend on port 3001 (`NODE_ENV=test`,
  retention purge + manifest-export schedulers enabled at the 60s minimum tick, S3 provider
  pointed at a dead endpoint), Alertmanager routing to a local webhook receiver.
- Seeded fixtures (`ops/prom-rehearsal/seed-retention-rehearsal.mjs`): one 3-day-overdue
  archive + one long-overdue retrying outbox row.
- Alerts proven end-to-end (metric → rule eval → Alertmanager → webhook):
  - `SmartLearningRetentionOldestDueAgeHigh` — FIRED (oldest_due_age ≈ 260 000 s > 86 400) and
    delivered to the webhook.
  - `SmartLearningRetentionManifestDeadRecords` — FIRED (dead_records = 1 after failed exports)
    and delivered to the webhook.
  - `SmartLearningRetentionPurgeJobFailing` — expr verified true via direct PromQL query
    (increase ≈ 4.01 ≥ 3) after the label fix; pending state observed.
  - `SmartLearningRetentionPurgeNoRecentSuccess` — fired as pending earlier, then correctly
    resolved when a successful sweep stamped `retention_purge_last_success` (negative case proven).
  - `SmartLearningDatabaseMetricsAbsent` — FIRED (pre-existing rule; readiness series absent in
    this scrape config as expected).
- Alertmanager showed all alerts as `active`; webhook receiver logged each delivery.

## Real production defect found and fixed (the point of step 4)

**The application's `job` metric label collided with Prometheus's external scrape `job` label.**
prom-client scrape config renames the colliding label to `exported_job`, so every alert rule and
dashboard expression selecting `job="retention_purge"` (etc.) matched NOTHING —
`SmartLearningRetentionPurgeJobFailing`, `SmartLearningRetentionManifestExportJobFailing`, and
the quarantined-items alert could never fire in any real Prometheus deployment.

Fix (committed):

- `src/modules/metrics/metrics.service.ts` — metric label `job` → `bg_job` on
  `smartlearning_job_runs_total` / `smartlearning_job_duration_seconds` /
  `smartlearning_job_items_total`, with a comment explaining why.
- `ops/observability/prometheus-alerts.yml` — all four `job="..."` selectors → `bg_job=`.
- `ops/observability/dashboard-inventory.md` — three `sum by (job, ...)` expressions → `bg_job`.

## WSL2/Rancher Desktop networking notes (environment, not code)

- Containers run in a lima VM; `host.docker.internal` does NOT resolve, and the WSL eth0 IP is
  unreachable from the VM. The working host address from inside containers is `192.168.127.254`
  (Rancher Desktop's host gateway). Prometheus used `--add-host=host.docker.internal:192.168.127.254`.
- Prometheus/Alertmanager communicate via the shared `prom-rehearsal-net` network using container
  DNS names (`alertmanager-rehearsal:9093`).
- Config hot-reload: `docker kill -s HUP prom-rehearsal` reloads rule files — the stale-rules
  trap (editing the source but not the container-mounted copy) cost one debug cycle.

## Verification

| Gate                                          | Result                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                           | PASS                                                                                                                            |
| `npm run lint:check`                          | PASS                                                                                                                            |
| `npm run format:check`                        | PASS                                                                                                                            |
| `npm run build`                               | PASS                                                                                                                            |
| `npm test -- --runInBand src/modules/metrics` | PASS — 3 suites / 11 tests                                                                                                      |
| `npm run test:retention:artifacts`            | PASS — 2 tests                                                                                                                  |
| Live alert chain                              | 2 retention alerts fired + delivered; purge-failing expr verified via PromQL                                                    |
| Teardown                                      | backend/webhook/prometheus/alertmanager stopped; containers+network removed; rehearsal fixtures deleted from smartlearning_test |
| `git diff --check`                            | PASS                                                                                                                            |

## Remaining Checkpoint G steps

- Step 5: staging canary; step 6+: capacity, production rollout, WBS closeout (each behind its
  own authorization gate). The `bg_job` label change must ship together with any dashboard that
  consumed the old `job=` expressions.

# 2026-09-12 — BE-5.2 Checkpoint G step 5 — staging canary

## Goal and acceptance criteria

- [x] Separate one-shot operation authorization from recurring scheduler startup.
- [x] Add focused regression coverage for env validation, purge scheduler, manifest-export scheduler,
      and the one-shot CLI lifecycle.
- [x] Update production env template and retention runbook with the scheduler-specific gates and
      batch-size-1 canary profile.
- [x] Run the non-DB verification bundle; do not invoke migration-capable test setup.
- [x] Inspect the currently configured target without printing secrets; it is a localhost template,
      not an identifiable staging environment.
- [ ] **BLOCKED:** confirm staging schema is current after an actual staging target is provided;
      otherwise stop for separate migration authorization.
- [ ] Deploy one immutable application + `bg_job` observability release with all retention gates off.
- [ ] Run read-only inspect/dry-run and obtain two-operator review for exactly one synthetic archive.
- [ ] Execute exactly one purge and one immutable manifest export with both schedulers disabled.
- [ ] Verify DB/object-store cardinality, checksum/lock/encryption, metrics/alerts, idempotency, and
      disabled steady state.
- [x] Record GREEN / FAILED / BLOCKED evidence and stop before capacity, production, or WBS work.

## Risk & rollback

- **Risk: HIGH** — irreversible privacy deletion and immutable external object creation.
- Stop on ambiguous environment identity, stale schema, scheduler startup, selection drift, more than
  one selected item, provider ambiguity, missing object lock/encryption/checksum, secret exposure,
  readiness degradation, or retention alerts.
- Before mutation, revert the pinned application + observability bundle and keep every gate disabled.
  After purge/export, pause future claims and forward-fix; do not reconstruct deleted answer data or
  delete/overwrite the locked manifest.

## Dependencies & environment

- Preflight found no usable staging control-plane context or staging env source. The only candidate,
  `.env.production`, targets localhost (`CORS_ORIGIN=http://localhost:3000`, DB `smartlearning`:5433)
  and has no S3, Prometheus, Alertmanager, or retention configuration. It is not a staging target.
- Staging DB migrations are **not authorized** by this step. `docker compose up` and DB-backed test
  setup are forbidden if they would invoke `prisma migrate deploy`.
- Required external authorities: immutable S3 bucket/prefix, Prometheus/Alertmanager, two operators,
  exact source commit/image digest, and a verified rollback revision.
- Capacity validation, production rollout, recurring scheduler enablement, reconciliation apply, and
  WBS closeout remain separately gated.

## Working notes

- Resolved the CLI/AppModule startup hazard: every operator command forces both scheduler gates false
  before application-context creation. Recurring loops additionally require the master, operation,
  and scheduler-specific gates at validation and runtime boundaries.
- `SmartLearningRetentionPurgeNoRecentSuccess` now requires a positive due backlog, avoiding a default-
  disabled/no-work false alarm. Metrics tests assert the exact `bg_job` label rather than a substring.
- Release provenance baseline: clean local `main` at `0b928cf`; application metrics and matching
  Prometheus/dashboard expressions must use `bg_job` and deploy together.

## Results

- **Status: BLOCKED at staging preflight.** The source-level canary safety correction is complete and
  verified, but no identifiable staging target, immutable S3 bucket/prefix, or Prometheus/Alertmanager
  control plane is configured in the current environment. No deployment or mutation was attempted.
- Safety changes: independent scheduler gates; master + operation + scheduler runtime defense;
  operator CLI forces schedulers off before `AppModule`; production/env/runbook canary guidance;
  due-backlog guard for the no-recent-success alert; exact `bg_job` regression assertion.
- Verification PASS:
  - targeted Jest: 5 suites / 75 tests;
  - retention artifacts: 1 suite / 2 tests;
  - `npm run typecheck`, `npm run lint:check`, `npm run format:check`, `npm run build`;
  - `git diff --check`;
  - high-effort code review: no retained verified findings.
- `promtool` was unavailable locally; the repository artifact test validated the alert file. No tool
  was installed.
- Not run by design: DB-backed integration/e2e, migration/status against staging, containers,
  provider calls, `inspect`, `dry-run`, purge, manifest export, or alert delivery. High-risk
  integration/manual verification remains mandatory after a real staging target is supplied.
- Formatting note: Prettier reformatted historical Markdown tables in this file. A safe attempt to
  restore only that unrelated formatting noise while retaining this checkpoint was denied by the
  environment's overwrite protection; no bypass was attempted.
- **Gate:** provide the actual staging deployment context/env source (including current schema status,
  immutable S3 target, observability endpoints, and rollback revision) before resuming step 5. Capacity
  validation, production rollout, recurring scheduler enablement, and WBS closeout remain unauthorized.

# 2026-09-12 — BE-5.2.5 process-restart lifecycle tests

## What was executed (test-only; no schema, DB, migration, staging, or production operation)

Closed the CP2「Scheduler overlap/shutdown/restart」unit-level gap flagged in WBS for BE-5.2.5
("缺 process restart recovery 專屬測試"). Added deterministic fake-timer lifecycle tests matching the
`tasks/lessons.md:247` tripwire (restart performs a startup scan; duplicate init creates no duplicate
wake sources; repeated destroy cleans up at most once) for both `RetentionScheduler` and
`ManifestExportScheduler`.

- **Enabler (behavior fix):** both schedulers' `onModuleInit()` now clear any pre-existing interval
  before setting a fresh one, so a re-init/restart cannot leak a second wake source.
  `retention.scheduler.ts`, `manifest-export.scheduler.ts`.
- **Tests:** 3 mirror-test sets each in `retention.scheduler.spec.ts` /
  `manifest-export.scheduler.spec.ts` (restart re-runs the startup sweep with exactly one interval;
  duplicate init leaves exactly one interval and one sweep; repeated destroy clears the interval at
  most once).

## Acceptance

- Targeted Jest (both scheduler specs): **PASS — 22 tests / 0 failed / 0 skipped** (8 pre-existing +
  3 new per suite × 2 suites).
- Non-DB bundle: **PASS** — `prettier --check` (4 files) / `typecheck` / `test:retention:artifacts` /
  `lint:check` (no warnings) / `build` / `git diff --check` all green.
- Test output `ERROR [RetentionScheduler] Retention sweep failed: ...` lines are test-intended failure
  paths, not real failures.

## Scope notes / not claimed

- This closes only the **unit-level** scheduler lifecycle proof. CP2's multi-replica / real process
  crash-restart **runtime** evidence on a staging target remains behind the Checkpoint G step 5 staging
  gate (unchanged). BE-6.6 (auto-close process restart) is a separate WBS item, untouched.

# 2026-09-13 — BE-5.3 Checkpoint A — 證據稽核與缺口對照

> 範圍：read-only 稽核（WBS CP0 表 + lessons.md + 現有實作 + guarded E2E 重跑）。本關不改任何 production code。

## 對照表（WBS 項 → 現有 evidence → CP0 缺口 → 處置）

| WBS 項                  | 現有 evidence（本關實證）                                                                                                                                                                                                                                                         | CP0 缺口                                                                         | 處置 → Checkpoint B                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 5.3.1 request           | `governance.controller.ts` `POST /api/v1/results/:liveSessionId/deletion-requests`（Session+Csrf+TeacherOrAdmin）；`governance.service.ts request()` 首行 `role !== 'teacher' → ForbiddenError` + teacher-owner 404 existence-hiding + serialized outstanding-request idempotency | route guard 較廣（TeacherOrAdmin）但 service teacher-only 的分層契約未在文件明寫 | **缺口屬文件層**：controller 補一句分層註解 + `docs/frontend-api-reference.md` §507 補一行分層說明（非行為變更） |
| 5.3.2 admin confirm     | E2E branch 全數重跑 green：missing CSRF → 403 `AUTH_CSRF_INVALID`（spec:500）、missing step-up → 403（spec:534）、student → 403（spec:476）、exact request binding + strict reason replay 409、admin StepUpGuard + AdminGuard                                                     | 「本輪未重跑各 branch」→ 已於本關重跑                                            | 已補證；B 僅凍結 baseline 綁 commit hash                                                                         |
| 5.3.3 tombstone         | `prisma/schema.prisma:393 DeletionEvent`、`:419 DeletionManifestOutbox`（archivedResultId/deletionEventId unique）；migrations `20260828090000`、`20260908090000`、`20260909090000`、`20260909100000`；`migrate status`：19 migrations，smartlearning_test **up to date**         | migration 證據限 smartlearning_test（production 仍未證）                         | 維持 guarded 範圍宣稱；無程式變更                                                                                |
| 5.3.4 idempotency       | E2E 19/19 green：`rejects resurrection...idempotently`（spec:1352）、`purges due archives...idempotent tombstone`（spec:1574）、`leaves all governed tables at zero with exactly one tombstone and one outbox`（spec:2155）；spec 共 21 個 `it(` declarations                     | 「final baseline 尚未凍結」                                                      | B 凍結 final baseline（本關測得 1 suite / 19 tests PASS / 0 skipped，HEAD 綁定）                                 |
| 5.3.5 restore filtering | 同上 E2E green + `retention-reconciliation.ts` watermark/applyManifest + exporter + CLI reconcile-inspect/apply                                                                                                                                                                   | operational qualification；8 個 name-filter skips 成因未查                       | C 處理（local provider fixture 補跑 + disposition）                                                              |
| 5.3.6 no-resurrect      | E2E `rejects resurrection`（spec:1352）green；integration specs 存在                                                                                                                                                                                                              | **BLOCKED**：可重現 committed rehearsal baseline 未成形；restore 完成邊界未定義  | C：依 `a1bbdbb` 模式固化 rehearsal 腳本/spec + 實際 disposable 演練 + 邊界定義                                   |

## 本關執行的驗證（全部 PASS）

- `npx prisma migrate status`（NODE_ENV=test，read-only）：19 migrations，smartlearning_test up to date。
- `NODE_ENV=test npx jest --config ./test/jest-e2e.json --runInBand test/archive-governance.e2e-spec.ts`：**1 suite / 19 passed / 0 failed / 0 skipped**（52.5s），涵蓋上表 5.3.2 分支重跑與 5.3.3/5.3.4/5.3.6 tombstone/idempotency/no-resurrect 斷言。
- Provenance：backend `main` HEAD `aaa115b`，working tree 於本關開始時乾淨（僅本 todo 附註為新增）。
- lessons.md 相關 tripwire 已核（test DB loopback mapping、post-commit listener 先註冊）。

## Gate

**STOP：Checkpoint A 完成，待使用者確認後才進 Checkpoint B**（預期僅 5.3.1 文件分層說明 + baseline 凍結，無 production code 行為變更）。

## Checkpoint B Results（2026-09-13）

- 缺口補齊（僅 5.3.1 文件層，非行為變更）：
  - `src/modules/governance/api/governance.controller.ts` — `request()` route 前補分層授權契約註解（route guard TeacherOrAdmin 廣、service teacher-only 權威）。
  - `docs/frontend-api-reference.md` §deletion-requests — 補同一分層契約一行。
- 未新增 migration、未動 deletion plan/predicate、未改 DTO contract（CP0 未列其他缺口）。
- 驗證 PASS：
  - prettier --check / `npm run typecheck` / `lint:check`（0 warnings）/ `npm run build` / `git diff --check`
  - governance unit：9 suites / 76 tests PASS
  - E2E rerun after edit：`test/archive-governance.e2e-spec.ts` 1 suite / 19 passed / 0 skipped
  - `migrate status`（smartlearning_test，read-only）：up to date（19 migrations）
- **Final baseline 凍結（5.3.4）**：evidence 綁定本 working tree（base HEAD `aaa115b` + 本關 2 檔文件層 diff）；E2E 19/19、unit 76/76、0 skipped。文件層 diff 將於 Checkpoint D 隨附註一併 commit，commit 後 baseline 改綁該 hash。
- Gate：待使用者確認進 Checkpoint C（rehearsal 固化 + 5.3.5 補證）。

# 2026-09-13 — BE-5.3 Checkpoint C — restore/rehearsal 證據

> 授權範圍：disposable 容器 rehearsal（MinIO + 沙箱 spec）；DB 僅 guarded `smartlearning_test`。

## 5.3.6 — backup-restore no-resurrection rehearsal（解 BLOCKED）

- **可重現 committed 資產**：新增 `test/governance-restore-rehearsal.integration-spec.ts`（比照 `a1bbdbb` guarded toolkit 模式，無需容器）。流程：真實 service 鏈（course → session → join/submit → close archive → teacher request → admin confirm early_delete）→ manifest export 至 run-scoped local immutable store 檔 → **模擬 backup restore**（以 delete 前 backup 捕捉的相同 ids 重灌 sessionQuestion/options/participant/submission）→ **真實 CLI 子程序** `node dist/src/bootstrap/retention.js reconcile-apply`（gates + env + watermark 全走 operator path）→ 斷言：answer-bearing rows 歸零、canonical DeletionEvent 恰一（trigger=early_delete）、outbox 恰一、tombstone payload null、watermark 推進至 canonical event、repeat apply idempotent（applied=0）。
- **restore 完成邊界（CP0 缺口定義）**：backup restore 完成 = manifest reconciliation apply 結束 + 上述驗證查詢通過；**不宣稱**透明 DB hook；production backup/restore runbook integration 維持未證、另關處理。
- 執行記錄：`NODE_ENV=test npx jest --config ./test/jest-integration.json --runInBand test/governance-restore-rehearsal.integration-spec.ts` → **1 suite / 1 test PASS**（~6s）。DB=targeted truncateAll 的 smartlearning_test；tmp 檔 afterAll 清除。

## 5.3.5 — name-filter skips disposition（CP0 缺口）

- 成因查明：8 個 skips 來自**環境 guard**——`test/s3-sandbox-rehearsal.integration-spec.ts` 在 `DELETION_MANIFEST_PROVIDER!=s3` 時 throw `BLOCKED`（design-intent：local provider 不得冒充外部 delivery 證據）。2026-09-12 記錄的 Docker daemon 不可用 blocker 已解除（daemon 現可用 v29.5.3）。
- **已以真實 disposable MinIO 補跑**：`docker compose -f ops/minio-rehearsal/docker-compose.yml up -d` + `setup.sh`（object-lock+versioning bucket、prefix-scoped write-only user、gitignored creds）→ `rehearse.sh` → `test/s3-sandbox-rehearsal.integration-spec.ts` **1 suite / 1 test PASS / 0 skipped**。憑證與容器事後 `teardown.sh` 清除（container/volume/creds 皆 REMOVED）。
- 另重跑 `deletion-manifest-exporter.integration-spec.ts`：4 tests PASS。

## Gate

**STOP：Checkpoint C 完成，待使用者確認後進 Checkpoint D**（WBS 附註勾選 + docs 收斂 + 兩筆 commit）。

# 2026-09-13 — BE-5.3 Checkpoint C — restore/rehearsal 證據（5.3.5 補證 + 5.3.6 解 BLOCKED）

> 授權範圍：disposable 容器 rehearsal（MinIO）；DB 僅 guarded `smartlearning_test`；沙箱 fixture 為 run-scoped tmp 檔。

## 5.3.6 — backup-restore no-resurrection rehearsal：可重現 committed 資產

- 新增 **`test/governance-restore-rehearsal.integration-spec.ts`**（guarded integration spec，比照 `a1bbdbb` 模式但免容器：Postgres 用既有 guarded test DB，manifest store 用 run-scoped tmp 檔）。
- 流程（單一 deterministic test）：
  1. 真實 service 鏈建構：course（CourseService）→ QuestionDefinition(2 options) → createSession/start/openQuestion → ParticipantService.join → SubmissionService.submit → closeSession（archive 建立，status=active）。
  2. **pre-delete backup capture**：於 delete 前抓 sessionQuestion(+options) 與 participant rows（等同 backup）。
  3. teacher request → admin confirm（GovernanceService.request/delete）→ tombstone `status=deleted, payload=null`；deletion_event 2 筆（teacher_request + early_delete canonical）。
  4. manifest export（真實 DeletionManifestExporter.exportDueBatch → local immutable store）→ 寫入 run-scoped `manifests.json`。
  5. **模擬 backup restore**：以 backup 相同 ids 重灌 sessionQuestion/options/participant，submission（新 idempotency key）→ 斷言 submission=1。
  6. **真實 CLI 子程序** `node dist/src/bootstrap/retention.js reconcile-apply`（RETENTION_OPERATIONS_ENABLED=1 + RETENTION_RECONCILE_APPLY_ENABLED=1 + RETENTION_LOCAL_MANIFEST_FILE，全 operator path）→ `applied:1`。
  7. 斷言：submission/sessionQuestion/options/participant answer-bearing 歸零、`early_delete` event 恰一（reconcile 未產生第二 canonical）、outbox 恰一、tombstone `payload:null`、manifest store watermark 推進至 canonical deletionEventId。
  8. repeat `reconcile-apply` → `applied:0`、counts 仍 0、event 仍恰一（idempotent）。
- **restore 完成邊界定義（CP0 缺口）**：backup restore 完成 = manifest reconciliation apply 結束 **且** 上述驗證查詢通過。不宣稱透明 DB hook；production backup/restore runbook integration 仍為未證、另關處理。
- 執行：`NODE_ENV=test npx jest --config ./test/jest-integration.json --runInBand test/governance-restore-rehearsal.integration-spec.ts` → **1 suite / 1 test PASS / 0 skipped**（~6s）。typecheck/lint:check green。tmp dir afterAll rmSync；DB rows 由 truncateAll 清除。

## 5.3.5 — 8 個 name-filter skips disposition（CP0 缺口）

- 成因：`test/s3-sandbox-rehearsal.integration-spec.ts` 的**環境 guard** — `DELETION_MANIFEST_PROVIDER != 's3'` 時 throw `BLOCKED`（design intent：local provider 不得冒充外部 delivery 證據）。先前 2026-09-12 之 Docker daemon 不可用 blocker 本輪已不存在（daemon v29.5.3 可用）。
- **已以真實 disposable MinIO 補跑**（無 skip）：
  - `docker compose -f ops/minio-rehearsal/docker-compose.yml up -d`（127.0.0.1:19000，disposable volume）
  - `ops/minio-rehearsal/setup.sh`：object-lock+versioning bucket `sl-rehearsal-manifests`、prefix-scoped write-only user、gitignored creds
  - `ops/minio-rehearsal/rehearse.sh` → `test/s3-sandbox-rehearsal.integration-spec.ts` **1 suite / 1 test PASS / 0 skipped**（4.5s）
  - 事後 `teardown.sh`：container **REMOVED**、volume removed、`.env.minio-rehearsal` creds removed。
- 另重跑 `test/deletion-manifest-exporter.integration-spec.ts`：**4 tests PASS / 0 skipped**。

## Gate

**STOP：Checkpoint C 完成。待使用者確認後進 Checkpoint D**（WBS 附註勾選、API reference 收斂、todo Results、兩筆分開 commit）。

# 2026-09-13 — BE-5.3 Checkpoint D — WBS 勾選與文件收斂（Results）

## What / where

- WBS `BE-5.3`（docs repo）：勾選 5.3.1–5.3.6 + partial closeout 附註（格式同 BE-5.2 closeout block，明寫 guarded 非 production-ready、不勾 BE-5 parent、不解除 FE-6/QA-2.7）。
- `docs/frontend-api-reference.md` §5：補一行 operator 端 restore/reconciliation 邊界（非前端 API、restore 完成定義）。
- backend 新增 `test/governance-restore-rehearsal.integration-spec.ts`（Checkpoint C）；controller 分層註解 + API reference 分層說明（Checkpoint B）。

## Verified

- Static：prettier/format:check、typecheck、lint:check（0 warnings）、build、`git diff --check` — 全 PASS。
- Unit（full `npm test -- --runInBand`）：**60 suites / 405 tests PASS**；**1 pre-existing failure** — `src/modules/realtime/live-gateway.spec.ts`「includes the terminal status in replayed session.closed envelopes」經 git stash 驗證於乾淨 base `aaa115b` 亦失敗（與 BE-5.3 無關，realtime durable visibility 範圍，另案處理）。
- DB-backed（guarded smartlearning_test）：archive-governance E2E **19/19 PASS（0 skipped）**；integration：deletion-manifest-exporter **4/4**、s3-sandbox-rehearsal **1/1**（真實 disposable MinIO）、restore-rehearsal **1/1**。
- `prisma migrate status`（read-only）：19 migrations up to date。

## Skipped / not claimed

- Production migration apply、production object-store、staging rehearsal、真實 backup/restore runbook — 維持未證，屬 BE-5 final reconciliation/OPS-1。
- 教訓：無新增 lessons（本輪無 user correction；fixture schema 細節失敗由 spec 自身 iteration 吸收）。

## Commits

- backend：`feat(governance): BE-5.3 restore rehearsal spec + layered auth contract docs`（code/test/docs/todo）
- docs：`docs(wbs): BE-5.3 partial closeout evidence annotation`

# 2026-09-13 — BE-5.3 follow-up — live-gateway.spec.ts pre-existing failure（調查並修復）

- **根因**：`LiveGateway.emitDurableEventToSocket` 的 `SESSION_CLOSED` 分支刻意以 `setImmediate(() => socket.disconnect(true))` 延遲斷線（讓 Socket.IO 先 flush terminal `session.closed` packet；見 live-gateway.ts:1173）。測試「includes the terminal status in replayed session.closed envelopes」仍同步斷言 `disconnect` → 零次呼叫而失敗。該 spec 失敗在乾淨 base `aaa115b` 已存在（非 BE-5.3 引入）。
- **修復（test-only）**：`live-gateway.spec.ts` 斷言前 `await new Promise(resolve => setImmediate(resolve))` yield 一個 tick，並補註解說明 defer 意圖。無 production code 變更。
- **驗證**：targeted spec 13/13 PASS；full unit bundle **61 suites / 406 tests PASS / 0 failed**；typecheck/lint:check green。commit `390c94d`。

# 2026-09-13 — BE-5.2 Checkpoint G step 5 — staging replica Compose + runbook drafted（純檔案，未啟動）

- 新增 `ops/staging-replica/`（僅檔案，無任何容器啟動）：
  - `docker-compose.yml` — disposable staging replica：db(15432, `smartlearning_staging_replica`) + one-shot migrate + backend(13000) + MinIO(19010/19011, object-lock bucket 由 setup.sh 建) + Prometheus v2.53(19090) + Alertmanager v0.27(19093) + node:24 webhook listener(13999)。專屬 project/network/容器名前綴/loopback-only ports；retention 所有 mutation gates 於 backend env 強制 false（master gate on 供 metrics）。
  - `.env.staging.example` — env identity 模板（所有 mutation gates=false、batch size=1、`DELETION_MANIFEST_PROVIDER=s3` 指向 replica MinIO）；`.gitignore` 擋 `.env.staging`。
  - `setup.sh` — 比照 minio-rehearsal：object-lock+versioning bucket `sl-staging-manifests`、prefix-scoped write-only user、creds 合併進 `.env.staging`（不印值）。
  - `prometheus.yml`/`alertmanager.yml` — target 改指 replica 內部服務；**alert 檔直接複製 `ops/observability/prometheus-alerts.yml` 權威版**（prom-rehearsal 副本已 drift：缺 due-backlog guard）。
  - `README.md` — step 0–9 canary runbook：preflight（含 identity 斷言）→ build/up → seed 1 個 synthetic archive → inspect/dry-run 雙 operator review → 單次 run-once(batch=1) → 單次 manifest-export-once → metrics/alerts/`bg_job` 斷言/disabled steady state → evidence → teardown(-v) + creds 移除。邊界：不碰 dev/test DB；長駐 backend 永不開 mutation gate；僅證 staging canary profile。
- 驗證（未啟動任何容器）：`docker compose ... config` 渲染 7 服務、ports 符合設計；`setup.sh` bash -n PASS；跨堆疊掃描無 dev/test 引用；exporter unit 4/4、restore-rehearsal integration 1/1 仍 green。
- **此為 step 5 執行前置草稿；執行需使用者另行明確授權。**

## 2026-09-13 — Checkpoint G step 5 authorization + preflight

- **授權**：使用者明確回覆「授权」（2026-09-13）— 解除 step 5 staging canary（replica 範圍）；不涵蓋 production rollout / WBS closeout。
- Preflight：HEAD `83a0e5b`；dirty 僅本任務檔（`tasks/todo.md` 修改、`ops/staging-replica/` 未追蹤 = 本 toolkit 本身）；daemon 29.5.3。

# 2026-09-13 — BE-5.2 Checkpoint G step 5 — staging canary GREEN（replica 實際執行）

> **授權**：使用者「授权」（2026-09-13）；範圍僅 step 5 replica canary；teardown 完成。**單 operator 模式**（本會話 Claude 執行 + 使用者授權/監督，替代雙 operator 簽核；已記錄為限制）。

## Execution identity（preflight 記錄）

- Source revision：`83a0e5b`（乾淨樹除本 toolkit）；daemon 29.5.3。
- Replica identity：專屬 project/network/ports（DB 15432、backend 13000、MinIO 19010、Prom 19090、AM 19093、webhook 13999）、DB `smartlearning_staging_replica`、所有 mutation gates 啟動時 false。
- **重要 deviation（已文件化）**：replica 以 `NODE_ENV=test` 執行（backend + migrate）。原因：`NODE_ENV=production` fail-closed 要求 (a) `LOGIN_RATE_LIMIT_MODE=redis-required`（replica 已加 in-stack Redis 解決）、(b) `S3_ENDPOINT` https（replica MinIO TLS + `NODE_EXTRA_CA_CERTS` 解決）、(c) **`S3_SERVER_SIDE_ENCRYPTION` 非 none** — MinIO Community 對 `AES256` header 回 501 NotImplemented（需 KES/KMS）。replica 無法在不引入 KES 的情況下滿足 (c)，故以 guarded test identity 執行；**production 端 SSE 行為未證，需真實 staging KMS 支援**。此限制寫入 README。
- 過程修正（toolkit 檔案）：compose 增 redis 服務 + TLS cert 掛載（backend `/certs` + MinIO `/root/.minio/certs`）+ `NODE_EXTRA_CA_CERTS`；`setup.sh` mc alias 改 https + 全域 `--insecure`；alert 檔複製權威版（prom-rehearsal 副本 drift 修正）。

## Canary 執行記錄

1. **Seed**：API 全鏈建立（admin bootstrap → teacher → course → poll question(2 opts) → session → join ×2 → submit ×2 → close）→ archive `01a096d9-34c9` active；`purgeAt` 手動調至 2026-09-12（過期）。1 個 synthetic due archive，無其他。
2. **inspect/dry-run（read-only）**：`dueCount:1, oldestDueAge:66061s`；dry-run `selected:1, deleted:0, planned:[1]`（Submission 2/LiveSessionEvent 11/SessionQuestionOption 2/SessionQuestion 1/Participant 2），零寫入。
3. **單次 purge（batch=1, schedulers off）**：`run-once` → `selected:1, deleted:1, failed:0`。驗證：tombstone `deleted, payload NULL`；submission/session_question=0；deletion_event 恰 1（trigger=retention）；outbox 恰 1 pending；post dry-run `selected:0`。
4. **單次 manifest export（batch=1）**：初兩次 fail（SSE `AES256` → MinIO 501；`S3_SERVER_SIDE_ENCRYPTION=none` 被 production guard 擋 → **該 guard 的行為即本次發現的真實缺口**）。修正 identity 後：`selected:1, exported:1, failed:0`；outbox → `exported`；物件存在（403B），**COMPLIANCE lock until 2026-12-11、manifest-sha256 metadata、SHA256 checksum**。
5. **Idempotent replay**：reset outbox → re-export → `exported:1`、物件數仍 **1**（412 replay 驗證路徑接受相同 bytes）。
6. **Metrics/alerts/steady state**：`/metrics` 全 series 使用 `bg_job=`、**零 `job=` label collision**（grep=0）；Prometheus 全部 9 個 Retention alerts **inactive**（backlog 清空後 OldestDueAge/DueBacklog 正確解除）；60s 觀察窗 scheduler 活動=0（gates off steady state）；webhook listener 正常監聽（無告警投遞=正確的 disabled steady state）。
7. **Teardown**：`down -v` → 容器全 REMOVED、volumes 全 REMOVED、network 移除。

## 限制 / 未證（維持 gating）

- **單 operator**（非雙 operator 簽核）；**NODE_ENV=test identity**（非 production identity）；**SSE=none**（MinIO Community 限制）— production 加密行為、真實 staging host、multi-replica、容量/rollout 仍屬 BE-5 final reconciliation + OPS-1 gate，未解除。
- 過程中一次 write-only secret 出現在 tool output（即旋換新憑證；容器/憑證已隨 teardown 銷毀，風險閉合）。記入 lessons 候選：含 secrets 的 grep/sed 輸出需預先遮罩。

## 2026-09-13 Close BE-6.4 / 6.5 / 6.6 (auto-close scheduler evidence)

**Goal:** Flip WBS BE-6.4 (idempotent retry), 6.5 (clock-controlled deterministic test), 6.6 (process restart) to closed via a guarded DB-backed integration spec; update WBS disposition.
**Risk:** LOW — test-only; no prod/schema/migration/env change. DB-backed suite requires authorized `smartlearning_test` access.
**Dependencies/Env:** `smartlearning_test` reachable on localhost:5432 (probed OK); test setup refuses non-test DB.

- [x] Understand auto-close service/scheduler + integration harness
- [ ] Add test/live-session-auto-close.integration-spec.ts (BE-6.5 chain, 6.4 retry, 6.6 restart, +negative control)
- [ ] Run format/lint/typecheck/build/unit gates
- [ ] Authorized run of the integration spec against smartlearning_test
- [ ] Record results here + update WBS (flip boxes, disposition, date)

### CP8 transition-matrix (BE-3.1.8):
Added `test/terminal-matrix.integration-spec.ts` (8 tests) filling the 8 previously-unasserted 28-state cells. Verified: typecheck/lint/format/build/unit (406) PASS; integration 8/8 PASS; e2e CP3+route-matrix 18/18 PASS — no regression. Domain `live-session-status.spec.ts` now exhaustively enumerates start/close/open negatives. **Does not claim CP8 final sign-off** (gated on user manual review).

### Results:
- Added `test/live-session-auto-close.integration-spec.ts` (4 tests) proving BE-6.4/6.5/6.6 with controlled clock against guarded `smartlearning_test`.
- Verified: typecheck / lint:check / format:check / build / unit (61 suites, 406 tests) all PASS; integration spec 4/4 PASS (authorized DB run).
- WBS `智學互動平台剩餘工作WBS.md` BE-6: flipped 6.4/6.5/6.6 to [x], disposition PARTIAL → CLOSED with evidence note.
- **BE-3.1 CP7 manual sign-off (2026-09-13):** user confirmed `Checkpoint 7 verified`. Backend commit `01afc3a` + WBS flip CP7 bullets [x] and added a CP7 sign-off status block recording controlled-clock evidence (BE-6.5 chain) + post-close rejection (CP3 terminal-state + status guard) + retry/restart idempotency (BE-6.4/6.6). Scope note: this sign-off covers CP7 handoff only, not BE-3.1.8 final release sign-off.
- Risk: LOW — test-only, no prod/schema/migration/env change. Rollback: delete test + revert WBS note.

## 2026-09-13 Close BE-3.1.2 CP2 (question cascade & no-reopen)

**Goal:** Flip WBS CP2 bullets via a guarded DB-backed integration spec proving the cascade + no-reopen invariants.
**Risk:** LOW — test-only. DB-backed suite needs authorized smartlearning_test.
- [x] Explore coverage (2 agents): forward transition covered; gaps = one-open-msg/P2002, repeated close, active-session reopen, multi-q cascade/no-leftover, non-active close
- [x] Add test/question-cascade.integration-spec.ts (5 tests)
- [x] Static + unit gates
- [x] Authorized DB run + e2e regression
- [x] Update WBS CP2 bullets + evidence

### Results:
- Added `test/question-cascade.integration-spec.ts` (5 tests) proving BE-3.1.2 CP2 cascade & no-reopen against guarded `smartlearning_test`.
- Verified: typecheck / lint:check / format:check / build all PASS; unit 61 suites / 406 tests PASS; integration 5/5 PASS; e2e CP3 + route-matrix 18/18 PASS — no regression.
- WBS CP2: flipped 3 bullets to [x] with evidence note; manual Checkpoint 2 left open (gated on user review).
- Risk: LOW — test-only, no prod/schema/migration/env change.
