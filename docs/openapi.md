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

## 目前限制

目前 `src/` 僅是最小 NestJS 啟動骨架，尚無業務 Controller、DTO 或 API endpoint。因此目前產出的規格只有 API 基本資訊與空的 `paths`；這不代表業務 API 已存在或已完成文件化。新增業務 API 後，必須為每個實際端點補上 Swagger 描述並檢查匯出內容。
