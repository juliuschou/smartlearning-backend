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

| Command | Result |
| --- | --- |
| `NODE_ENV=test npm run prisma:migrate:deploy` | PASS — applied `20260816100000_add_step_up_at` to `smartlearning_test` |
| `NODE_ENV=test npm run prisma:migrate:status` | PASS — database schema up to date |
| `npm run prisma:generate && npm run prisma:validate` | PASS — Prisma Client 7.9.1 generated; schema valid |
| `npm test -- --runInBand` | PASS — 12 suites / 47 tests |
| `npm run test:integration -- --runInBand test/identity.integration-spec.ts` | PASS — 1 suite / 5 tests |
| `npm run test:e2e -- --runInBand test/auth-courses.e2e-spec.ts` | PASS — 1 suite / 14 tests |
| `npm run typecheck` | PASS |
| `npm run format:check` | PASS |
| `npm run lint:check` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |

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

| Command | Result |
| --- | --- |
| `npm run prisma:generate` | PASS — Prisma Client 7.9.1 generated |
| `npm run prisma:validate` | PASS — schema valid |
| `NODE_ENV=test npm run prisma:migrate:status` | PASS — PostgreSQL `smartlearning_test`, 7 migrations, schema up to date |
| `npm test -- --runInBand src/common/crypto/uuid.spec.ts src/modules/questions/domain/poll-single-choice.spec.ts src/modules/participants/domain/display-name.spec.ts src/common/observability/pino-redaction.spec.ts` | PASS — 4 suites / 15 tests |
| `npm test -- --runInBand` | PASS — 16 suites / 63 tests |
| `npm run test:integration -- --runInBand test/poll-submission.integration-spec.ts` | PASS — PostgreSQL-backed, 1 suite / 4 tests, 0 skipped |
| `npm run test:e2e -- --runInBand test/poll-single-choice.e2e-spec.ts` | PASS — PostgreSQL-backed, 1 suite / 1 test, 0 skipped |
| `npm run typecheck` | PASS |
| `npm run lint:check` | PASS |
| `npm run format:check` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |

Targeted verification is complete against real PostgreSQL; the full repository unit/integration/e2e suites were not run. The migration setup applies all seven migrations idempotently, and the poll suites fail loudly rather than treating an unavailable or stale database as a skip.

### 2026-08-16 — Frontend baseline assessment + backend follow-up backlog

#### 背景

使用者目標:以目前後端為基準,推進前端三個產品流程 —(A)老師出題、(B)課堂中使用(老師端)、(C)學員課堂中使用。本節記錄可立即對接的部分、前端整合陷阱,以及需後端補強才能完成三流程的 follow-up backlog 與優先序。來源證據:現有 controller/DTO/e2e 程式碼 + `tasks/todo.md` 既有 deferred scope 註記 + sibling `docs/智學互動平台/` M2 設計文件(target contract,非已實作)。

#### 前端可立即對接的能力(基準部分,已由 e2e 驗證)

| 前端功能 | 可用 API | 備註 |
| --- | --- | --- |
| 登入/登出/改密/身分 | `POST /auth/login`、`POST /auth/logout`、`POST /auth/change-password`、`GET /auth/session` | cookie session + CSRF double-submit |
| 課程管理 | `POST/GET/GET/:id /courses`、`POST /courses/:id/archive` | 分頁回傳 `Page<CourseDto>` |
| 老師出題(單選) | `POST /courses/:courseId/questions` | 只支援 `poll`+`single`,2–10 選項,僅 draft 課程可加 |
| 開課堂 | `POST /live-sessions`、`POST /:id/start` | start 產生不可變 snapshot |
| 課堂中控制收/開題 | `POST .../questions/:qid/open`、`.../close` | 同一時間只能一題 open |
| 學員加入 | `POST /live-sessions/:sessionCode/join` | 公開;participant token 只回傳一次 |
| 學員看題 | `GET /live-sessions/:id/snapshot` | participant 只看到 open 題 + `hasSubmitted` |
| 學員答題 | `POST /live-sessions/:id/submissions` | 需 `X-Participant-Token` + `Idempotency-Key`(UUID) |

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
- [ ] **S-5** 封存/保留:`POST /live-sessions/:id/archive` → ArchivedResult + 90 天保留 + 早刪/tombstone(依《即時同步與結果治理設計》)。需 S-1 先完成。

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

| 命令 | 結果 |
| --- | --- |
| `npm install` + `npm audit` | ✅ 0 vulnerabilities;js-yaml 全 5.3.0 |
| `npm run typecheck` | ✅ 通過 |
| `npm run lint:check` | ✅ 0 errors |
| `npm run format:check` | ✅ All matched files use Prettier code style |
| `npm run build` | ✅ nest build 通過 |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/openapi.e2e-spec.ts` | ✅ 1 suite / 3 tests |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/app.e2e-spec.ts test/api-envelope.e2e-spec.ts` | ✅ 2 suites / 6 tests |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/auth-courses.e2e-spec.ts test/poll-single-choice.e2e-spec.ts` | ✅ 2 suites / 15 tests(DB-backed,無回歸) |

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

| 命令 | 結果 |
| --- | --- |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/questions-read.e2e-spec.ts` | ✅ 1 suite / 9 tests |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/poll-single-choice.e2e-spec.ts` | ✅ 1 suite / 1 test(無回歸) |
| typecheck/lint/format/build | ✅ 全綠 |

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

| 命令 | 結果 |
| --- | --- |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/questions-mutation.e2e-spec.ts` | ✅ 1 suite / 9 tests |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/questions-read.e2e-spec.ts` | ✅ 1 suite / 9 tests(無回歸) |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/poll-single-choice.e2e-spec.ts` | ✅ 1 suite / 1 test(無回歸) |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/openapi.e2e-spec.ts` | ✅ 1 suite / 3 tests(新端點進 spec) |
| typecheck/lint/format/build | ✅ 全綠 |

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

| 命令 | 結果 |
| --- | --- |
| `npm test -- --runInBand src/modules/questions/domain/question-contract.spec.ts src/modules/questions/domain/poll-single-choice.spec.ts` | ✅ 2 suites / 21 tests |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/questions-types.e2e-spec.ts test/questions-read.e2e-spec.ts test/questions-mutation.e2e-spec.ts test/poll-single-choice.e2e-spec.ts test/openapi.e2e-spec.ts` | ✅ 5 suites / 30 tests |
| typecheck/lint/format/build | ✅ 全綠 |

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

| 命令 | 結果 |
| --- | --- |
| `NODE_ENV=test npm run prisma:migrate:deploy`(20260816160000,授權套用至 `smartlearning_test`) | ✅ 8 migrations,新表建成 |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/cli-credential.e2e-spec.ts` | ✅ 1 suite / 6 tests |
| 既有回歸(auth-courses/poll/openapi/questions-read/mutation/types) | ✅ 6 suites / 44 tests |
| canonical-hash unit | ✅ 7 tests |

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

| 命令 | 結果 |
| --- | --- |
| `npm run typecheck` | ✅ 通過 |
| `npm run lint:check` | ✅ 0 errors |
| `npm run format:check` | ✅ All matched files use Prettier code style |
| `npm run build` | ✅ nest build 通過 |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/question-batches.e2e-spec.ts` | ✅ 1 suite / 7 tests |
| `NODE_ENV=test npm run test:e2e -- --runInBand`(auth-courses/poll/openapi/questions-read/mutation/types/cli-credential/question-batches) | ✅ 8 suites / 57 tests |
| `npm test -- --runInBand` | ✅ 18 suites / 86 tests |
| `NODE_ENV=test npm run test:integration -- --runInBand` | ✅ 3 suites / 10 tests |
| `git diff --check` | ✅ PASS |

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

| 命令 | 結果 |
| --- | --- |
| `npm test -- --runInBand src/modules/live-sessions/domain/question-results.spec.ts` | ✅ 1 suite / 12 tests |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/live-session-results.e2e-spec.ts` | ✅ 1 suite / 11 tests |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/poll-single-choice.e2e-spec.ts test/live-session-close-cancel.e2e-spec.ts` | ✅ 2 suites / 7 tests(無回歸) |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/openapi.e2e-spec.ts` | ✅ 1 suite / 3 tests(新 route 進 spec) |
| `npm test -- --runInBand`(全 unit) | ✅ 19 suites / 99 tests |
| `npm run typecheck` / `lint:check` / `format:check` / `build` / `git diff --check` | ✅ 全綠(format 修 6 檔 Prettier) |

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

| 命令 | 結果 |
| --- | --- |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/live-session-detail.e2e-spec.ts` | ✅ 1 suite / 9 tests |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/live-session-results.e2e-spec.ts test/live-session-close-cancel.e2e-spec.ts test/poll-single-choice.e2e-spec.ts` | ✅ 3 suites / 18 tests(無回歸) |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/openapi.e2e-spec.ts` | ✅ 1 suite / 3 tests(新 route 進 spec) |
| `npm run build` | ✅ nest build 成功 |
| `npm run typecheck` / `lint:check` / `format:check` | ✅ 全綠 |

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

| 命令 | 結果 |
| --- | --- |
| `npm install` + `npm audit` | ✅ 0 vulnerabilities |
| `npm run typecheck` | ✅ PASS |
| `npm run lint:check` | ✅ 0 errors |
| `npm run format:check` | ✅ All matched files use Prettier |
| `npm run build` | ✅ nest build PASS |
| `npm test -- --runInBand src/modules/realtime/live-session-event-bus.spec.ts` | ✅ 1 suite / 5 tests |
| `npm test -- --runInBand`(全 unit) | ✅ 20 suites / 104 tests |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/live-session-realtime.e2e-spec.ts` | ✅ 1 suite / 9 tests(DB-backed, 0 skipped) |
| `NODE_ENV=test npm run test:e2e -- --runInBand`(全 e2e) | ✅ 14 suites / 98 tests(無回歸) |
| `NODE_ENV=test npm run test:integration -- --runInBand` | ✅ 3 suites / 10 tests |
| `NODE_ENV=test npm run prisma:migrate:status` | ✅ 8 migrations, schema up to date(無新 migration) |
| `git diff --check` | ✅ PASS |

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

| 命令 | 結果 |
| --- | --- |
| `npm install` + `npm audit` | ✅ 0 vulnerabilities |
| `npm run typecheck` | ✅ PASS |
| `npm run lint:check` | ✅ 0 errors |
| `npm run format:check` | ✅ All matched files use Prettier |
| `npm run build` | ✅ nest build PASS |
| `npm test -- --runInBand src/modules/realtime/live-session-event-bus.spec.ts` | ✅ 1 suite / 5 tests |
| `npm test -- --runInBand`(全 unit) | ✅ 20 suites / 104 tests |
| `NODE_ENV=test npm run test:e2e -- --runInBand test/live-session-realtime.e2e-spec.ts` | ✅ 1 suite / 9 tests(DB-backed, 0 skipped) |
| `NODE_ENV=test npm run test:e2e -- --runInBand`(全 e2e) | ✅ 14 suites / 98 tests(無回歸) |
| `NODE_ENV=test npm run test:integration -- --runInBand` | ✅ 3 suites / 10 tests |
| `NODE_ENV=test npm run prisma:migrate:status` | ✅ 8 migrations, schema up to date(無新 migration) |
| `git diff --check` | ✅ PASS |

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
- [ ] `live-gateway.ts`：cookie 不再一律走 teacher path；role=student 走 participant binding path（join `session:<id>` room，不進 teacher room）；`AuthenticatedClient` 加 student/participant-account 表達。
- [ ] snapshot 分支對應調整；學生收 `result.updated`、不收 `counts.updated`。
- [ ] 順便統一 gateway participant snapshot 與 REST participant snapshot（只保留 open + hasSubmitted）。
- [ ] 測試：student cookie handshake 進 participant room、收 result、不收 counts。

### B5 — 隱私 / redaction / 設計文件
- [ ] `pino-redaction.ts` 評估補 student profile/credential 欄位。
- [ ] open_text results 維持匿名（不回 displayName/token）。
- [ ] close 後 results 投影匿名；CourseEnrollment 關係保留（本期不做歷史查詢）。
- [ ] 更新設計文件「無學員帳號」限制與 authorization matrix（`docs/.../Web Auth...`、`Backend NestJS 實作規劃.md:188-193`、`P0 核心需求基線.md`、`SPEC.md R-F5-5`、`BDD 場景.md`）。

## Phase B 驗證（DoD）
- student 可登入、加選、看名冊/我的課、cookie 加入 session 並作答；匿名 session code fallback 保留（e2e 通過）。
- realtime：student 進 participant room、收 `result.updated`、不收 `counts.updated`（e2e 通過）。
- 權限 regression：student 存取 owner 路徑被拒。
- `prisma:validate`、相關 unit/integration/e2e、`openapi.e2e-spec.ts` 通過。
- 設計文件同步更新。
