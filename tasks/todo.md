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

| 命令 | 結果 |
|------|------|
| `NODE_ENV=development npm run prisma:migrate:deploy` | ✅ 套用 `20260815174233_add_identity_and_course` 至 `smartlearning_dev` |
| `NODE_ENV=development npm run prisma:migrate:status` | ✅ Database schema is up to date |
| `NODE_ENV=test npm run prisma:migrate:status` | ✅ Test database schema is up to date |
| `npm run prisma:generate` | ✅ Prisma Client 7.9.1 generated |
| `npm run prisma:validate` | ✅ schema valid |
| `npm run typecheck` | ✅ 通過 |
| `npm run lint:check` | ✅ 通過（0 errors） |
| `npm run format:check` | ✅ All matched files use Prettier code style |
| `npm run build` | ✅ nest build 通過 |
| `npm test -- --runInBand` | ✅ 5 suites / 18 tests passed |
| `npm run test:e2e -- --runInBand test/auth-courses.e2e-spec.ts` | ✅ 1 suite / 10 tests passed |
| `npm run test:e2e -- --runInBand` | ✅ 2 suites / 12 tests passed |
| `npm run test:integration -- --runInBand` | ✅ 2 suites / 6 tests passed |

## 結果

- Phase 0：《M2 關鍵技術決策》文件存在，11 項紅卡定案，作為 Phase 2+ 設計前提。
- Phase 1：fresh checkout 流程（README Quick start）可 prisma:generate → migrate:deploy → start:dev → health check；typecheck/lint/format/build/test/e2e/integration 全綠。
- 本次續作：Identity/Course 垂直切片 migration 已套用至 `smartlearning_dev`；advisory lock、URI version、auth error/guard semantics、test cookie defaults 已修正，完整 unit/integration/e2e 驗證全綠。
- 已知非阻擋警告：Nest/path-to-regexp 仍提示 `health/(.*)` 與 `/api/*` legacy route pattern，後續可改為 named wildcard syntax。
- 後續：完成 Phase 2 前置的完整 M2 設計文件（至少 #1 領域分析、#3 ERD、#4 Web Auth），並將 `tasks/lessons.md` 的 tripwire 納入後續實作檢查。

## Lessons

- jest 自動設 `NODE_ENV=test`，會使 env 驗證走 `.env.test`；`.env.test` 的 PORT 不可為 0（@Min(1) 會 fail fast）。測試專用 env 需用合法可用 port。
- NestJS URI versioning 的 `defaultVersion` 會套用到所有 controller（含被 `setGlobalPrefix` exclude 的）；health 需標 `@Version(VERSION_NEUTRAL)` 並 exclude prefix 才能置於 `/health/*`。
- Prisma 7 generated client 匯入路徑為 `generated/prisma/client`（非 `@prisma/client`）；`Prisma` namespace（含 `PrismaClientKnownRequestError`、`TransactionClient`）從該處匯出。
- `@nestjs/swagger@11.4.6` 帶入脆弱的 transitive js-yaml（DoS）；Phase 1 不需 OpenAPI，移除以保 `npm audit` 乾淨；完整定義留後續設計階段再加回並鎖定安全版本。
- ConfigModule `validate` hook（而非 `load`）才能在 dotenv 載入 envFilePath 後驗證已解析的 env，避免 `configuration()` 在 env 載入前跑而讀到空 process.env。
- 本次 auth/course e2e 回歸的失敗模式、檢測訊號與防止規則已整理於 `tasks/lessons.md`。