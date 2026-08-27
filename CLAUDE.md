# SmartLearning Backend 專案開發指南

## 技術棧與核心架構

- **Framework:** NestJS 11
- **Database ORM:** Prisma 7 + PostgreSQL
- **Realtime:** Socket.IO (`/live` namespace, 注意：需手動解析 handshake cookies)
- **Security:** Argon2id (密碼雜湊), Pino redaction, UUID v7 (App-generated IDs)

## 測試規範 (Testing)

1. **測試資料庫:** 僅限使用 `smartlearning_test` (Host: localhost:5432)。

2. **隔離機制:** DB-backed 測試會在 `beforeEach` 呼叫 `truncateAll()`，這會清空資料。

3. **指令:** 
   
   - E2E: `NODE_ENV=test npm run test:e2e`
   
   - Integration: `NODE_ENV=test npm run test:integration`

4. **注意事項:** Realtime 測試必須在觸發 REST mutations「之前」註冊事件監聽器。

## Agent 初始標準動作 (SOP)

每次啟動新 Session 時，你必須：

1. 優先讀取 `tasks/todo.md` 來了解當前的開發進度與 Checkpoint。
2. 閱讀相關的規格書（位於 `docs/智學互動平台/` 下），確認需求再動手。

## 讀取 AGENTS.md

在開始任何程式碼修改或執行終端機指令前，你必須先讀取 `AGENTS.md` 以確認你的操作邊界與安全限制。
