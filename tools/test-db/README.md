# 隔離測試資料庫基線

## 「乾淨」的判定

乾淨測試資料庫不是「資料卷不存在」，也不是空白、尚未建表的 PostgreSQL。它必須符合：

1. 由單次執行建立，使用專屬 Compose project、容器、網路與資料卷；不可與開發環境共用。
2. `smartlearning_test` 的 `app` schema 已完整套用 repo 中所有 Prisma migrations，沒有失敗或待套用項目。
3. Migration 建立的 36 張應用資料表均為 0 筆資料。`app._prisma_migrations` 是預期的系統紀錄表，需保有完整成功紀錄，但不計入應用資料表列數。
4. `app` 中的表、序列、view、materialized view、foreign table 與自訂型別，須與 migrations 相符；不可有額外應用物件。

`npm run db:test:up` 會建立全新的 run 專屬環境、套用 migration，並執行以上檢查。只有實際查詢全部通過時才會印出 `Clean test database verified`。

## 執行與查詢

需先有 repo 專用 `.env.test`，且 Docker context 為 `default`；指令會確認本機 5432 埠未使用、`postgres:16` image 存在、設定指向 loopback 的 `smartlearning_test`，以及沒有既存的測試容器／volume。任何檢查不符都會停止，不會自動刪除資源。

```sh
npm run db:test:preflight # 唯讀檢查 Docker 身分、埠、image 與殘留資源
npm run db:test:up       # 建立全新隔離環境、套用 migration、驗收乾淨基線
npm run db:test:resume -- <run-id> # 僅續跑已建妥、仍健康且未套用 migration 的精確 run
npm run db:test:status   # 查詢目前最新 run 的容器狀態
npm run db:test:assert-integration -- <run-id> # 唯讀確認指定 run 可供 Checkpoint B 整合測試
npm run db:test:logs     # 看目前最新 run 的最近 100 行資料庫日誌
npm run db:test:down     # 停止本次容器與網路，但保留資料／秘密 volume
```

Checkpoint B 整合測試前，`db:test:assert-integration` 必須帶明確 run ID。它唯讀驗證 run state、Docker context、指定 Compose project/container、健康狀態、run 專屬資料與秘密 volumes、loopback port、資料庫身分、migration ledger，以及所有 app 業務表目前為 0 rows。成功後整合測試可建立並精確清除自己的 fixture；再次執行該檢查可確認 fixture 已清除。任何已有 app row 的 run 都會被拒絕，須新建 run，不能清表或重用。

每次建立會產生新的 run ID 與 Compose project；不重用已停止或保留的 run。狀態檔只記錄 run ID、資源名稱和驗收摘要，存放於 `$XDG_STATE_HOME/smartlearning/test-db/runs/`（若未設定則 `~/.local/state/smartlearning/test-db/runs/`），不含密碼。`status`、`logs`、`down` 可選擇性帶 run ID：

```sh
node tools/test-db/db-test-env.cjs status <run-id>
```

Postgres 密碼不放入容器環境或命令列。建立時由權限為 `0400` 的短暫本機檔案，經一次性初始化容器複製到本次專用 Docker 管理 volume；來源檔隨即刪除，Postgres 以唯讀方式掛載秘密 volume。初始化容器以 root 寫入 volume，產生 owner `root`、group `postgres`、mode `0440` 的檔案，讓資料庫初始化程序與 `postgres` 使用者皆可讀；完成後初始化容器即移除。工具會以 `postgres` 身分檢查檔案可讀性，但不讀出檔案內容。

## 資料保留與重建

`db:test:down` 不帶 `-v`，只停服務並保留資料卷。保留的資料卷不會被當成新鮮資料庫；下一次建立會因發現殘留測試資源而安全停止。要刪除特定 run 的容器、網路、資料卷或秘密卷，必須先核對精確 run 身分、說明資料影響並另行取得明確授權；本工具不提供自動刪除或 volume prune。

資料庫跑過任何測試、seed 或寫入操作後，就不能再沿用「乾淨基線」結論；重新驗收需使用新的隔離 run。這不會清除或修改開發資料庫。

若建立中途失敗，狀態會留為 `creating`，新 run 的資源可能部分建立；工具會保留它們供診斷，不會自動刪除。若該 run 容器仍健康，且 `resume` 的精確身分檢查與 migration 前「只有 PostgreSQL 系統 schema、沒有使用者資料表」檢查通過，可用 `npm run db:test:resume -- <run-id>` 續跑。若資料庫已改變、容器不健康或身份不符，停止並先唯讀盤點；任何移除動作都需另行授權。

## 手動登入 UI 的測試帳號（與自動整合測試分開）

登入頁不會提供預設帳密；忘記密碼也尚未實作。`test/auth.integration-spec.ts` 的隨機帳密只在自動測試程序中短暫存在，測試後清除，不能用來手動登入。若要在瀏覽器驗證登入，請用**專用的本機 UI 測試 DB run**，建立自己知道密碼的 `TEACHER` 帳號：

1. 先核准建立隔離測試 DB、套用 migrations 與寫入測試帳號；確認 `.env.test` 指向本機 `smartlearning_test`。依前述步驟執行唯讀 preflight 與新 run 建立，記下 `run_id`。DB/Docker 操作仍須依專案授權流程核准。
2. 確認 DB 仍是乾淨基線，再執行佈建。工具會互動式詢問 Email、姓名及密碼；密碼欄位不回顯，需輸入兩次確認。成功時只寫入 Argon2 hash，不會輸出密碼。請記住剛才自己輸入的 Email／密碼，這組就是登入憑證。

   ```sh
   RUN_ID='貼上 db:test:up 輸出的 run_id'
   npm run db:test:assert-integration -- "$RUN_ID"
   npm run db:test:ui-account:create -- "$RUN_ID"
   ```

   這會在該 run 建立 `ACTIVE`、Email 已驗證、僅具 `TEACHER` 角色的本機測試帳號；不會建立 `SYSTEM_ADMIN`。帳號名稱由工具依 run ID 與 Email 產生。Email 或帳號名稱已存在時，工具拒絕修改既有帳號。
3. 在兩個終端分別從各自 repository 根目錄啟動服務。Backend 的 `NODE_ENV=test` 會載入 `.env.test`；確認其中 `DATABASE_URL` 指向本次隔離測試 DB、`COOKIE_SECRET` 有效，且 `CORS_ORIGIN` 包含 `http://localhost:3001`：

   ```sh
   NODE_ENV=test npm run start:dev
   ```

   前端預設 API origin 是 `http://localhost:3000`；明確設定並啟動：

   ```sh
   NEXT_PUBLIC_API_BASE=http://localhost:3000 npm run dev
   ```

   在瀏覽器前往 `http://localhost:3001/login`，輸入第 2 步設定的 Email 與密碼。若登入失敗，確認 backend 指向同一個測試 DB、`CORS_ORIGIN` 包含前端實際 origin，且帳號 Email/密碼輸入正確；不要改連開發或正式 DB。啟動 backend 不會自動執行 migration，但這些啟動步驟會連線到 DB，應只在已核准的本機測試環境使用。
4. 完成驗證後可精確停用該 run 建立的測試帳號並撤銷它的有效 session：

   ```sh
   npm run db:test:ui-account:revoke -- "$RUN_ID"
   ```

   工具會要求輸入建立時相同的 Email，並要求輸入 `DISABLE` 確認。它不刪除帳號或 role，也不刪除 DB/volume；整個 disposable DB 的保留／移除仍依獨立核准流程處理。

**重要：**佈建帳號後，此 DB 不再是乾淨基線。不得再對這個 run 執行 `db:test:assert-integration` 或把它拿來跑要求空 DB 的 `test:integration`；自動化 PostgreSQL 整合測試必須另建全新 run。UI 測試 DB 不要與開發、共用或正式環境共用。