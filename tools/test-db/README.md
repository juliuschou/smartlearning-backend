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
npm run db:test:logs     # 看目前最新 run 的最近 100 行資料庫日誌
npm run db:test:down     # 停止本次容器與網路，但保留資料／秘密 volume
```

每次建立會產生新的 run ID 與 Compose project；不重用已停止或保留的 run。狀態檔只記錄 run ID、資源名稱和驗收摘要，存放於 `$XDG_STATE_HOME/smartlearning/test-db/runs/`（若未設定則 `~/.local/state/smartlearning/test-db/runs/`），不含密碼。`status`、`logs`、`down` 可選擇性帶 run ID：

```sh
node tools/test-db/db-test-env.cjs status <run-id>
```

Postgres 密碼不放入容器環境或命令列。建立時由權限為 `0400` 的短暫本機檔案，經一次性初始化容器複製到本次專用 Docker 管理 volume；來源檔隨即刪除，Postgres 以唯讀方式掛載秘密 volume。初始化容器以 root 寫入 volume，產生 owner `root`、group `postgres`、mode `0440` 的檔案，讓資料庫初始化程序與 `postgres` 使用者皆可讀；完成後初始化容器即移除。工具會以 `postgres` 身分檢查檔案可讀性，但不讀出檔案內容。

## 資料保留與重建

`db:test:down` 不帶 `-v`，只停服務並保留資料卷。保留的資料卷不會被當成新鮮資料庫；下一次建立會因發現殘留測試資源而安全停止。要刪除特定 run 的容器、網路、資料卷或秘密卷，必須先核對精確 run 身分、說明資料影響並另行取得明確授權；本工具不提供自動刪除或 volume prune。

資料庫跑過任何測試、seed 或寫入操作後，就不能再沿用「乾淨基線」結論；重新驗收需使用新的隔離 run。這不會清除或修改開發資料庫。

若建立中途失敗，狀態會留為 `creating`，新 run 的資源可能部分建立；工具會保留它們供診斷，不會自動刪除。若該 run 容器仍健康，且 `resume` 的精確身分檢查與 migration 前「只有 PostgreSQL 系統 schema、沒有使用者資料表」檢查通過，可用 `npm run db:test:resume -- <run-id>` 續跑。若資料庫已改變、容器不健康或身份不符，停止並先唯讀盤點；任何移除動作都需另行授權。
