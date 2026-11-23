# OpenAPI 契約

後端提供實際 API 的 OpenAPI JSON 規格。這份規格是前後端共同依據；前端專案自行選擇工具，依規格產生、驗證及維護其 API 呼叫程式碼。後端不在此 repository 產生或維護前端 client package。

## 取得規格

- 執行中的服務：`GET /openapi.json`
- 本機／CI 匯出：`npm run openapi:export`
- 匯出檔案：`dist/openapi.json`（建置輸出，會被 Git 忽略，不需提交）

`npm run openapi:export` 會先建置 NestJS app，再建立 OpenAPI 文件並檢查 OpenAPI 3 格式與文件版本；此流程不啟動 HTTP server，也不連線資料庫。`npm run openapi:client:check` 會用 `openapi-typescript` 將匯出規格轉成暫存型別檔，確認產生工具能接受這份規格；產物留在被忽略的 `dist/`，不提交，也不代表前端正式 client 已產生或驗證。`npm run openapi:names:check` 會檢查匯出文件中的路徑、操作名稱、標籤、參數及 schema／欄位名稱有沒有使用詞彙規範明確列出的不建議用詞。檢查使用 `tools/openapi/glossary-rules.json` 內由權威詞彙表整理出的規則；詞彙表更新時需同步檢查與更新此檔。

## 服務端點啟用政策

- 非 production 環境預設啟用 `/openapi.json`。
- production 環境預設關閉；部署端明確設定 `OPENAPI_ENABLED=true` 才啟用。
- `OPENAPI_ENABLED=false` 可在非 production 環境關閉端點。
- 啟用 production 端點前，部署方須確認其網路可見範圍符合環境政策。

## 更新流程

1. 修改實際 Controller、DTO、驗證規則或回應行為。
2. 使用 `@nestjs/swagger` decorators 描述真實請求、回應、認證、狀態碼與錯誤；清單 API 也需描述已確認的分頁契約。
3. 執行 `npm run openapi:export` 並檢視 `dist/openapi.json` 中變更的路徑與 schema。
4. 讓前端專案從服務的 `/openapi.json` 或其取得的規格檔更新前端 client；前端工具、輸出位置、測試與版本控制均由前端專案決定。

## 目前 API 範圍與限制

OpenAPI 由 NestJS `src/openapi.ts` 依執行中的 Controller decorators 動態產生，不是手工維護的靜態 endpoint 清單。Auth controller 已提供 CSRF、登入、登出及登入 Session 驗證；帳號本人資料讀取／更新與本人密碼修改亦由該 controller 提供。Roles controller 已提供角色清單／明細查詢、及固定系統角色的啟用／停用狀態維護；角色代碼、名稱及描述於 V1 為唯讀（PUT／DELETE 以 405 回應表述不可變更）。Teachers controller 已提供 `POST /teachers` 新增老師帳號（M03-03）：僅具 `M03_WRITE` 權限的登入系統管理者可呼叫；新帳號一律以 `INVITED` 建立並在同一筆資料庫交易內指派 `TEACHER` 角色、建立 7 天有效的一次性邀請連結與加密 Email 寄件工作；Email 與帳號名稱不分大小寫唯一，重複時回覆 `EMAIL_ALREADY_EXISTS` 或 `ACCOUNT_NAME_ALREADY_EXISTS`（授權管理者專屬端點，無帳號枚舉風險）。重送同一請求不會建立第二個帳號：以 409 衝突回覆做為重送結果；此端點未提供 Idempotency-Key 持久化（批次管理待 M03 後續批次功能補齊）。每次新增或調整實際 endpoint，必須補上 Swagger 描述並執行匯出檢查。

忘記密碼請求與一次性密碼重設 API 已提供，透過持久化加密 Email outbox 排程寄送；只有在套用 `email_outbox` migration、設定 `EMAIL_OUTBOX_ENABLED=true`、Gmail SMTP App Password、`PASSWORD_RESET_URL` 與 `RESET_OUTBOX_ENCRYPTION_KEY` 後才會啟用。`PASSWORD_RESET_URL` 必須是無 query、無 fragment 的乾淨 HTTP(S) 頁面網址；Backend 將一次性 token 加在 `#token=...` fragment，避免 token 進入 HTTP request URL 或 referrer。公開請求回覆不揭露帳號是否存在，寄送失敗由 outbox 重試並以不含收件人／token／秘密的伺服器紀錄告警。`RESET_OUTBOX_ENCRYPTION_KEY` 應以 `openssl rand -base64 32` 產生並在 pending 郵件排空前保持不變；Gmail SMTP App Password 應由部署 secret 管理機制注入。`POST /teachers` 的邀請信同樣經加密 outbox 寄送，使用 `TEACHER_INVITATION_URL`（同樣必須是無 query、無 fragment 的乾淨頁面網址，token 加 fragment）；現行 outbox 寄送程序仍以密碼重設流程為主要已驗證路徑，邀請信送達流程屬 M01/M03 邀請啟用功能的後續工作。
