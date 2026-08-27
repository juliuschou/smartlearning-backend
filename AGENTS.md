# AI Agent 操作行為邊界

在協助開發本專案時，你必須嚴格遵守以下約束：

## 1. 任務與狀態追蹤 (State Management)

- **禁止過度對話:** 如果單一任務步驟（如 Checkpoint A）完成，必須總結當前進度並寫入 `tasks/todo.md`，然後提示使用者「可以開啟新 Session 繼續下一個 Checkpoint」，避免 Token 滾雪球。
- **手動確認點:** 若規格計畫書中標示為 `Checkpoint`，必須停下來回報狀態，等待人類使用者回覆授權後，才能繼續執行。

## 2. 資料庫與環境安全 (Safety & Database)

- **禁止未授權的 Migration:** 除非使用者明確指示，否則**絕對禁止**主動執行 `npx prisma migrate deploy` 或 `prisma db push`。
- **注意隱式操作:** 已知 `test/setup/db.ts` 內部會自動執行 `migrate deploy`。在執行測試前，必須先向使用者確認是否允許該隱式操作。
- **禁止跨環境污染:** 嚴禁在 `NODE_ENV=development` 執行會清空資料的指令。

## 3. 節省 Token 策略 (Context Optimization)

- **精準閱讀:** 尋找檔案時，優先透過目錄結構與檔名猜測路徑，避免使用全域的 `find` 或 `grep` 掃描整個專案。
- **忽略編譯檔:** 絕對禁止讀取 `node_modules/`、`dist/` 或是超大型 Log 檔。
- **限制終端機輸出:** 執行測試或構建指令時，若預期輸出過長，請使用 bash pipe 限制長度，例如：`npm run test:e2e | tail -n 100`。
