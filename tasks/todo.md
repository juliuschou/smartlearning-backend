# 2026-11-05 建立 Prisma dev app schema

## Goal / acceptance criteria
- [x] 以 Prisma 管理原始 ER SQL 的 PostgreSQL `app` schema；既有 `smartlearning_dev` DB、volume 與資料均保留。
- [x] Schema/migration 精確保留 36 tables、21 enums、關聯、約束、索引與 comments。
- [x] 僅對已核對身分的 dev DB 套用 migration；未 reset、刪除 volume 或修改其他環境。
- [x] 驗證 live catalog 與 Prisma migration 狀態。

## Risk & rollback
- Risk: 中高；既有持久 dev PostgreSQL schema DDL。
- Target: `smartlearning-dev-db-dev-db-1` / `smartlearning-dev-db_dev_pgdata` / `smartlearning_dev`。
- Rollback: 不做 reset/drop；保留 volume。若遇到衝突即停止，若套用後需修正採向前 migration，回復前另評估備份。

## Working notes
- Dev container 已運行健康，掛載預期的 named volume；image 是 PostgreSQL 16.15。
- 套用前 `app` schema 不存在；既有 `public` schema 有 22 張舊表與 20 筆 migration records。新 Prisma migration table 位於隔離的 `app` schema，不修改既有 public schema。
- Docker Compose/DB identity 已由唯讀檢查確認；無需建立 PostgreSQL database。
- 使用者已明確同意：核對後建立既有 DB 的 app schema/table；不授權清除資料或重建 volume。
- 原始 DDL 第一次部署在 user_account 上的表級 UNIQUE(lower(...)) 語法失敗；PostgreSQL 交易已回滾，該次 failed 記錄標記 rolled back，改成對等的 expression unique indexes 後已成功部署。
- 使用者已明確核准將 `20261105000000_init_app_schema` failed record 標記 rolled back 後重試；修正版 migration 已成功部署。

## Steps
- [x] 整理 DDL 到 Prisma schema + versioned migration SQL。
- [x] 加入 Prisma CLI/client、dev scoped scripts 與必要文件。
- [x] 靜態驗證 schema/migration；原始 DDL 的非法 expression UNIQUE 已在 migration 改為 expression indexes，且無 DROP/TRUNCATE/DELETE。
- [x] 唯讀檢查既有 migration 記錄及 DB schema/table 前置狀態。
- [x] 套用 migration 到已驗證的 dev DB（只新增 app schema）。
- [x] 查 catalog / migration 狀態，記錄結果。

## Results
- Added Prisma 7.10.1 schema introspection for 36 models / 21 enums and a versioned initial migration; generated client output is ignored and has a dev generation command.
- Applied `20261105000000_init_app_schema` to `smartlearning_dev`; PostgreSQL reports 36 app business tables, 21 enums, 58 foreign keys, 19 checks, 37 primary keys, 23 unique constraints, 69 indexes, and 306 comments. `prisma migrate status` reports up to date.
- Existing `public` schema and persistent volume were retained; no DB reset or volume deletion.
- Verification: `npm run prisma:dev:validate` PASS; `prisma format --check` PASS; `npm exec prisma -- generate --config prisma.dev.config.ts` PASS; `npm run typecheck` PASS; `npm run prisma:dev:status` PASS.
- Initial deploy attempt failed because source SQL used unsupported table-level expression UNIQUE constraints; corrected migration to equivalent indexes, marked the transactionally rolled-back attempt as rolled back with user approval, and successfully reapplied.

# 2026-11-06 提供 OpenAPI 規格

## Goal / acceptance criteria
- [x] 建立最小 NestJS `src/` 骨架，不虛構任何業務 API。
- [x] 後端提供 `/openapi.json` 規格端點及可重複的規格匯出指令；匯出產物置於忽略追蹤的 `dist/`。
- [x] 前端專案自行選擇工具產生和維護呼叫 API 的程式碼；後端不加入 `packages/api-client` 或 client generator。
- [x] 生產環境預設不公開規格端點，只有明確設定 `OPENAPI_ENABLED=true` 才開啟；非 production 預設可用，且可用 `OPENAPI_ENABLED=false` 關閉。
- [x] 文件與開發規則明確描述責任界線、規格取得方式與空骨架目前沒有業務 API 的限制。

## Risk & rollback
- Risk: low; 新增空 NestJS bootstrap 與 OpenAPI 設定，不觸及 DB、migration 或既有資料。
- Rollback: revert 本次新增與修改的程式／文件；不需資料回復。
- Security: production 預設關閉 OpenAPI endpoint，明確啟用時由部署方確認其網路可見範圍。

## Working notes
- 使用者選擇先建立最小空骨架；不得以 Prisma schema 推測或虛構業務端點。
- 已有 `@nestjs/swagger` 11.4.6 與 Swagger compiler plugin；無需新增依賴。
- 驗證僅需 build、typecheck、lint及單元測試／OpenAPI 匯出；不啟動 DB 或執行 migration。

## Steps
- [x] 建立 `src/` 最小 app module、bootstrap 與共用 OpenAPI 文件建立邏輯。
- [x] 建立 OpenAPI 匯出指令與 JSON 基本結構驗證，新增 CI 檢查。
- [x] 更新根指引及後端開發規則：後端維護 OpenAPI，前端自行產生 client。
- [x] 執行 build/typecheck/lint 與規格端點／匯出驗證。
- [x] 記錄結果與任何未驗證項目。

## Results
- 新增最小 NestJS app，提供 OpenAPI JSON endpoint；未新增業務 API 或後端 client generator。
- OpenAPI 取得方式：`GET /openapi.json`；本地匯出指令：`npm run openapi:export`，產物為忽略追蹤的 `dist/openapi.json`。
- HTTP 驗證：production 預設回 404；設定 `OPENAPI_ENABLED=true` 回 200，內容是可解析的 OpenAPI 3 JSON，`paths` 暫為空物件。
- Verification: `npm run lint:check` PASS; `npm run typecheck` PASS; `npm run openapi:export` PASS（含 build）。無 DB、Docker 或 migration 操作。
- 未驗證／限制：尚無業務 Controller、DTO 或 endpoint，故目前 OpenAPI spec 不含業務路徑；前端 client 產生與驗證由前端 repo 負責。

# 2026-11-06 CI 全新資料庫 migration 驗證

## Goal / acceptance criteria
- [ ] 每次 push／Pull Request 的 CI 在新建 PostgreSQL 16 上從空資料庫套用 repo 內所有 Prisma migrations。
- [ ] migration 只執行一次；失敗即讓 CI job 失敗，不重試或隱藏錯誤。
- [ ] 成功後保存可下載的結果紀錄，包含成功套用的 migration、版本與執行識別；不含連線密碼或資料庫內容。
- [ ] 不讀取 `.env.development`／`.env.test`，不連接既有或共享資料庫；既有 CI jobs 維持不變。

## Risk & rollback
- Risk: 低；新增 GitHub Actions 隔離服務 job，不觸及持久資料庫。
- Rollback: 移除 CI migration job；不需要資料回復。

## Working notes
- Prisma 7 schema 在 `prisma/schema.prisma`；migration 位於 `prisma/migrations/`，SQL 會建立 `app` schema。
- `prisma.dev.config.ts` 強制載入 `.env.development`，CI 不使用此 config。
- workflow 已採 Node 22 與 `npm ci`。
- 新增 `prisma/migrations/migration_lock.toml`，明確指定 PostgreSQL provider。
- 未在本機啟動資料庫或執行 migration；fresh DB 的實際套用結果須由 GitHub Actions 執行確認。

## Steps
- [x] 新增隔離 PostgreSQL migration job，使用臨時連線設定與健康檢查。
- [x] migration 成功後查詢已完成的 migration 記錄與 PostgreSQL 版本，產生不含憑證／資料庫內容的 JSON 結果檔，並上傳為 14 天的 workflow artifact。
- [x] 使用臨時 `DATABASE_URL` 離線執行 Prisma schema/config validate。
- [x] YAML parse、內嵌 Node.js 語法檢查與 `git diff --check` 通過；無本機 DB 或 migration 操作。
- [x] 記錄結果與尚未由 GitHub Actions 實跑的項目。

## Results
- 新增 CI `database-migrations` job：每次 push／Pull Request 啟動 PostgreSQL 16 service，健康檢查通過後，使用 job 專屬連線執行一次 `prisma migrate deploy`；步驟失敗會使 job 失敗。
- 新增成功後的結果檔：查詢 `app._prisma_migrations` 中完成且未回滾的 migration，並記錄結果、UTC 時間、commit SHA、workflow run／attempt 與 PostgreSQL 版本；只在 job 成功時上傳 14 天，不包含連線資訊、SQL dump 或業務資料。
- 新增 `prisma.ci.config.ts`，僅讀取 CI 注入的 `DATABASE_URL` 並指定 `app` schema；不載入開發／測試 `.env`。新增 Prisma migration lock，標示 PostgreSQL provider。
- Verification: Python YAML parse PASS; `git diff --check` PASS。`actionlint` 未安裝；Ruby 不可用。
- 未驗證：沒有在本機建立資料庫或跑 migration；fresh PostgreSQL 上 migration 及可下載 artifact 的實際結果仍需 GitHub Actions job 執行確認。
