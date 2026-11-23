# Lessons

## PostgreSQL 系統 schema 不應誤判為使用者資料

- **Failure mode:** 新建 PostgreSQL DB 的空資料驗收查詢只排除 `pg_catalog` 與 `information_schema`，漏掉 `pg_toast` 等以 `pg_` 開頭的系統 schema，讓乾淨資料庫被錯誤判為非空。
- **Detection signal:** PostgreSQL healthy、DB identity 正確、沒有使用者資料表，但 `information_schema.schemata` 仍列出 `pg_toast`；驗收工具在 migration 前中止。
- **Prevention rule:** 判斷使用者 schema/table 時排除所有 `pg_` 系統 schema（並明確允許 `public` 與目標 app schema），同時分開查詢資料表與 schema；先在新鮮空 DB 驗證 catalog 查詢，才執行 migration。
- **Tripwire:** disposable DB 的 pre-migration check 必須回報使用者 schema/table 名稱且忽略系統 schema；空資料庫應通過，出現任何非系統使用者物件則 fail closed。

## Shell 提示輸入語法需兼顧 Bash 與 Zsh

- **Failure mode:** 操作手冊使用 `read -p` 提示輸入，但 Zsh 會把 `-p` 解讀為讀取 coprocess，並在沒有 coprocess 時回報 `read: -p: no coprocess`。
- **Detection signal:** 使用者在 Zsh 執行輸入指令時出現上述錯誤；Bash 可用不代表 Zsh 相容。
- **Prevention rule:** 面向 Bash/Zsh 新手的手冊避免使用 shell 專屬的 `read -p`；用 `printf` 顯示提示，再用 `IFS= read -r` 收普通輸入，密碼則加 `-s` 隱藏輸入，並以 Bash 和 Zsh 語法確認。
- **Tripwire:** 搜尋交付給使用者的 shell 指令是否含 `read -p`；若手冊宣稱支援多種 shell，對互動輸入語法分別做 Bash/Zsh 相容性檢查。

## BLOCKED 前置條件必須阻止使用者執行後續範例

- **Failure mode:** 操作文件雖說測試帳號不存在並標記 BLOCKED，後文仍把 Login 指令展示成可直接執行，使用者因此輸入佔位文字並收到失敗回覆。
- **Detection signal:** 文件同一流程既寫「先停下／無法繼續」，又顯示沒有被明確禁用的可複製命令。
- **Prevention rule:** 若前置條件未滿足且沒有可用解法，緊鄰命令區塊以醒目狀態標記「不可執行」，並在相關步驟直接寫 BLOCKED；不要讓下游範例看起來像現行可操作步驟。
- **Tripwire:** 文件審閱時搜尋 `BLOCKED`、`先停`、`不可執行`，檢查同一區塊後是否仍緊接可複製命令，並確認有清楚解鎖條件。

## 使用者要求修正時不要把執行授權誤解成改方向

- **Failure mode:** 使用者明確要求修正既有失敗後，回覆要求選擇方向，令其澄清「不是改方向」並延誤修正。
- **Detection signal:** 使用者給出明確修正要求與失敗證據，但回覆仍把決策退回使用者，而不是依證據採取最小修正。
- **Prevention rule:** 把「修正」視為授權改動目標程式；先保留原始行為契約，修正已定位的根因。只在會觸及未授權共享資源時停止該驗證步驟，不能把它擴大成不執行程式修正。
- **Tripwire:** 結束前確認已有最小程式變更，並分開標示已完成的程式修正、已執行的安全檢查，以及任何因授權邊界而未執行的共享資源測試。

## 先解決使用者眼前的登入阻塞

- **Failure mode:** 使用者詢問登入畫面帳密從哪裡取得時，回答偏重風險說明與抽象流程選擇，沒有直接提供能建立手動登入帳號的步驟／工具。
- **Detection signal:** 使用者明確再次指出其目標是建立帳號密碼並手動登入驗證。
- **Prevention rule:** 先確認登入介面實際缺少什麼，區分自動測試 transient fixture 和人工可登入帳號；提出能讓操作者建立自己知道密碼的本機測試帳號的具體方案，再列出資料庫授權與安全限制。
- **Tripwire:** 最終交付必須包含可操作的建立命令、帳密由誰設定／如何取得、手動登入路徑、精確撤銷步驟，以及哪些步驟因資料庫授權尚未執行。

## Readline 互動提示必須由同一個介面輸出

- **Failure mode:** CLI 先用 `process.stdout.write` 寫提示，再建立 `readline.Interface` 並以空 prompt 問題，互動終端可能看起來停住、沒有可見輸入提示。
- **Detection signal:** 指令已進入 Node 程序，但終端只顯示啟動命令與游標，沒有 Email／輸入提示。
- **Prevention rule:** 普通文字輸入直接使用 `rl.question(提示字串, callback)`；隱藏輸入則在切換 raw mode 後輸出明確提示。每個互動步驟都要有可見提示，且非 TTY 時安全拒絕。
- **Tripwire:** 對互動式 CLI 檢查每個 `question` 都帶非空提示；人工驗收時確認第一個提示在輸入前可見，不能只以非互動測試通過代表 UX 已驗證。

## 更新 task checklist 前必須保留既有歷史

- **Failure mode:** 以整檔 Write 建立新任務區塊，覆寫了累積中的 `tasks/todo.md` 歷史紀錄。
- **Detection signal:** `git diff --stat` 顯示 todo 檔大量刪除，遠超本次新增任務區塊。
- **Prevention rule:** 更新任務追蹤前先讀取完整檔案；以精確 Edit 在尾端附加區塊，不得用 Write 替換累積檔案。若發現覆寫，保留證據並取得使用者同意後才從基準版本恢復。
- **Tripwire:** 修改前後比對 `git diff --numstat -- tasks/todo.md`；若刪除行數非預期，停止交付並先確認恢復方案。
