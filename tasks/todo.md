# 2026-11-21 M02 Role Management Backend

## Goal / acceptance criteria
- [ ] Implement backend role list and detail for fixed `SYSTEM_ADMIN` / `TEACHER`, including reserved marker, status, M04 permission summary, safe errors, and no sensitive fields.
- [ ] Keep role code/name/description immutable and reject fixed-role deletion or metadata mutation.
- [ ] Implement authorized role enable/disable with atomic protection for every enabled account's final effective role and the last effective system administrator; preserve assignments and immediately revoke affected sessions; re-enable must not revive revoked sessions.
- [ ] Keep `USER_ROLE` assignment changes owned by M03; do not expose M02 assignment writes. Preserve multi-role/no implicit TEACHER semantics in login authorization.
- [ ] Enforce server-side authentication and M04-defined permission contract; accurately document OpenAPI and cover acceptance behavior with tests.

## Risk & rollback
- Risk: high; role/auth/session integrity and a cross-account concurrency invariant.
- Affected: role reads/status, login-session revocation, account/assignment boundary, OpenAPI and tests.
- Rollback: revert this feature's code/tests/docs/migration (if any) only; never automatically revert live database state or delete resources.
- No Docker, database, migration, account provisioning, or external service operations absent separate explicit approval and fresh isolated test DB preflight.

## Working notes
- The M02 source spec is `/home/user/projects/smartLearning/docs/智學互動平台/20_系統分析/M02 角色管理—使用者需求與驗收規格.md`; authoritative terminology is `/home/user/projects/smartLearning/docs/智學互動平台/20_系統分析/GLOSSARY.md`.
- Existing M01 auth/session code and Prisma role models exist; no maintained M02 role controller/service or M03 assignment API was found. `AuthRepository.revokeSessionsForRole(roleId)` exists, as does session snapshot/validation logic.
- M04 permission-summary service/API and permission codes are not yet implemented/confirmed. Must not invent permission codes or represent dependency failure as an empty summary; fail closed and document dependency integration.
- M03 owns `USER_ROLE` writes and account disablement; must not implement these through M02. Last-admin guarantee spans M02/M03 operations, so cross-module transaction/locking integration is a key acceptance dependency.
- Worktree started with unrelated `.gitignore` modification; preserve it.

## Steps
- [x] Inspect existing auth/session/Prisma/error/OpenAPI patterns and identify authoritative M04/M01 contracts.
- [x] Design minimal M02 controller/service/repository contract and explicit cross-module dependencies. User approved defining the minimal M04 permission contract in this task.
- [x] Implement fixed role listing/detail, immutable metadata boundary, and M04 permission summary catalog.
- [x] Implement role state changes with serializable final-role/last-admin checks and same-transaction session revocation.
- [ ] Add focused tests mapped to every applicable M02 acceptance scenario, including error/dependency/concurrency paths; M03-owned assignment tests remain outside M02 because that module is absent.
- [ ] Run authorized offline verification and validate OpenAPI; no DB-backed tests without the required approval and fresh disposable DB.
- [ ] Record Results with exact verification and unresolved cross-module acceptance blockers.

---

# 2026-11-23 M03-03 Account Creation (Teacher API + First Admin Bootstrap)

## Goal / acceptance criteria
- [x] `POST /teachers` (M03-03): 登入且具 `M03_WRITE` 的系統管理者可建立老師帳號 — 帳號狀態 `INVITED`、`email_verified=false`、同一筆交易指派 `TEACHER` 角色（含 `assigned_by`）、建立 7 天 `INVITATION` 一次性連結與加密 `TEACHER_INVITATION` outbox 工作。
- [x] 欄位規則依 M03 spec：姓名去空白後 1–100 code points、帳號名稱 `^[A-Za-z0-9._-]{3,32}$` 全平台唯一（不分大小寫）、Email ≤254 標準格式唯一（不分大小寫）、電話選填 E.164；重複回 409 `EMAIL_ALREADY_EXISTS` / `ACCOUNT_NAME_ALREADY_EXISTS`。
- [x] Bootstrap `npm run bootstrap:admin`（`src/bootstrap/bootstrap-admin.ts` + 純邏輯 `bootstrapAdmin()`）：憑證僅來 env var、無 TTY/argv 外洩；同一筆交易建立 ACTIVE 帳號 + 有效 `SYSTEM_ADMIN` 指派（`assigned_by=null`）；冪等重跑安全停止 exit 0；失敗整筆回滾 exit 非 0。
- [x] Migration `20261123000000_add_m03_account_management_permissions`：seed `M03_READ`/`M03_WRITE` 僅映射 `SYSTEM_ADMIN`（鏡像 M02 前例，註明 M04 擁有運行時維護）。
- [x] OpenAPI：new path `/teachers` exported，`openapi:names:check` 通過；「重送以 409 為衝突結果（無 Idempotency-Key 持久化）」已記錄於契約文件。

## Risk & rollback
- Risk: medium-high（帳號建立/邀請連結/bootstrap 交易邊界）；migration 為純新增 seed（additive）。
- Rollback: revert 本功能 code/tests/docs/migration；live DB seed rows 為 additive，不需資料復原。
- Docker/DB 操作（`db:test:up`、`test:integration`）需使用者另行明確同意，本次未執行。

## Working notes
- 冪等偏离：`user_account` 無 `idempotency_key` 欄位；單筆建立以「衝突即冪等（重送 → 409，不產生第二列）」+ OpenAPI 文件揭露。批次管理（M03 spec 要求冪等識別碼）為後續工作時須補齊。
- 邀請啟用端點（一次性連結設密碼）屬 M01/M03 後續工作；outbox 寄送程序（`email-outbox.processor`）目前仍僅以密碼重設流程為已驗證路徑 — 邀請信 payload 用同一加密機制（`encryptPayload` 已泛化），送達流程待邀請啟用功能一併驗證。
- Bootstrap 憑證交付管道（郵件/一次性下載）依《第一個帳號與角色建立指引》屬「待核定」部署契約；本實作只保證 env 輸入 + 不落 log/版本控制。
- 整合測試已寫好待執行：`test/accounts.integration-spec.ts`（HTTP 全流程，模板=auth spec）與 `test/bootstrap-admin.integration-spec.ts`（直接 import `bootstrapAdmin()`）；兩者皆 `TEST_DB_RUN_ID` + `assertIntegrationReady` 閘門，僅測試時清理自建資料。

## Steps
- [x] Migration（M03 權限碼 seed）
- [x] `src/accounts/`：DTO / repository / service / controller / module，掛入 `app.module.ts`；`AuthSecurityService`、`ResetMailService` 由 AuthModule export
- [x] 單元測試 15 全數通過（dto / service / controller / module-wiring + bootstrap 參數驗證）
- [x] `src/bootstrap/bootstrap-admin.ts` + `bootstrap-admin.core.ts`（測試可 import）
- [x] 兩支整合測試撰寫完成（執行需依 Docker rules 事先取得同意）
- [x] `npm run openapi:export` + `openapi:names:check` 通過（`/teachers` + 201/400/401/403/409/503 記載）
- [x] lint:check / typecheck / npm test(117 passed) / build 全數通過
- [x] 整合測試於全新 disposable test DB 執行完成（run `20261123120405-51186847`，使用者同意）

## Results（2026-11-23）

**整合測試（disposable test DB run 20261123120405-51186847，postgres:16，4 migrations，users 同意執行）**
- `npm run test:integration`：4 suites，15 passed，1 skipped（opt-in dev DB 檢查，符合設計）
- 新增 `test/accounts.integration-spec.ts`：6 cases passed —
  201 全鏈路（INVITED/TEACHER assigned_by/7 天 INVITATION 連結 PENDING/加密 outbox PENDING，回應無密碼與 token）、未登入 401、TEACHER 呼叫者 403、大小寫重複 email/accountName 409 且不建第二列、8 種無效 payload 400、缺 CSRF/非信任 Origin 403。
- 新增 `test/bootstrap-admin.integration-spec.ts`：4 cases passed —
  同一交易建立 ACTIVE 帳號+SYSTEM_ADMIN 指派（assigned_by null）並可 argon2 verify、冪等重跑（帳號與指派數不變）、已存在無管理者 Email 安全停止（回滾指派）、密碼政策拒絕完全回滾。
- 執行後驗證 clean baseline：user_account/user_role/one_time_link/email_outbox/login_session 皆 0（僅剩 migration seed 的角色/權限目錄 10 列）。
- 清理：容器與 network 以精確識別移除；volumes `sltest-20261123120405-51186847_{test_pgdata,test_db_secrets}` 依腳本設計保留待處置。

**整合測試期間修正的程式問題**
1. Raw SQL 唯一性衝突經 driver adapter 以 `P2010`（非 P2002）呈現，實際 Postgres 約束名在 `meta.driverAdapterError.cause`；`accounts.service.ts` 改為解析約束名（`uq_user_email_lower` / `uq_user_account_name`）回對應 409，並以 Jest probe 確認錯誤形狀後刪除 probe。
2. 整合測試 app 未經 `main.ts` bootstrap 須手動掛全域 `ValidationPipe`（測試端修正，與 production 行為一致）。
3. 邀請 outbox 需要 `EMAIL_OUTBOX_ENABLED`/`PASSWORD_RESET_URL`/`RESET_OUTBOX_ENCRYPTION_KEY`/`TEACHER_INVITATION_URL`；整合測試以 fixture 值注入（不實際寄信，只驗證資料面）。

**離線驗證（最終）**
- `lint:check` 0 errors、`typecheck` 乾淨、`npm test` 117/117 passed、`npm run build` 成功
- `openapi:export` + `openapi:names:check`：`/teachers` 已記載（201/400/401/403/409/503），55 條 GLOSSARY 規則通過
- Bootstrap CLI 冒煙：`node dist/src/bootstrap/bootstrap-admin.js` 無 DATABASE_URL 時 exit 1 並輸出明確錯誤，無秘密外洩

**待核定／後續**
- 邀請啟用端點（一次性連結設密碼）屬 M01/M03 後續；outbox 邀請信送達流程需屆時驗證
- Bootstrap 憑證交付管道依指引屬「待核定」部署契約
- 批次管理補 Idempotency-Key 持久化（本次以衝突即冪等 + OpenAPI 揭露）
- 兩個舊 run 的 retained volumes（已刪 `20261122153112` 與本次 `20261123120405` 的 pgdata/secrets 仍在）待處置
