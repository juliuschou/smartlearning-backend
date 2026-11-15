# M01 後端實作規劃

## Context
使用者指定以 M01 帳號與登入管理需求規格為實作規劃依據。M01 定義了登入、登出、密碼管理、個人資料、Session 與安全驗收，但後端目前是沒有業務 Controller 的 NestJS 骨架。Prisma schema 已有帳號、角色關聯、一次性連結與 Session 模型；這不代表相應服務流程已存在。計畫目標是建立可執行且可驗收的 M01 分階段實作路線，避免把未核定的安全、憑證、部署契約當成既定前提。

## 已知依賴與限制
- 權威需求及用語：`/home/user/projects/smartLearning/docs/智學互動平台/20_系統分析/M01 帳號與登入管理—使用者需求與驗收規格.md`、`GLOSSARY.md`。
- Bootstrap 須與 M01 一般登入／M03 邀請分離；建立初始帳號及 `SYSTEM_ADMIN` 關聯需同一 DB transaction。指令、執行身分、入口停用、初始憑證交付／期限／首次登入仍待部署契約核定，依《第一個帳號與角色建立指引》及《待決議事項與選項》。
- M03 負責教師帳號生命週期與管理欄位；M02/M04 分別負責角色管理及授權映射。M01 不應越權指派角色或取代其他模組。
- 目前 `src/app.module.ts` 是空模組；OpenAPI 由 `src/main.ts`、`src/openapi.ts` 提供。Prisma schema/migration 已有 `user_account`、`user_role`、`role`、`one_time_link`、`login_session` 等模型；需先核對完整欄位、索引和跨模組契約，不能僅依 schema 推斷行為。
- 資料庫整合驗收須使用該次新建、隔離、可銷毀的測試 DB；不得重用現有保留環境。Docker、migration 或資料庫操作依 repo 規則另行授權，本計畫不構成操作授權。

## 建議分階段執行
1. **Checkpoint A — 契約盤點與待決事項收斂**：逐項追溯 M01 Gherkin 到 M02/M03/M04、Bootstrap 指引、schema/migration。列明 Email 正規化與驗證、Session 憑證傳遞（Cookie／Bearer）、CSRF 與安全屬性、idle／absolute expiry 判斷、密碼政策完整範圍、郵件交付及失敗重試、一次性連結原子消耗、跨模組 60 秒寄送限制、稽核與錯誤回應、Bootstrap 身分及憑證交付等尚未落地契約。記錄決策責任、驗收條件及安全預設；影響安全或公開 API 的未決項先停在此 checkpoint。
2. **Checkpoint B — 認證與 Session 垂直切片**：按已核定契約建立共用錯誤回覆、輸入驗證、帳號認證、Session 建立／驗證／登出／撤銷及受保護路由 guard。覆蓋登入成功／失敗、一般化錯誤、停用或未驗證帳號拒絕、多裝置、閒置 30 分鐘／絕對 24 小時逾期、登出立即失效；不得加入規格禁止的登入失敗限流、延遲或鎖定。同步完成單元／API 測試和 Swagger 契約。
3. **Checkpoint C — 本人資料與密碼變更**：實作本人資料讀寫及欄位 allowlist，禁止由請求指定他人識別或角色；實作目前密碼驗證、核定密碼政策及成功後撤銷該帳號所有 Session。Email 更新先落實重新驗證、未驗證期間禁止登入、大小寫／空白正規化與唯一性競態契約。
4. **Checkpoint D — 密碼重設及共用一次性連結**：實作安全 token 雜湊儲存、單次原子消耗、30 分鐘期限、重放／過期／重發行為、帳號存在與否一致的回應、成功後全帳號 Session 撤銷。與 M03 邀請／Email 驗證共用每帳號 60 秒寄送限制，測試併發、寄送失敗與可安全重試；若 M03 尚無共用服務，先明確訂出共同 enforcement／transaction 邊界，不各自實作可繞過的限制。
5. **Checkpoint E — Bootstrap 與跨模組整體驗收**：僅在部署契約定案後實作受控一次性 CLI／部署工作；以單一 transaction 建立啟用帳號及有效 `SYSTEM_ADMIN` 關聯，覆蓋冪等、失敗回滾與入口停用；不提供公開註冊 API。整體逐條核對 Gherkin、M02/M03/M04 整合契約及 OpenAPI。

## 主要修改範圍（實作時依 checkpoint 裁定）
- NestJS：`src/app.module.ts`、`src/main.ts`，新增 auth/session/profile/password 模組及 controller、service、guard、DTO、共用錯誤處理（目錄遵循 repo 慣例）。
- Prisma：`prisma/schema.prisma`；只有在盤點證明不足且獲准後新增 forward-only `prisma/migrations/*`，不得改寫已部署初始 migration。
- OpenAPI／規格：`src/openapi.ts`、M01／Bootstrap 指引及必要後端文件；命名依 GLOSSARY，契約符合共用 API 規則。
- 測試：新增單元、API 及隔離 DB 整合測試，覆蓋競態唯一性、連結單次消耗、Session 撤銷及 transaction rollback。測試前檢查 `test/setup/db.ts` 等實際呼叫鏈是否執行 migration，並先完成必要授權。
- 任務追蹤：更新 `tasks/todo.md`，每個 checkpoint 記錄結果與未驗證項目。

## 驗收、風險與回復
- 逐階段先跑最小單元／模組測試，再擴大至 typecheck、lint、build、OpenAPI export/contract 檢查。DB 測試只對本次新建隔離 disposable DB 執行，保留 run identity、生命週期與精確清理證據。
- 行為驗收至少證明：登入錯誤不洩漏帳號差異；不因失敗次數限流／鎖定；每種 Session 撤銷情境立即拒絕；閒置及絕對期限邊界正確；重設連結併發僅能成功消耗一次；帳號本人欄位隔離；回應及 log 不包含密碼、token 或敏感資料。
- **風險：高**（認證、授權及帳號資料）。偏好向前相容 migration、先加後切；每階段保持可回退。應用回退不等於 DB rollback，需依實際 migration／資料效果制定，禁止對 dev/shared DB 未授權變更。
- 未完成契約、未執行測試或環境阻礙一律明確記為 BLOCKED／NOT RUN，不可宣稱驗收通過。
