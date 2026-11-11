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

# 2026-11-10 OpenAPI 產生與詞彙檢查

## Goal / acceptance criteria
- [x] 匯出的 OpenAPI 文件可被 TypeScript client 型別產生工具接受並生成暫存輸出；不提交產物、不維護前端 client。
- [x] 自動檢查 OpenAPI 名稱是否使用權威詞彙表標記的 Avoid 用詞，錯誤含精確位置；空 `paths` 可通過。
- [x] CI、文件及本機命令一致；不新增業務 API、不連 DB、不讀取環境 secret。

## Risk & rollback
- Risk: 低；只新增 OpenAPI 靜態檢查、工具依賴和 CI 步驟。
- Rollback: 移除新增 scripts、工具、檢查資料及 CI 步驟；不觸及資料。

## Working notes
- 現有 `openapi:export` 已建置並匯出，CI 有 OpenAPI job。
- 權威 GLOSSARY 在 repo 外；CI 使用 repo 內精簡且需同步的檢查詞彙資料。
- 目前無業務 API，因此本次只能驗證空規格可生成；不代表前端正式 client 已驗證。

## Steps
- [x] 加入暫存 client 型別產生檢查與詞彙靜態檢查。
- [x] 補單元測試並接入 CI。
- [x] 更新 OpenAPI 文件及結果紀錄。
- [x] 執行 targeted tests、OpenAPI 匯出／產生、lint、typecheck、diff check。

## Results
- 新增 `openapi:client:check`：使用 `openapi-typescript` 將 `dist/openapi.json` 產生至忽略追蹤的 `dist/openapi-client.d.ts`；CI 在 Node 22 執行，前端正式 client 仍由前端 repo 管理。
- 新增 `openapi:names:check`，對路徑、操作名稱、標籤、路徑／操作參數、元件 schema 名稱及巢狀欄位，檢查 repo 內精簡同步的 55 條詞彙規則；指出 JSON 位置及建議用詞，並保留詞彙表明確允許的 `Instructor-Led` 例外。
- 為避免新產生工具受原本全域 `js-yaml@5.3.0` override 影響，僅對 `@redocly/openapi-core` 還原其相容的 `js-yaml@4.3.2`；其他套件仍維持既有 override。
- CI OpenAPI job 現在依序匯出規格、產生 TypeScript 型別並檢查命名；更新 `docs/openapi.md` 說明責任界線與詞彙表同步要求。
- Verification: `npm test -- --runInBand openapi-name-check.spec.ts` PASS（5 tests）；`npm run typecheck` PASS；`npm run lint:check` PASS；`npm run openapi:export` PASS；`npm run openapi:client:check` PASS；`npm run openapi:names:check` PASS（55 條規則）；`git diff --check` PASS。
- 沒有資料庫／Docker 操作。OpenAPI 目前仍無業務 endpoint，所以這證明產生工具可讀取空規格，不能代表實際業務 API 或前端 client 已驗證。
- `npm audit --json` 回報整體依賴樹有 32 筆弱點（8 low、16 moderate、6 high、2 critical）；新增的 `openapi-typescript`、`@redocly/openapi-core` 與其隔離的 `js-yaml@4.3.2` 未被列為受影響項目。既有全域 `js-yaml@5.3.0` 有 moderate advisory，本次未擴大範圍修正，需另行評估。

# 2026-11-11 驗證前端空殼啟動與測試資料庫狀態

## Goal / acceptance criteria
- [ ] 驗證前端 `/admin` 與 `/learner` 空殼能正常啟動並回應。
- [ ] 確認測試資料庫遵守當次隔離與清理規範；無法確認時明確記錄阻礙，不擅自清除。

## Risk & rollback
- Risk: 前端啟動為低；資料庫環境檢查需唯讀，任何啟停、migration 或刪除資源皆停止等待額外同意。
- Rollback: 不變更程式碼、資料庫或 Docker 資源；關閉本次啟動的前端程序（若有）。

## Working notes
- Admin 與 learner 是同一 Next.js app 的 `/admin`、`/learner` 路由，開發伺服器預設使用 3001。
- Backend `.gitignore` 有既存修改，未觸碰；frontend Git status 尚待 test subagent 回報。
- 初次查核時 Docker socket 不存在；使用者再次要求查核時 socket 已恢復。最新唯讀結果以再次查核為準；`.env.test` 存在但內容不作回報，設定存在不證明資料庫狀態已清理。
- Backend `AGENTS.md` 指出整合測試可能隱式執行 `migrate deploy`；目前未執行任何資料庫測試或 Docker 資源操作。

## Steps
- [x] 執行前端 lint、typecheck、unit tests 與 HTTP route smoke check。
- [x] 唯讀檢查測試 DB 呼叫鏈與環境狀態；Docker 不可用則記錄受阻。
- [x] 記錄結果、未驗證事項與安全限制。

## Results
- 前端工作目錄乾淨，未修改前端檔案。`npm run lint:check` PASS；`npm run typecheck` PASS；`npm test` PASS（4 files、23 tests；僅有 Vite configLoader deprecation warning）。
- port 3001 預檢無既有 listener；以 `npm run dev` 啟動後 `/`、`/admin`、`/learner` 均 HTTP 200。只停止本次啟動的 PID 7395，未碰觸其他程序。
- 2026-11-11 再次唯讀檢查時 Docker context 為 `default`，Engine 可連線（Client 29.6.2-rd / Server 29.5.3）。`docker ps -a` 僅列出健康運作中的 `smartlearning-dev-db-dev-db-1`；`docker volume ls` 僅列出 `smartlearning-dev-db_dev_pgdata`。`docker inspect` 確認該容器掛載的是 dev volume。
- 測試 Compose `ps -a` 無任何服務列出，且 volume 清單沒有測試專用 volume；可確認目前沒有該 Compose 專案的測試容器或資料卷殘留。進一步唯讀檢查發現 localhost:5432 無 listener（`ss -ltn '( sport = :5432 )'`）；`pg_isready` 不可用（系統未安裝該工具）。因此沒有可查詢的本機測試 DB，無法確認任何資料表內容是否為空或乾淨；未連線或檢查其他外部資料庫服務。
- 未執行 Docker／資料庫變更或整合測試；development DB 容器與資料卷保持原狀。

# 2026-11-11 定義並建立隔離乾淨測試資料庫

## Goal / acceptance criteria
- [x] 定義可量測的乾淨基線：完成 repo migrations；`app._prisma_migrations` 完整成功；每一張 app 業務表 0 rows；無意外 app 表／型別。
- [x] 建立唯一 Compose project 的 PostgreSQL 16 測試環境，與開發容器/資料卷隔離；驗證實際資料庫身份及乾淨基線。
- [x] Postgres 密碼不進容器環境或命令 metadata；暫存秘密僅傳至 Docker 管理 volume 並清除本機暫存。

## Risk & rollback
- Risk: 中高；建立專屬容器、網路、資料／秘密 volume，並在全新測試資料庫執行 Prisma DDL migration。
- Target: 由唯一 RUN_ID/project 控制的新測試資源，測試 DB `smartlearning_test`、app schema、loopback port 5432。
- Rollback: 本次核准保留新環境運作，不自行 down 或刪除任何 volume；若需移除須另行核對並取得授權。開發 DB 5433 與其 volume不碰。

## Working notes
- 使用者明確同意建立新隔離 Compose 資源、執行 Prisma migrations、確認 app 業務表為空，並保留環境運作；也明確同意同步本機忽略追蹤的 `.env.test` 內 `DATABASE_URL` 密碼，與 `DB_PASSWORD` 一致（秘密值不記錄）。
- Prisma CI 設定 `prisma.ci.config.ts` 由 process `DATABASE_URL` 取得連線並強制 `schema=app`；既有 CI 使用此設定部署 migrations。
- 為避免 Docker inspect metadata 洩漏密碼，測試 Postgres 使用 `POSTGRES_PASSWORD_FILE`；一次性 root init 只設定 `root:postgres 0440` 權限，資料庫唯讀掛載 Docker 管理秘密 volume，並由 `postgres` 身分驗證可讀。
- 初次新環境建立已成功建立唯一 project/container/兩個專屬 volumes，健康檢查通過，實際 DB identity 為 `smartlearning_test`/`smartlearning`；migration 尚未執行。初始資料庫檢查錯把 PostgreSQL 系統 schema `pg_toast` 當成使用者 schema而中止；已保留證據，唯讀查詢確認除了系統 schema 外沒有任何 schema/table。檢查器現改為排除 `pg_` 系統 schema，並加入僅針對 `creating` 狀態、健康且仍為空 DB 的精確 `resume` 動作，避免重建或刪除目前 run。
- 該 run：`20261111115809-e2d12f2b` / project `sltest-20261111115809-e2d12f2b`；Docker context `default`、dev DB 仍在 5433。本次保留既有 dev DB/volume，不執行清除。

## Steps
- [x] 唯讀 preflight：Docker context/Engine、port、postgres image、現有容器/network/volumes、Compose 展開檢查，不輸出 secrets。
- [x] 更新測試 Compose 以支援安全密碼檔掛載與一次性秘密初始化服務；新增可重複 create/resume/status 工具與標準說明，嚴格唯一 run ID 和身份驗證。
- [x] 靜態驗證 Compose、腳本語法、型別檢查及 diff；migration inventory parser 對目前 SQL 得到 36 tables/21 enums。
- [x] 續跑目前已建立、仍健康且尚未 migration 的精確測試 DB；核對身份後部署 migrations。
- [x] 執行唯讀 catalog、migration ledger、逐表 row-count 驗收，證明所有業務表為 0 rows。
- [x] 記錄結果與保留資源狀態；確認開發 DB 資源未變。

## Results
- 「乾淨」定義：新建專用 DB，所有 repo migrations 成功，`app._prisma_migrations` 與預期一致且無失敗紀錄，36 張 app 業務表全為 0 rows，21 個 enum、表／relation inventory 與 migration 相符，沒有額外使用者 schema/table/view/sequence/custom type。Postgres 系統 schema（如 `pg_toast`）與 Prisma migration ledger 不算應用資料。
- 建立並保留 run `20261111115809-e2d12f2b`，Compose project `sltest-20261111115809-e2d12f2b`。PostgreSQL 16.15 healthy，loopback `127.0.0.1:5432`；資料 volume 與 secret volume 均為該 project 專屬。Migration `20261105000000_init_app_schema` 已成功套用，`prisma migrate status` up-to-date。
- 驗收摘要：DB `smartlearning_test`、role `smartlearning`；36 app tables、21 enums、1 successful migration、0 failed/rolled-back migrations、0 app business rows。`app._prisma_migrations` 有完整成功紀錄。腳本驗證所有 app relation/custom-type inventory，並對每張業務表逐表 count；另以唯讀 SQL 重查得到相同 aggregate。
- 密碼使用短暫本機 `0400` 檔案經一次性 init 容器複製至 run 專屬 Docker volume；本機暫存已刪除。Postgres 容器只含 `POSTGRES_PASSWORD_FILE` 路徑，inspect 檢查 `POSTGRES_PASSWORD` value 不存在；`postgres` 使用者可讀 root:postgres `0440` secret file，volume 為 read-only mount。
- 初次建立檢查錯把 PostgreSQL 系統 schema `pg_toast` 當成使用者 schema，故在 migration 前安全中止。已保存容器/volume identity、健康狀態、啟動 logs 及 catalog 證據；唯讀檢查確認無使用者 schema/table；修正檢查器排除 `pg_` system schemas 後，使用專用 `resume` 僅續跑同一個仍健康且空白的 run，沒有重建或刪除任何資源。
- 靜態驗證：`node --check tools/test-db/db-test-env.cjs` PASS；`npm run db:test:preflight`（建立前）PASS；`docker compose ... config --quiet` PASS；`npm run typecheck` PASS；`git diff --check` PASS；migration parser counted 36 table statements / 21 enum statements；`npm run db:test:status` 顯示 healthy。
- `.env.test` 是本機忽略追蹤檔；依使用者明確同意，將 `DATABASE_URL` 內的測試密碼同步為 `DB_PASSWORD`，未輸出或記錄秘密值。
- 開發 DB `smartlearning-dev-db-dev-db-1` 仍 healthy、綁定 5433 並掛載原 `smartlearning-dev-db_dev_pgdata`；未修改或清理 dev/test 資料卷。未執行整合測試或任何 seed/write operation；本資料庫在後續測試寫入後即不再符合「乾淨」基線。
