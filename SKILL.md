# SKILL.md — SmartLearning Backend

> 智學互動平台 後端服務。本文件由 git commit 歷史與 README 整理而成，
> 描述此專案的技術棧、架構、開發流程與開發時應遵守的不變量（invariants）。
> 適用於任何要在這個 codebase 進行實作、除錯、或擴充功能的 AI coding agent。

---

## 1. 專案概要

NestJS 11 後端服務，為「智學互動平台」提供 REST + Socket.IO 即時課堂互動 API。
技術定位為 production-oriented baseline：具備設定驗證、結構化日誌（Pino）、
Prisma/PostgreSQL、安全標頭、request ID、統一錯誤信封、health probes，
以及生產與測試共用的 bootstrap。

設計前提文件：`docs/智學互動平台/30_系統設計/M2 關鍵技術決策.md`。

### 技術棧
- **Runtime**：Node.js（`@types/node` 22）、npm（無 yarn/pnpm）
- **Framework**：NestJS 11、Express、Socket.IO 4
- **ORM/DB**：Prisma 7 + PostgreSQL 14+（pg adapter）
- **Auth**：Web Session（opaque cookie token，Argon2id 密碼雜湊、SHA-256 token hash）、CSRF double-submit、CLI credential（X-CLI-Key）
- **驗證**：class-validator + class-transformer、ValidationPipe
- **API 文件**：@nestjs/swagger 11.4.6（`/api/docs` UI、`/api/docs-json` JSON only）
- **日誌**：nestjs-pino + pino-http（含 redaction paths）
- **安全**：helmet、cookie-parser、嚴格 CORS allowlist

---

## 2. 專案結構

```
src/
  main.ts                      # Bootstrap：logger + configureApplication(+Swagger)
  app.module.ts                # Root module：ConfigModule + Logger + Prisma + 各 feature module
  bootstrap/configure-app.ts   # 共用 app 設定（prefix/versioning/pipes/filters/helmet/CORS）
  config/                      # env validation + typed configuration
  common/
    errors/                     # DomainError + 穩定錯誤碼 + API envelope
    http/                       # GlobalExceptionFilter + request-id middleware + ApiResponseInterceptor
    observability/              # Pino redaction paths
    clock/                      # Clock abstraction（System/Fake）
    crypto/                     # Argon2id、UUID v7、token hash、constant-time compare
    security/                   # cookie options、CSRF/Origin helpers
    auth/                       # guards（Session/StepUp/CSRF/Participant/CliAuth/BatchActor 等）
    pagination/                 # pagination types/helpers
  prisma/                       # PrismaService + TransactionService（lock/error helpers）
  modules/
    health/                     # /health/live + /health/ready
    identity/                   # 帳號/角色/狀態、login、session、step-up、CLI credential、admin
    courses/                    # 課程 CRUD、archive、owner-immutable
    questions/                  # 題目 authoring（read/mutation/types/batch validate+confirm）
    live-sessions/              # 課堂 session 生命週期、題目激活、結果聚合、detail/close/cancel
    participants/               # 參與者加入、token、結果端點
    submissions/                # 作提交、idempotency、answer contract、results reveal
    realtime/                   # Socket.IO /live namespace + in-process event bus
prisma/
  schema.prisma
  migrations/                   # additive，手寫 CHECK/raw SQL 允許
  seed.ts
test/
  setup/                        # app-factory.ts（重用 production bootstrap）+ db.ts
  *.e2e-spec.ts / *.integration-spec.ts / *.spec.ts
generated/                      # Prisma client output（gitignored）
tasks/                          # todo.md、lessons.md（檔案式任務追蹤）
```

每個 feature module 採三層切片：`api/`（controller + dto）→ `application/`（service）→ `domain/`（純邏輯 + spec）。

---

## 3. 已交付功能（依 commit 時序）

> 完整 commit 訊息是此專案的權威來源之一；修改某層前先讀對應 commit body。

| 階段 | Commit | 內容 |
|---|---|---|
| Phase 0/1 | `a87f5b4` | Prisma 整合 PostgreSQL（PrismaService、prisma.config.ts、Docker PG 文件） |
| Phase 1 | `d51c61b` | 工程與資料基礎 + identity/courses 切片（env validation、configure-app、common helpers、TransactionService、health、SystemSetting/Account/WebSession/Course schema、bootstrap-admin CLI） |
| Docs | `a5a2463`/`8b27154` | M2 design-gate 進度與完成紀錄（文件審查，無 runtime 變更） |
| Core | `bd45931` | 統一 API envelope 與穩定錯誤契約（`{data,meta,error}`、ApiResponseInterceptor、validation-exception factory、Prisma/HttpException → 穩定碼） |
| Auth | `8266698` | CSRF double-submit guard + session logout/revocation（`__Host-csrf` cookie、生產強制 Secure） |
| Auth | `3eec7e9` | Step-up（10 分鐘）、password change/reset、account disable/restore、must-change-password、密碼欄位 redaction |
| Poll | `ea937e8` | Poll single-choice 全鏈：Question → LiveSession → Participant → Submission（schema/migrations、session code、participant token hash、immutable submission、idempotency、advisory lock、archive 阻擋） |
| API | `19829c7` | 重新引入 Swagger（`@nestjs/swagger@11.4.6` exact pin + `js-yaml@5.3.0` override 修補 DoS；JSON only、`useGlobalPrefix`、compiler plugin） |
| Questions Q-1 | `c1a1cca` | 題目 list/detail read endpoints（owner/admin、archived readable、non-owner 404） |
| Questions Q-2 | `ca87fee` | 題目 update/delete/reorder mutations（two-phase reposition、`QUESTION_LOCKED_BY_SESSION`、`order` route 在 `:id` 之前） |
| Questions Q-3 | `de75e58` | poll-multiple / open_text / quiz authoring types（`validateQuestion` dispatch、correctOptionRefs、authoring vs learner projection split） |
| Questions Q-4 | `0eee8f9` | batch validate/confirm（1–50、all-errors、token、idempotency）+ CLI credential subsystem（`CliCredential`、`X-CLI-Key`、step-up 發放） |
| Sessions S-1 | `ee9f1e1` | session close/cancel teacher endpoints（active→closed / waiting\|active→cancelled、同 tx 關閉 open questions） |
| Sessions S-3 | `a9c3229` | 題目結果聚合 endpoint（vote-to-reveal、poll/quiz/open_text 聚合、純 `aggregateResults`） |
| Sessions S-2 | `dff19bb` | teacher session detail endpoint（joinedCount/votedCount） |
| Realtime S-4 | `553d120` | Socket.IO `/live` namespace + in-process event bus（lifecycle/count push、PostgreSQL 為唯一權威、socket 僅通知） |
| Submissions | `594e9d3` | Phase A：quiz/open_text/poll-multiple 作答（activation gate、DB constraint 放寬、answer-contract、result reveal privacy、per-client participant-safe push） |

### 尚未實作 / 已延後
- **Phase B — 學生帳號 + 加選名冊**（下一階段，見下方專節）
- **R-1 full**：outbox table、eventSeq/aggregateVersion、replay/sync.required、coalescing、Redis adapter、durable publisher、per-participant vote-to-reveal socket projection（部分已於 `594e9d3` 落地）
- **CLI key** rotation/successor、pending_verification、key prefix/suffix、max active key、7/30/90/365 expiry；CLI `courses list`/`courses create`；CLI/batch rate limit
- **S-5** 封存/保留：`POST /live-sessions/:id/archive` → ArchivedResult + 90 天保留 + 早刪/tombstone（需 S-1 先完成）
- **R-4** auto-close scheduler + submit/close 競態 matrix
- **E-2/E-3** `GET /auth/session` 回真實 `expiresAt`（目前空字串）；區分 `AUTH_SESSION_EXPIRED` vs `UNAUTHORIZED`
- **E-4** 非阻擋清理：Nest `LegacyRouteConverter`(`health/(.*)`、`/api/*`) 警告、`pg@9 client.query()` deprecation、`@Get('ready')` 重複 decorator
- **E-5** 帳號管理 list/detail/update（目前只有 create/reset/disable/restore）
- **API envelope Option B**（postprocess wrapper）
- session-level `GET /live-sessions/:id/results`（M2 API catalog，隨 R-1）

### Phase A 遺留（小，可隨時補）
- batch validate preview 回應缺 `clientRef`（DTO 宣告但 `toPreview()` 沒填）— `question-batch.service.ts`。
- gateway participant snapshot 與 REST participant snapshot 可見範圍不一致（gateway 用 `toLiveSessionDto` 未過濾 open question / hasSubmitted）— 建議 Phase B participant 改動時一起統一。
- `GET /auth/session` 的 `expiresAt` 是空字串（既有問題，非 Phase A 引入）。

---

## 3.1 路線圖與進度（P1–P4，使用者 2026-08-16 確認）

優先序：**出題擴充(P1) → 課堂老師端(P2) → 學員課堂(P3) → 工程基準(P4)**。
前端策略採**選項 B**：等後端齊再開前端 — 每個流程的後端端點做完才開對應前端，不做前端 mock 占位。

| 階段 | 項目 | 狀態 |
|---|---|---|
| P1 | E-1 Swagger 基礎 | ✅ `19829c7` |
| P1 | Q-1 題目 list/detail | ✅ `c1a1cca` |
| P1 | Q-2 題目 update/delete/reorder | ✅ `ca87fee` |
| P1 | Q-3 題型擴充（poll-multiple/open_text/quiz authoring） | ✅ `de75e58` |
| P1 | Q-4 批次 validate/confirm + CLI credential | ✅ `0eee8f9` |
| P2 | S-1 LiveSession close/cancel | ✅ `ee9f1e1` |
| P2 | S-2 老師端 session detail（joined/voted） | ✅ `dff19bb` |
| P2 | S-3 結果/聚合 endpoint | ✅ `a9c3229` |
| P2 | S-4 joined/voted 即時人數（Socket.IO） | ✅ `553d120` |
| P2 | S-5 封存/保留 | ⬜ 待執行 |
| P3 | R-1 reconnect/replay（Socket.IO） | ✅ lite `553d120`；full 待執行 |
| P3 | R-2 vote-to-reveal 結果投影 | ✅ `594e9d3`（per-client participant push） |
| P3 | R-3 結束後行為/封存 | ⬜ 依 S-1/S-5 |
| P3 | R-4 submit/close 競態 + auto-close | ⬜ 待執行 |
| P4 | E-1~E-5 工程基準補強 | ⬜ 部分非阻擋 |
| — | Phase A 三題型 activation+submission | ✅ `594e9d3` |
| — | Phase B 學生帳號 + 加選名冊 | ✅ B1–B4 runtime；B5 privacy evidence／文件同步收尾中 |

---

## 3.2 Phase B — 學生帳號 + 加選名冊（B1–B4 已落地，B5 收尾中）

Phase B 是對早期「無學員帳號」MVP 前提的需求升級：新增 `student` role、`CourseEnrollment` 與登入學生綁定 `Participant`，並保留匿名 session-code + participant-token fallback。admin 建立 student account；不提供公開 self-registration。`canCreateCourse` 對 student 永遠為 false，student 不得進入 teacher/admin owner paths。

計畫檔：`/home/user/.claude/plans/b5-privacy-rosy-tower.md`。**風險：高**（auth/權限/realtime handshake）；B1–B4 runtime 已在目前 branch，B5 補 privacy regression、redaction boundary 與權威文件同步。

| 切片 | 內容 | 狀態 |
|---|---|---|
| B1 | `Account.role` 含 `student`；`canCreateCourse` 對 student 強制 false；沿用同一 cookie session 登入；student 不可存取 owner 路徑 | ✅ runtime + targeted evidence |
| B2 | `CourseEnrollment` bounded context；teacher owner/admin 加選/移除/列表、student `GET /me/courses`；archived Course 禁止新加選 | ✅ runtime + targeted evidence |
| B3 | `Participant.accountId` optional relation；student cookie join/submit；匿名 session-code/token fallback 保留 | ✅ runtime；full HTTP/concurrency verification pending |
| B4 | student handshake 只進 `session:<id>`，不進 teacher room；participant-safe `result.updated`，不收 `counts.updated`；撤銷後 disconnect | ✅ runtime + 14 realtime e2e tests |
| B5 | open_text results 維持匿名；raw credential/token/answer 不進 log；同步 current authorization/result-governance wording | 🔄 focused privacy tests pass；docs/full regression status tracked separately |

**DoD**：student 可登入/加選/看名冊/我的課/cookie 加入 session 並作答；匿名 fallback 保留；realtime student 進 participant room 收 `result.updated` 不收 `counts.updated`；權限 regression student 存取 owner path 被拒；open_text open/closed projection 不含 identity linkage；設計文件同步。B3 full HTTP/concurrency、全 repo regression、P0-06 archive/retention runtime 不因 B1–B5 code presence 自動視為完成。

---

## 4.1 前端整合陷阱（開發前端前必知）

> 來源：`tasks/todo.md` 前端 baseline 評估，已由程式碼確認。

1. **CSRF token 取得**：無獨立 `/csrf` endpoint；token 只能從 login 回應的 `Set-Cookie: __Host-csrf`（非 HttpOnly）讀取，之後所有 mutation 需帶 `X-CSRF-Token` + `Origin`。
2. **CORS_ORIGIN 不可用 `*`**：CSRF Origin 檢查 fail-closed，`*` 會讓所有 authenticated mutation 回 403 `AUTH_CSRF_INVALID`。需設明確 origin。
3. **回應永遠包在 envelope**：資料在 `response.body.data`；課程分頁是 `data.data` + `data.meta`；logout 為 `data: null`。
4. **submission 回傳值正規化**：`selectedOptionRefs` 可能被正規化成 formal option UUID，而非送出的 optionRef → 前端比對答案需用 ID。
5. **`GET /auth/session` 回傳 `expiresAt: ""`**（空字串）：不要用來判 session 過期；過期目前一律映射成 `UNAUTHORIZED`（`AUTH_SESSION_EXPIRED` 宣告但未使用）。
6. **OpenAPI**：`/api/docs` UI + `/api/docs-json` JSON only（無 YAML）；envelope 採選項 A — spec 顯示內層型別，前端 client 生成後手動解 `body.data`。型別亦可直接對齊 `src/modules/*/api/dto/*.ts`。
7. **無 GET session detail 給老師的獨立 participant 路由**：S-2 已補 teacher 專屬 `GET /live-sessions/:id`（含 joined/voted）；participant 用 `GET /live-sessions/:id/snapshot`。
8. **健康檢查不在 envelope**：`/health/*` 為原始回應，前端不可套用 envelope 解析。

---

## 4. 開發流程

### Quick start
```bash
cp .env.example .env        # 或 .env.<NODE_ENV>
npm install
npm run prisma:generate
npm run prisma:migrate:deploy
npm run start:dev           # http://localhost:3000
```

### 常用 scripts
| Script | 用途 |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint:check` / `npm run lint` | ESLint（CI 不修 / 帶 fix） |
| `npm run format:check` / `npm run format` | Prettier |
| `npm run build` | `nest build` → `dist/` |
| `npm test` | 單元測試（`src/**/*.spec.ts`） |
| `npm run test:integration` | DB-backed 整合測試（`*.integration-spec.ts`，`--runInBand`） |
| `npm run test:e2e` | e2e（`*.e2e-spec.ts`，`--runInBand`） |
| `npm run prisma:migrate:status` | migration 狀態 |
| `npm run bootstrap:admin` | 建立首個 admin（`tsx`） |

### 環境檔選擇（與 `prisma.config.ts` 對齊）
| `NODE_ENV` | 載入 |
|---|---|
| `development` | `.env.development`, `.env` |
| `test` | `.env.test`, `.env` |
| `production` | `.env.production`, `.env` |

必要變數（bootstrap fail-fast）：`PORT`、`NODE_ENV`、`DATABASE_URL`、`CORS_ORIGIN`、`COOKIE_SECRET`；`REDIS_URL` 選用。
密鑰產生：`openssl rand -base64 32`。

### 測試資料庫
- 整合/e2e 需已 migrate 的 `smartlearning_test`：`NODE_ENV=test npm run prisma:migrate:deploy`
- `test/setup/db.ts` 強制載入 `.env.test`，**拒絕操作任何非 `smartlearning_test` 的資料庫**；migration 失敗時大聲失敗而非探查 stale schema。
- e2e app factory 重用 production `configureApplication` + `configureSwagger`，確保測試與生產設定一致。

---

## 5. 不變量與規約（實作時必守）

### API / 傳輸邊界
- **統一 envelope**：`/api/v1/**` 回應為 `{ data, meta:{schemaVersion,requestId}, error:null }`；錯誤為 `{ data:null, error:{code,message,field?,blocking,nextStep?,retryAfterSeconds?} }`。health probes 維持 raw（prefix 之外）。
- **URI versioning**：每個 versioned controller 需在 `@Controller` options 明確 `version:'1'`；health 路由明確 `VERSION_NEUTRAL`。（否則會被 map 到 `/api/...` 而非 `/api/v1/...`）
- **錯誤碼穩定**：domain 拋 `DomainError` 子類，**不要自行 shape HTTP**；由 `GlobalExceptionFilter` 統一映射。新錯誤碼加在 `common/errors`，並保持 locale-independent 排序與 redaction。
- **request metadata**：在 filter/interceptor 中覆寫請求 metadata，避免洩漏 stale 資料。
- **驗證邊界**：外部輸入在 edge（controller/DTO）驗證；domain 不重複散落檢查。注意 batch endpoint 為保留巢狀 raw payload，controller 以 `{transform:true,whitelist:false,forbidNonWhitelisted:false}` 覆寫 global pipe，真正契約驗證由 domain `validateBatch→validateQuestion` 负责。

### Auth / 安全
- **Session**：opaque cookie token，DB 存 SHA-256 hash；idle/absolute expiry；`SESSION_COOKIE_SECURE` 僅在 `NODE_ENV=test` 預設 false，生產強制 Secure。
- **CSRF**：double-submit（cookie/header constant-time 比對）；login 免 CSRF；authenticated POST mutation 需 CSRF + 嚴格 Origin allowlist（**拒絕 wildcard Origin**）。
- **Step-up**：敏感 admin 操作需 10 分鐘 step-up（持久於 WebSession），以 `StepUpGuard` 守護。
- **Guard 狀態語意**：missing/invalid session → 拋 `UnauthorizedError`（401）；authenticated 但無權限 → `ForbiddenError`（403）。不要回傳 `false`。
- **CLI credential**：raw key/token 只回傳一次、永不寫入 log；DB 存 hash；account disable 立即撤銷 CLI key + 未用 token；`can_create_course=false` **不**撤銷 CLI key（M2 紅卡 #8）。
- **密碼欄位 redaction**：`currentPassword`/`newPassword`、participant token、idempotency key、answer 欄位、`X-CLI-Key`、`X-Validation-Token`、rawKey、validationToken、payloadHash 已列入 Pino redaction。新增敏感欄位時記得加入 `common/observability`。
- **vote-to-reveal**：quiz correctness 只在 `revealCorrectness`（teacher 恆開、participant 於 close 後）才揭露；per-client participant push 計算 participant-safe projection，**teacher projection 永不廣播到 session room**。

### 資料 / Schema
- **IDs**：UUID v7（app 生成，非 DB 預設）。
- **狀態欄**：`TEXT + CHECK`，透過手寫 migration raw SQL；避免 enum 型別。
- **timestamps**：UTC `TIMESTAMPTZ`。
- **migration**：additive 為主，**避免 down migration**；不可逆 migration 需補償策略。CHECK 內不可含 subquery（用 `jsonb_path_exists` 等）。
- **線性化點**：session/question close 的 linearization point 為 transaction commit。
- **鎖**：`TransactionService` 提供 `FOR UPDATE` 與 advisory-lock helper；advisory lock 一律用 `$executeRaw`（Prisma 7 `$queryRaw` 無法反序列化 PostgreSQL `void`）。提交/close 線性化、batch idempotency 序列化、archive 阻擋均透過此服務。
- **Submission**：immutable；idempotency fingerprint 比較 sorted ref set + normalized text（permuted multi-selection replay 視為同一 submission）；refs/text 互斥為 application-layer invariant（open_text 寫 `Prisma.DbNull`）。
- **question lock**：`assertNotLockedBySession` — 當 waiting/active LiveSession 已選某題時禁止編輯（`QUESTION_LOCKED_BY_SESSION` 409）。
- **位置重排**：`compactPositions` 採 two-phase reposition，避免 transient `(courseId,position)` unique 違規。

### Realtime
- **PostgreSQL 為唯一權威**；socket 僅通知，vote-to-reveal 仍由 REST 強制。
- **commit-then-publish**：post-commit fire-and-forget，bus 失敗不得導致 mutation 失敗；per-listener error isolation。
- handshake auth：teacher 用 Web session cookie（socket.io bypass express middleware，手動以 `cookie` 解析）；student cookie 需 active enrollment 並解析為 account-bound participant；anonymous participant 用 token + session code。
- student realtime privacy：student 只進 `session:<liveSessionId>`，不進 `teacher:<liveSessionId>`；`counts.updated` 僅 teacher room；`result.updated` 逐 client 計算 participant-safe projection。open_text results 僅 `{ text }`，不得帶 participant/account/display/token linkage；raw credential、token、answer/open-text payload 不進 log。

### 程式碼風格
- 三層切片：`api`（controller/dto）→ `application`（service）→ `domain`（純邏輯 + spec）。純邏輯放 domain 並寫 unit spec，I/O 隔離在 application。
- Prefer additive changes；擴充 schema 先於消費端變更。
- 新增/編輯檔案後**先 `prettier --write` 再跑 lint gate**，避免 formatting-only 失敗遮蔽行為驗證。
- 既有路由順序敏感：`order` route 需在 `:id` route 之前宣告。

---

## 6. 任務追蹤規約

- 非平凡工作先寫 checklist 到 `tasks/todo.md`（含 Verify 任務、Risk & Rollback、依賴與環境 block）。
- 修正錯誤或發現mistake後，更新 `tasks/lessons.md`：failure mode / detection signal / prevention rule + tripwire。
- session 開始與重大 refactor 前先讀 `tasks/lessons.md`。
- 完成時加 "Results" 段：what changed / where / how verified。

---

## 7. 驗證命令組合（DoD）

最小驗證組（每次交付前）：
```bash
npm run typecheck
npm run lint:check
npm run format:check
npm run build
npm test                         # unit
npm run test:e2e                 # 需 smartlearning_test 已 migrate
npm run test:integration         # DB-backed，DB 不可達時 skip
npm run prisma:migrate:status
git diff --check
```

優先跑**最小相關範圍**（targeted → module → integration → full regression），通過後再擴大。
測試輸出為 ephemeral diagnostic data，建議透過 subagent 執行並回傳結構化報告，避免污染主 context。

---

## 8. 常見陷阱（節錄自 lessons.md）

- Prisma 7 advisory lock 回 `void` → 用 `$executeRaw`。
- URI versioning 需明確 controller metadata。
- supertest over HTTP 不保留 Secure cookie → `SESSION_COOKIE_SECURE` test 例外。
- Guard 401 vs 403 語意（missing→401、no-perm→403）。
- 新檔案先 format 再 lint。
- 傳輸邊界嚴格 normalize：覆寫 request metadata、只信任顯式 validation details、locale-independent 排序、結構化 redacted log。
- 拒絕 wildcard Origin 於 CSRF-protected mutation。
- batch two-layer `FIELD_FORBIDDEN`：`validateBatch` 與 `normalizeQuestion` 都需 strip `clientRef`，集中於 `stripClientRef` helper。
- `ReorderQuestionsDto` primitive `string[]` 用 `@IsString({ each: true })`，勿用 `@ValidateNested` + `@Type(() => String)`；reorder route 宣告於 `:id` route 之前（Nest static/param route 順序敏感）。
- ConfigModule 用 `validate` hook（非 `load`）才能在 dotenv 載入 envFilePath 後驗證已解析 env。
- `.env.test` 的 PORT 不可為 0（`@Min(1)` fail fast）。
- PG CHECK 不可含 subquery（放寬 `selected_option_refs` 用 `jsonb_path_exists`）；Prisma JSON column 寫 null 用 `Prisma.DbNull`（非 `JsonNull`）。
- socket.io handshake cookie：socket.io engine 攔截 handshake 在 express middleware 之前，cookie-parser 不 populate `request.cookies` → gateway 手動 `cookie.parse(socket.request.headers.cookie)`。
- post-commit emit client race：service `publish` 在 `transactions.run` 返回後同步 fire，事件可能在 REST response 返回前已送到 → test 需在 mutation **之前** pre-register listener promise，mutation 後 await。
- `DomainError.message` 是人類描述非 code → 判定錯誤類型用 `error instanceof DomainError && error.code === '...'`（讀 `DomainError.code` 屬性）。

---

## 9. 設計前提與權威文件

- `docs/智學互動平台/30_系統設計/M2 關鍵技術決策.md` — 11 項紅卡（UUID v7、TEXT+CHECK、lock protocol、Web Session、Argon2id、validation token、advisory lock、can_create_course scope、open-text 投影、wire contract、Redis 邊界）。
- `README.md` — quick start、configuration、scripts、project layout。
- `tasks/todo.md` / `tasks/lessons.md` — 進度與教訓。
- git commit bodies — 各 slice 的細節決策與不變量（修改某層前必讀對應 commit）。