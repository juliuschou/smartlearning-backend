# 持續可用的本機資料庫與每日備份方案（2026-10-15）

狀態：Checkpoint 1 已實作並通過實際備份／安全失敗驗收，操作入口與證據見 [README](README.md#reusable-daily-backup-command--checkpoint-1-2026-10-15)。排程、local-state-file 通知及 retention dry-run 已部署；fresh daily restore/runtime 已通過。第二副本已取消；七天自動排程來源驗收及冷啟動／Snapshot 仍待完成。以本機 retained test DB 為範圍，不承諾 production parity。

## 成功定義與已知基線

來源沿用 `compose.local-db.yml` 與 `local-db.py` 固定的 default engine、image digest、external volume `sl-w3-w3-env-20261005T143441Z-e5560ea0-pgdata`、容器 `smartlearning-local-db`、loopback 5432。用途為 `smartlearning_test`；正式 development DB 的資料來源、帳號及 provisioning 另案決定，不更名或挪用歷史還原 cluster。

2026-10-15 完整復原證據見 [README](README.md#fresh-full-recovery-acceptance-2026-10-15) 及 `artifacts/local-env/sl-full-recovery-20261015-01/result.json`：backup 6.236 秒、restore/compare 13.752 秒、app readiness 1.036 秒、含診斷與重試的 wall elapsed 365.697 秒。這些不證明冷啟動或 RPO/RTO 達標，亦不代表現在即時健康。

建議目標（待採納）：每日 20:00 Asia/Taipei 備份；資料時間點間隔目標 24 小時，超過 24 小時即顯示 RPO 風險、26 小時升級告警；本機還原 RTO 60 分鐘、整機故障 RTO 4 小時。每日排程加執行耗時與漏跑仍可能超過 24 小時，不能宣稱嚴格 24 小時保證；若需硬性上限，應提高頻率、預留故障補跑時間，必要時另設 WAL/PITR。電腦關機期間無法保證每日執行。

## 1. 日常運作與冷啟動

日常順序：`python3 tools/dev/local-db.py status` → 必要時由操作者執行 `start`（不存在才 `up`）→ `node tools/dev/local-db-verify.cjs` → source-hash 相符的 compiled app → parsed `/health/ready` HTTP 200，db healthy、Redis off、memory limiter。失敗停在當層並輸出脫敏原因；backup 本身不得自動啟動 DB 或未知服務。

最小 gate 擴充：SQL helper 增加 `current_schema()=public`、`pg_is_in_recovery()=false`；測試入口先完成 engine/volume/DB/role/migrations 身分 gate，再交給原測試命令。gate 不代表授權 migration；DB-backed Jest 仍因隱式 migrate deploy 禁止執行，直到另獲授權。測試可能清資料，不能以 gate 取代 fixture／保留資料隔離。

冷啟動使用 repo 內受版本控管的 runner；build 放持久、Git ignored 且限制權限的專用目錄，保存 source hashes，缺失／過期時從工作樹重新 build，不依賴 /tmp。不複製 `.env.test`，僅原位記憶體讀取。將 Node/Python/PostgreSQL client 版本、Windows 帳號 SID、WSL distro、Rancher engine、repo 絕對路徑及 secret 可用性列為冷啟動契約。`unless-stopped` 不能取代 Windows/WSL/Rancher 啟動驗收。

## 2. 可重用備份命令與發布協定

新增 `tools/dev/daily-backup.py`（不重播 full-recovery.py）。預定介面：`review`、`run --run-id <fresh-id>`、`status`、`retention --dry-run`；`review` 預設完全離線。run ID 使用 UTC 時間與隨機尾碼，exclusive create；碰撞即失敗，不覆寫或自動續接。

流程：
1. 一次有界 preflight：拒絕 Docker endpoint 覆寫，驗證 pinned engine/image/owned container/volume、唯一 writer、SQL DB/role/schema/primary 身分與 cluster system identifier。來源離線直接失敗，不反覆盤點歷史 metadata。
2. 核實 Windows D 掛載身分與 Windows 路徑對應、非 symlink/reparse 轉址、寫入權限及可用空間。目的地固定 `D:\Backups\SmartLearning\daily-v1`；失敗不 fallback WSL。建立 fresh `<run-id>.partial`，先以 Windows ACL API 驗證 protected inheritance、owner 及 current-user/SYSTEM/Administrators allowlist，再寫敏感內容。實際子檔也驗 ACL；POSIX chmod 不能取代 Windows ACL。
3. 使用來源相容 pg_dump：password-free globals、postgres 與 smartlearning_test custom dumps。每 DB 用同一 exported REPEATABLE READ snapshot 供 dump 與結構／資料摘要使用；多 DB 不宣稱全 cluster 同時點。全程不改來源 role/password/HBA，不 dump role passwords。保存還原所需 owner/ACL/database properties；新出現 DB、sequence、large object 或未支援物件時 fail closed，先更新 coverage，不能默默遺漏。
4. 總 timeout 初設 15 分鐘，單次 Docker/SQL 查詢 10 秒、dump 240 秒；snapshot exporter 有存活界限，逾時關閉自有子程序與交易。全域 exclusive lock 涵蓋 run、copy、retention，Windows launcher 與 CLI 共用；stale lock 不憑年齡自動奪取。
5. 驗證非空 dump、pg_restore --list、archive/database 對應、SHA256 回讀、ACL、摘要完整性；空 postgres 可有合法空 TOC，不能要求存在 TABLE。這只標記 backup-verified，restore-verified 必須另有實際還原證據。
6. 在 partial 內最後寫 success manifest（schema version、owner marker、run ID、來源身分、snapshot 時間、起迄、工具版本、檔名/大小/hash、驗證範圍），flush 關閉後於同 filesystem rename 為 `<run-id>`。rename 與 crash 邊界須實測；消費者一律只接受正式目錄、完整 manifest 與吻合 hashes，不能只看檔名。發布後才原子更新 last-success index；index 遺失可從正式 manifests 重建，index 不是真實來源。
7. 失敗 exit nonzero，保留受限 partial 與脫敏診斷，不改 last-success。repo 僅放狀態／摘要，不放資料 dump、credentials、row payload 或 child 原始 log。首次沒有歷史大小時預留至少 2 GiB 或 DB size 的三倍，後續取此值與最近成功備份三倍的較大值；空間不足停止，不自動刪備份騰空間。

角色密碼不在 globals；災後須由獨立安全來源取得／重新設定憑證，只能改新還原 cluster。D 槽加密狀態待確認，ACL 不等於加密。

## 3. 每日排程、失敗與過期監測

選擇 Windows Task Scheduler 作為啟動器，明確以固定 Windows 帳號、指定 WSL distro/user、固定 cwd/PATH、repo runner 路徑觸發；不依賴互動 shell。提出每日 20:00 台北時間執行、錯過後於下一可用時段補跑、不喚醒電腦；初次部署核實 Windows 時區與排程匯出的定義。若使用者需要無人值守於登出狀態運作，必須先驗證帳號登入模式及 Rancher 可用性，不預設可行。

啟動器傳回 WSL 實際 exit code；禁止重疊，失敗 15 分鐘後至多重試兩次，各次用 fresh run ID。超過一次執行預算就終止自有 process tree 並記錄失敗，不能留下 snapshot exporter。WSL/Rancher/掛載不可用時 fail closed，提醒操作者啟動；不暗中啟動未知服務。下一登入／恢復時比較 snapshot 年齡，只補一份最新備份，不偽造漏掉日期。

另建 Windows-native watchdog：開機／登入及每小時查正式 manifest 的資料時間點、last attempt、明示 cancelled/not-required 的第二副本政策，不能只依賴 backup 自己的 log。將「未曾成功」「執行失敗」「排程未跑／超過24h」「超過26h」分別呈現；成功後發恢復事件，事件去重，通知本身失敗也留獨立 Windows 狀態。測試用 fake clock 與測試目錄，不修改系統時間。

本機狀態可用 Windows 通知與受限狀態檔；跨主機通知需使用者指定通道與收件目的地後才實作。主機完全關機時 Windows watchdog 也無法告警；要涵蓋此故障必須有外部 dead-man heartbeat（只傳 run ID／時間／狀態，不傳 DB 身分或資料）。已部署的 exact task／帳號／distro 見 README；本政策更新不重建排程或發送外部訊息。

驗收：手動成功；DB unavailable、掛載缺失、ACL拒絕、空間不足與鎖衝突；任務未執行與26h過期；重試上限、補跑、通知及恢復通知均有可觀察 exit/status；至少連續七天排程成功才標記日常運作驗收。

## 4. 保留策略與第二份備份

提案：每日版本30天、每週版本8週、每月版本12月，取聯集且至少保留7個 backup-verified generations。每個故障範圍至少保留最近一個 restore-verified run 及更新的可用版本。partial 不算 generation；初期不足下限只累積。

retention 先 dry-run，逐筆列 exact run/path/hash、保留／淘汰理由；只管理 daily-v1 owner marker 與合法成功 manifest，歷史 full-recovery/C 備份、既有 volume、未知目錄完全排除。任一最新備份失敗、驗證損壞或沒有已驗證還原基線時停止淘汰；實際刪除須另授權具體清單，重新驗證 lock/身分/hash。第一版不啟用無人值守刪除。

第二副本已由使用者取消（CANCELLED / not-required），不再要求目的地或將不存在副本視為 degraded，也不宣稱 copy-verified。D 槽實體故障範圍與跨主機／磁碟災害保障未獲證明。取消不授權刪除；retention 仍因 restore-baseline／latest-attempt receipt 尚未獨立串接而 keep-blocked。已通過的 daily restore/runtime 證據不能改寫發布時 immutable manifest 的 restoreVerified=false；將來接 receipt 必須核實 exact generation／manifest digest。

## 5. 還原、重啟與 Snapshot 演練

每月從正式備份選一份於 fresh run ID／獨立 volume/network、loopback 55433 還原；先驗目的地內容 hashes，再比對資料/結構/ACL/database properties，包含 sequences/large objects 的明確 coverage。還原 DB 的 system identifier 必須不同於來源，cluster_name、DB、schema、role、primary 獨立證明。還原驗收不在來源寫資料。

先比對再啟動 compiled app；只替換子程序內 DB endpoint，驗 parsed /health/ready 200、db healthy、Redis off、memory limiter。不將演練 trust 規則搬到來源；新 cluster 使用明確限制的認證配置。記錄 backup snapshot 年齡、copy/download、restore、compare、app-ready、wall elapsed（含 build、重試及人工等待），分開 execution time。最後 stop 自有 app/restore container，保留資產，清理刪除另授權。

每季或重大升級前另授權主機重啟演練：先完成一份完整性已驗證且具還原實測證據的正式備份，記錄所有受影響服務、允許中斷時段、登入/secret/build 路徑與失敗回復步驟；重啟後走 engine → source身分 → SQL → app readiness → 漏跑補備份。RTO 自服務中斷開始至實際 readiness，不以 pg_isready 結束。

Snapshot 演練單獨授權：先核實現有 Rancher 版本與官方支援流程，明列會覆寫的整個環境／其他服務，不直接對現有工作環境 restore。優先使用隔離可拋棄環境驗證建立／恢復；不能隔離時另訂停機窗口及完整受影響清單。先保存外部邏輯備份與回復路徑，再操作 Snapshot；Snapshot 不取代跨主機備份。缺少必要可用金鑰或回復路徑就阻擋演練；第二副本已取消，不是前置條件。

## 6. 分階段授權與第一個實作 Checkpoint

| 階段 | 具體交付與驗收 | 邊界 |
|---|---|---|
| Checkpoint 1 | 可重用 runner、Windows ACL helper、離線回歸測試；一次 fresh 實際備份成功發布及一次在來源操作前注入的安全失敗；證明 last-success 不變 | 新 external run 目錄、source唯讀 SQL/dump；不建還原 volume、不改來源、不排程 |
| Checkpoint 2 | Windows launcher/watchdog、retention dry-run、失敗/漏跑/過期通知測試，七天運作證據 | 排程持久化與通知通道需授權；無刪除 |
| Checkpoint 3 | CANCELLED：使用者取消第二副本 | 不要求目的地、不上傳、不作後續前置條件 |
| Checkpoint 4 | fresh volume 還原與runtime、冷啟動、Snapshot演練及RPO/RTO報告 | 還原/runtime寫入、主機中斷、Snapshot覆寫分別明確授權 |

Checkpoint 1 預定檔案：`daily-backup.py`、`daily-backup.test.py`、`daily-backup-dir.ps1`、README；必要時僅對既有 source SQL helper 加上述兩個斷言。第一輪以 `python3 -B tools/dev/daily-backup.test.py`（mock filesystem/Docker/clock、無 DB）及語法檢查證明：collision、mount/ACL/space、timeout/lock、空TOC、hash失敗、publish前後crash、last-success恢復；再做實際成功與安全失敗，不用 metadata-only 交付取代 runtime 路徑。需 source-hash build 的工作集中在 Checkpoint 4，不能依賴舊 /tmp driver。

執行前在同一授權範圍內形成 exact fresh run ID/path 與 timeout 記錄；第一次實際失敗情境選測試用拒絕目的地，不能卸載磁碟／停止來源／破壞既有 dump。若來源不可用只執行一次必要preflight並指出直接阻礙，不重新追溯已解決歷史。如果只反覆查 metadata 而未縮短 runtime 阻礙，須直接提醒「這已偏離你的目標」。

風險：medium，敏感外部備份、來源dump負載與新檔案；後續排程／Snapshot為更高風險。Checkpoint 1 rollback：停止自有runner、釋放snapshot交易、保留受限partial與舊正式run；來源不需回滾，發布已成功時不刪除或倒退index。排程 rollback 為停用此次 exact task、停自有子程序並保留備份；來源服務維持既有設定。Snapshot rollback 必須在部署前補 exact 環境流程，未補不執行。

## 尚待使用者決策（合併確認）

排程與 retention 設定已採用並部署；第二副本已取消。外部 heartbeat 與第二副本分屬不同議題；目前 local-state-file 通知無法涵蓋主機完全關機。fresh daily restore/runtime 已 PASS（見 README 的 2026-10-15 驗收），後續為測試資料異動入口防呆、另授權冷啟動及 Snapshot／整機 RTO。七天自動來源觀察可平行進行。
