# Lessons

## PostgreSQL 系統 schema 不應誤判為使用者資料

- **Failure mode:** 新建 PostgreSQL DB 的空資料驗收查詢只排除 `pg_catalog` 與 `information_schema`，漏掉 `pg_toast` 等以 `pg_` 開頭的系統 schema，讓乾淨資料庫被錯誤判為非空。
- **Detection signal:** PostgreSQL healthy、DB identity 正確、沒有使用者資料表，但 `information_schema.schemata` 仍列出 `pg_toast`；驗收工具在 migration 前中止。
- **Prevention rule:** 判斷使用者 schema/table 時排除所有 `pg_` 系統 schema（並明確允許 `public` 與目標 app schema），同時分開查詢資料表與 schema；先在新鮮空 DB 驗證 catalog 查詢，才執行 migration。
- **Tripwire:** disposable DB 的 pre-migration check 必須回報使用者 schema/table 名稱且忽略系統 schema；空資料庫應通過，出現任何非系統使用者物件則 fail closed。
