# AI Agent 操作行為邊界

在協助開發本專案時，你必須嚴格遵守以下約束：

## 1. 任務與狀態追蹤 (State Management)

- **禁止過度對話:** 如果單一任務步驟（如 Checkpoint A）完成，必須總結當前進度並寫入 `tasks/todo.md`，然後提示使用者「可以開啟新 Session 繼續下一個 Checkpoint」，避免 Token 滾雪球。
- **手動確認點:** 若規格計畫書中標示為 `Checkpoint`，必須停下來回報狀態，等待人類使用者回覆授權後，才能繼續執行。

## 2. 資料庫與環境安全 (Safety & Database)

- **禁止未授權的資料庫結構異動:** 除非使用者明確指示，否則不得主動執行 migration、schema push、DDL 或其他資料庫結構修改。
- **注意隱式操作:** 已知 `test/setup/db.ts` 內部會自動執行 `migrate deploy`。在執行測試前，必須先向使用者確認是否允許該隱式操作。
- **禁止跨環境污染:** 嚴禁在 `NODE_ENV=development` 執行會清空資料的指令。

## 3. 節省 Token 策略 (Context Optimization)

- **精準閱讀:** 尋找檔案時，優先透過目錄結構與檔名猜測路徑，避免使用全域的 `find` 或 `grep` 掃描整個專案。
- **忽略編譯檔:** 絕對禁止讀取 `node_modules/`、`dist/` 或是超大型 Log 檔。
- **限制終端機輸出:** 執行測試或構建指令時，若預期輸出過長，請使用 bash pipe 限制長度，例如：`npm run test:e2e | tail -n 100`。

## Windows／WSL2／Rancher Desktop 操作規範


### 1. 操作分級與授權

- 執行前辨識操作屬於：
  1. 離線閱讀、靜態檢查或 mock 測試。
  2. 即時唯讀檢查，例如 Docker metadata、SQL 或排程查詢。
  3. 異動操作，例如備份寫入、服務啟停、應用啟動或排程修改。
  4. 高風險操作，例如 migration、truncate、還原覆寫、
     Snapshot restore、Factory Reset、unregister 或刪除。
- 在既有任務授權範圍內執行，不重複索取已取得的授權。
- 未授權的異動或高風險操作，須先完成可供審閱的具體方案，
  列明目標、影響、驗證與回復方式，再等待使用者核准。
- 備份、健檢或復原請求不得推定包含 migration、資料清除、
  主機中斷或排程部署授權。
- 根目錄 Compose 與測試入口可能隱式執行 migration／truncate；
  執行前必須檢查實際呼叫鏈。

### 2. 身分與資料保護

- 操作前核對適用的 context、engine、container、volume、
  database、備份 generation 與 ownership。
- 禁止修改 pinned 身分或略過 guard，只為讓操作通過。
- 身分漂移、共用 writer、備份損壞或 ownership 不明時，
  停止相關操作並保留證據。
- 不將 retained test 資源直接視為 development／production 資源。
- 不輸出私密設定、憑證、完整環境變數、資料列或未脫敏原始日誌。
- 不覆寫 immutable manifest，不重用 consumed run ID，
  不自動清除失敗資產或備份。

### 3. Sub-agent 委派規則

- 主代理對任務範圍、授權、安全與最終結論負責；
  委派不會擴大任何代理的權限。
- 每次委派須提供：
  - 單一目標與預期交付。
  - 允許讀取／修改的檔案或資源。
  - 允許的命令類型、禁止事項與停止條件。
  - 已取得授權的具體範圍；未列明的異動不得推定已授權。
- Sub-agent 預設只做閱讀、分析與離線驗證。
  修改檔案或執行即時操作必須在委派內容中明確指定，
  且不得超出使用者既有授權。
- Sub-agent 不得自行執行 migration、資料清除、服務啟停、
  Snapshot、排程修改或外部傳送；需要時回報主代理統一處理。
- Sub-agent 不得自行轉委派，除非主代理明確允許，
  並將相同限制傳遞給後續代理。

### 4. 並行與共享狀態

- 可並行進行獨立的閱讀、分析與 mock 測試。
- 會修改同一檔案或操作同一 DB、volume、備份目的地、
  排程或服務生命週期的工作，須由主代理序列化。
- 不以工具內部鎖取代代理之間的協調；
  不保證共用同一鎖的工具不得並行操作共享資源。
- `tasks/todo.md` 與 `tasks/lessons.md` 由主代理統一更新；
  sub-agents 回傳摘要，避免競寫工作紀錄。
- 主代理不得在 sub-agent 尚可能操作資源時進行清理、
  重啟或交接；先確認其工作已停止。

### 5. 證據與驗收

- Sub-agent 回報須包含：
  - 查閱或修改的檔案及關鍵位置。
  - 實際執行的命令、結果與驗證範圍。
  - 未驗證事項、阻礙與風險。
  - 是否產生檔案、程序或外部資源，以及其保留狀態。
- 主代理須審閱差異與必要證據，不得只依 sub-agent
  的「完成」敘述宣稱成功。
- 區分離線測試、metadata、SQL、應用 readiness、
  備份完整性與實際還原；不得互相替代。
- Windows 原生、整機復原與排程運作能力，
  不得僅憑 Linux mock 測試宣稱已驗收。

### 6. Checkpoint 與大型紀錄

- 主代理負責統一判定正式 Checkpoint 是否完成，
  寫入進度並依既有規定等待使用者授權。
- Sub-agent 的分析完成不視為新的正式 Checkpoint，
  也不得自行跨越既有人工確認點。
- 讀取大型累積紀錄前先確認行數、搜尋章節，
  再讀取指定區間；禁止整份傾印 todo、lessons 或大型 log。
