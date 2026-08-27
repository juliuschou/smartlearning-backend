# SmartLearning Backend API — 前端開發基準

後端 NestJS 11，所有 HTTP 端點在 `/api/v1` prefix 下（health probes 除外）。本文為前端開發基準，涵蓋老師出題、課堂使用（teacher）、學員課堂使用三大功能。

> 生成日期：2026-08-27。對應後端 runtime：Phase B student/enrollment/account-bound participant、兩個契約修正（`/auth/session` expiresAt、batch preview clientRef）及 Checkpoint D 回歸證據；archive/retention 與 durable realtime/replay 仍為 deferred。

---

## 0. 通用契約（前端必讀）

### 0.1 回應 envelope

所有 versioned HTTP 回應統一形狀。

**成功**：
```json
{
  "data": { /* 內層 DTO */ },
  "meta": { "schemaVersion": 1, "requestId": "string" },
  "error": null
}
```

**錯誤**：
```json
{
  "data": null,
  "meta": { "schemaVersion": 1, "requestId": "string" },
  "error": {
    "code": "ERROR_CODE",
    "message": "人類可讀訊息",
    "blocking": true,
    "field": "可選欄位",
    "nextStep": "可選下一步提示",
    "retryAfterSeconds": 0
  }
}
```

> ⚠️ OpenAPI/Swagger 顯示的是**內層 DTO**，前端 client 必須自己從 `data` 解開。錯誤碼穩定不變，前端可據 `error.code` 分流處理。

### 0.2 認證

- **Web Session**：`POST /auth/login` 成功後伺服器 `Set-Cookie` 兩個 cookie：
  - `__Host-session`（HttpOnly，session token）
  - `__Host-csrf`（非 HttpOnly，前端可讀）
- 後續請求瀏覽器自動帶 session cookie。前端讀 `__Host-csrf` 的值作為 CSRF token。

### 0.3 CSRF（所有 mutation 必須）

凡 `POST/PUT/PATCH/DELETE` 需同時滿足：
1. `Origin` header 在 `CORS_ORIGIN` allowlist 內（exact match）
2. `X-CSRF-Token` header 等於 `__Host-csrf` cookie 值（constant-time 比對）

`GET` 不需 CSRF。`POST /auth/login` 刻意不套 CSRF。

### 0.4 Idempotency-Key（部分端點必須）

下列端點必須帶 `Idempotency-Key: <UUID>` header：
- `POST /live-sessions/:id/submissions`
- `POST /courses/:courseId/question-batches/confirm`（另需 `X-Validation-Token`）

同 key + 同 payload 重試回原結果；同 key + 異 payload 回 `409 IDEMPOTENCY_KEY_CONFLICT`。

### 0.5 Step-up（僅 admin 敏感操作）

admin 的 reset-password / disable / restore / cli-credentials 需先 `POST /auth/step-up`（重新驗密碼），10 分鐘內有效。**老師出題與學員使用都不需要 step-up。**

### 0.6 mustChangePassword

登入回應含 `mustChangePassword: boolean`。若為 `true`，除 `POST /auth/change-password` 外所有路由會回 `PasswordChangeRequired` 錯誤 → 前端應強制導向改密碼頁。

### 0.7 分頁

`GET` 列表端點支援 `?page=1&pageSize=20`，回 `Page<T>`：
```json
{ "data": [ ... ], "meta": { "page": 1, "pageSize": 20, "total": 0, "totalPages": 0 } }
```

> 外層 envelope 的 `meta` 仍是 `{schemaVersion, requestId}`；分頁 meta 在 `data` 內層的 `meta`。前端需注意兩層 meta 的差異。

---

## 1. 老師出題

角色：`teacher` 或 `admin`（student 一律拒）。所有 mutation 需 CSRF。

### 1.1 課程

| Method | Path | 用途 | 守護 | Body/Query |
|---|---|---|---|---|
| POST | `/courses` | 建課程 | Session + CSRF + TeacherOrAdmin + CanCreateCourse | `{ name, description? }` |
| GET | `/courses?page&pageSize` | 列課程（teacher 列自己 owner；admin 目前亦列自己 owner） | Session + TeacherOrAdmin | query |
| GET | `/courses/:id` | 課程詳情（owner/admin 可跨讀，非 owner 404） | Session + TeacherOrAdmin | — |
| POST | `/courses/:id/archive` | 封存（draft→archived，須無 waiting/active session） | Session + CSRF + TeacherOrAdmin | — |

**CourseDto**：
```json
{ "id": "UUID", "name": "string", "description": "string|null",
  "status": "draft|archived", "ownerAccountId": "UUID",
  "createdAt": "ISO", "updatedAt": "ISO" }
```

### 1.2 題目

題型：`poll`（single/multiple）、`open_text`、`quiz`。

| Method | Path | 用途 | 守護 | Body |
|---|---|---|---|---|
| POST | `/courses/:courseId/questions` | 新增題目（course 須 draft） | Session + CSRF + TeacherOrAdmin | CreateQuestion |
| GET | `/courses/:courseId/questions?page&pageSize` | 列題目（archived 可讀） | Session + TeacherOrAdmin | query |
| GET | `/courses/:courseId/questions/:id` | 題目詳情（含正解） | Session + TeacherOrAdmin | — |
| PATCH | `/courses/:courseId/questions/:id` | 全量替換（type/selectionMode 不可改） | Session + CSRF + TeacherOrAdmin | UpdateQuestion |
| DELETE | `/courses/:courseId/questions/:id` | 刪題目 | Session + CSRF + TeacherOrAdmin | — |
| PATCH | `/courses/:courseId/questions/order` | 重排（須完整且不重複；draft、未被 session 選用） | Session + CSRF + TeacherOrAdmin | `{ questionIds: string[] }` |

**CreateQuestion body**：
```json
{
  "type": "poll|open_text|quiz",
  "prompt": "string (≤1000)",
  "selectionMode": "single|multiple",        // poll 必填；open_text/quiz 禁
  "options": [                                // poll 必填 2–10 個；open_text 禁
    { "optionRef": "string?", "text": "string (≤250)" }
  ],
  "correctOptionRefs": ["string"]            // quiz 必填恰一；poll/open_text 禁
}
```

**QuestionDto**（authoring，含正解）：
```json
{
  "id": "UUID", "courseId": "UUID", "type": "...", "prompt": "...",
  "selectionMode": "single|multiple|null",
  "options": [
    { "id": "UUID", "optionRef": "string|null", "text": "...",
      "position": 1, "isCorrect": false }
  ],
  "correctOptionRefs": ["string"],
  "position": 1, "createdAt": "ISO", "updatedAt": "ISO"
}
```

### 1.3 批次出題（validate → confirm 兩階段）

可用 Web teacher（cookie + CSRF）或 CLI（`X-CLI-Key`，免 CSRF）。student 拒。

| Method | Path | 用途 | 必要 header |
|---|---|---|---|
| POST | `/courses/:courseId/question-batches/validate` | 驗證批次 payload，成功發 validation token（15m） | （Web）CSRF |
| POST | `/courses/:courseId/question-batches/confirm` | 原子寫入所有題目（all-or-nothing） | `Idempotency-Key` UUID、`X-Validation-Token`、（Web）CSRF |

**Validate body**：
```json
{
  "schemaVersion": 1,
  "courseId": "UUID?",                // body 可選；path courseId 為實際權威
  "questions": [
    {
      "clientRef": "string",           // 批次內定位用，須唯一
      "type": "poll|open_text|quiz",
      "prompt": "...",
      "selectionMode": "single|multiple?",
      "options": [ { "optionRef": "...", "text": "..." } ],
      "correctOptionRefs": ["..."]
    }
  ]
}
```

**Validate 回應**（`data`）：
```json
{
  "schemaVersion": 1,
  "valid": true,
  "payloadHash": "string",
  "errors": [], "warnings": [],
  "preview": [
    {
      "clientRef": "string",           // ← 回映輸入 clientRef，供前端對應順序
      "type": "...", "prompt": "...",
      "selectionMode": "single|multiple|null",
      "options": [ { "optionRef": "...", "text": "...", "position": 1 } ],
      "correctOptionRefs": ["..."]
    }
  ],
  "validationToken": "raw once | null",
  "expiresAt": "ISO | null"
}
```

> `valid=false` 時 `preview`/`validationToken`/`expiresAt` 為 null，`errors[]` 列出所有問題（含 `questions[i].clientRef` 欄位定位）。

**Confirm body**：`{ schemaVersion, questions, payloadHash, confirmed: true }`，questions 須與 validate 時完全一致。
**Confirm 回應**：`{ schemaVersion, payloadHash, questions: QuestionDto[] }`。

---

## 2. 課堂使用（teacher 視角）

角色：`teacher`/`admin`（須為 session 課程 owner 或 admin）。所有 mutation 需 CSRF。

### 2.1 Live Session 生命週期

| Method | Path | 用途 |
|---|---|---|
| POST | `/live-sessions` | 建立 session（draft 課程；產 sessionCode、status=waiting） |
| POST | `/live-sessions/:id/start` | 開始（建立 SessionQuestion 不可變快照、waiting→active） |
| POST | `/live-sessions/:id/questions/:sessionQuestionId/open` | 開單題（active 中至多一題 open） |
| POST | `/live-sessions/:id/questions/:sessionQuestionId/close` | 關單題 |
| POST | `/live-sessions/:id/close` | 結束 session（active→closed，自動關 open 題） |
| POST | `/live-sessions/:id/cancel` | 取消（waiting/active→cancelled） |
| GET | `/live-sessions/:id` | 詳情 + `joinedCount`（Participant 數）+ `votedCount`（當前 open 題 Submission 數，無 open=0） |

**建立 body**：`{ courseId: UUID, questionIds: UUID[] }`
**LiveSessionDto**：含 `id, status, sessionCode, timestamps, questionSelections, sessionQuestions`。

### 2.2 單題結果彙整

```
GET /live-sessions/:id/questions/:sessionQuestionId/results
```

teacher（owner/admin）任意時可看匿名 aggregate。回應為 discriminated union：

**poll**：
```json
{ "snapshotType": "poll", "selectionMode": "single|multiple",
  "status": "not_open|open|closed",
  "options": [ { "optionId": "UUID", "optionRef": "...", "text": "...", "count": 0 } ],
  "totalResponses": 0 }
```

**quiz**：poll 欄位 + `correctCount, incorrectCount, correctnessRate`（teacher 恆顯示正解）。

**open_text**：
```json
{ "snapshotType": "open_text",
  "responses": [ { "text": "string" } ], "totalResponses": 0 }
```

> ⚠️ **session 全班總覽端點不存在**（無 `GET /live-sessions/:id/results`）。前端若需總覽須逐題呼叫此端點。

### 2.3 即時推送（Socket.IO `/live` namespace）

連線：`io('/live', { auth: { liveSessionId }, transports: ['websocket'] })`，teacher 由 `__Host-session` cookie 識別（handshake 手動 parse）。

teacher 加入 `session:<id>` 與 `teacher:<id>` 兩個房間。事件 envelope：
```json
{ "schemaVersion": 1, "serverTimestamp": "ISO",
  "liveSessionId": "UUID", "visibility": "session|teacher", "data": { ... } }
```

| 事件 | 範圍 | data |
|---|---|---|
| `session.snapshot` | session | 完整 snapshot + counts（connect/reconnect/`snapshot.fetch` 時推） |
| `question.opened` | session | `{ sessionQuestionId }` |
| `question.closed` | session | `{ sessionQuestionId }` |
| `session.state_changed` | session | `{ status }` |
| `session.closed` | session | status=closed 時 |
| `counts.updated` | **teacher only** | `{ joinedCount, votedCount }` |
| `result.updated` | teacher room | 作答/關題後的彙整更新 |
| `error` | — | `{ code }` |

**client→server**：`snapshot.fetch`（要求重送 fresh snapshot）。

> ⚠️ **無 eventSeq / replay**：reconnect 只重取 snapshot，不補播歷史事件。前端斷線後必須 reset state 再取 snapshot。無 auto-close scheduler。

---

## 3. 學員課堂使用

### 3.1 登入與我的課程

| Method | Path | 用途 | 守護 |
|---|---|---|---|
| POST | `/auth/login` | 登入（Set-Cookie session + csrf） | 無 |
| GET | `/auth/session` | 當前 session（回真實 `expiresAt` ISO） | Session |
| POST | `/auth/step-up` | 重新驗密碼（建立 step-up） | Session + CSRF |
| POST | `/auth/change-password` | 改密碼（rotate session） | Session + CSRF |
| POST | `/auth/logout` | 登出 | Session + CSRF |
| GET | `/me/courses?page&pageSize` | 我的有效課程（student only） | Session + Student |

**Login body**：`{ username, password }`
**SessionDto**（login / change-password / `GET /auth/session` 共用）：
```json
{
  "accountId": "UUID", "username": "...", "displayName": "...",
  "role": "admin|teacher|student", "canCreateCourse": false,
  "mustChangePassword": false, "sessionId": "UUID",
  "expiresAt": "ISO string (絕對到期)"
}
```

**MyCourseDto**：`{ enrollmentId, courseId, name, description, status, ownerAccountId, enrolledAt, createdAt, updatedAt }`

### 3.2 我的課程與名冊

| Method | Path | 用途 | 守護 | 排序/語意 |
|---|---|---|---|---|
| GET | `/me/courses?page&pageSize` | 學員有效課程 | Session + Student | active only；`enrolledAt DESC, id DESC` |
| POST | `/courses/:courseId/enrollments` | owner/admin 加選 student | Session + CSRF + exact Origin + owner/admin | active duplicate 回同一 row；removed row reactivation；archived 拒絕 |
| GET | `/courses/:courseId/enrollments?page&pageSize` | owner/admin 看 roster | Session + owner/admin | active + removed；`createdAt ASC, id ASC`；non-owner teacher 404 |
| DELETE | `/courses/:courseId/enrollments/:studentAccountId` | owner/admin 移除 student | Session + CSRF + exact Origin + owner/admin | idempotent；student 403 |

### 3.3 課堂加入

```
POST /live-sessions/:sessionCode/join
```

- **無 cookie** → 匿名 code join（不需 CSRF）；`displayName` 可選；回 `participantToken`（raw 只回一次）
- **有 student cookie** → account-bound Participant；`displayName` 忽略；`participantToken=null`；需 CSRF

回應：`{ participantId, participantToken: string|null, liveSession: { id, status, sessionCode }, currentQuestion: SessionQuestion|null }`

### 3.4 Snapshot（隱藏正解）

```
GET /live-sessions/:id/snapshot
```

認證：`X-Participant-Token` bearer 或 Web session cookie。
- participant（匿名 token / student cookie）→ participant projection：**只含 open 的 sessionQuestions + `hasSubmitted`**，隱藏 questionSelections 與正解
- teacher/admin cookie → teacher projection（完整 snapshot）

### 3.5 作答

```
POST /live-sessions/:id/submissions
```

必要 header：`Idempotency-Key: <UUID>`。
認證：`X-Participant-Token` bearer（免 CSRF）或 student cookie（需 CSRF）。teacher cookie 不可 submit。

**body**（依題型）：
- poll：`{ sessionQuestionId, selectedOptionRefs: string[] }`（single 恰一、multiple 至少一且不超過選項數）
- quiz：`{ sessionQuestionId, selectedOptionRefs: [單一正解] }`
- open_text：`{ sessionQuestionId, textAnswer: string }`（禁 selectedOptionRefs）

**回應**：`{ id, liveSessionId, sessionQuestionId, participantId, selectedOptionRefs: string[]|null, textAnswer: string|null, submittedAt }`。refs 會 canonicalize 成正式 option UUID。首筆不可更新；同 key+同 payload replay。

### 3.6 看結果

學員用同一個 `GET /live-sessions/:id/questions/:sessionQuestionId/results`：
- **open 題**：須本人已 submit 才 reveal aggregate，否則 `409 RESULTS_NOT_REVEALED`
- **closed 題**：全班可看
- quiz correctness 僅 closed 後顯示

### 3.7 學員即時推送

學員 Socket.IO `/live`，student cookie 走 account-bound participant resolver，匿名用 `auth:{ participantToken, sessionCode }`。只加入 `session:<id>`（不進 teacher room）。

接收：`session.snapshot`（participant projection）、`question.opened/closed`、`session.state_changed`、`result.updated`（submit 後只推給提交者本人；close 後推給所有符合者）。

> ⚠️ student/enrolled account 每次事件前 server 會 reauthorize enrollment/active status，失去資格會被 disconnect。

---

## 4. 帳號管理（admin）

class-level guard：`Session + CSRF + Admin`。`mustChangePassword` 未允許會先擋。CLI credential 相關操作需 step-up。

| Method | Path | 用途 | step-up |
|---|---|---|---|
| GET | `/admin/accounts?page&pageSize` | 分頁列出帳號 metadata | 無 |
| GET | `/admin/accounts/:id` | 讀取單一帳號 metadata | 無 |
| POST | `/admin/accounts` | 建帳號（admin/teacher/student） | 無 |
| PATCH | `/admin/accounts/:id/permissions` | 更新 `canCreateCourse` 權限（只改此欄位） | 無 |
| POST | `/admin/accounts/:id/reset-password` | 重設密碼 | 需 |
| POST | `/admin/accounts/:id/disable` | 停用（撤 session/CLI/未用 token） | 需 |
| POST | `/admin/accounts/:id/restore` | 復原 | 需 |
| POST | `/admin/accounts/:id/cli-credentials` | 建 CLI key（`rawKey` 只回一次） | 需 |
| GET | `/admin/accounts/:id/cli-credentials` | 列 CLI key metadata | 無 |
| POST | `/admin/accounts/:id/cli-credentials/:credentialId/revoke` | 撤 CLI key | 需 |

**建帳號 body**：`{ username, displayName, role, canCreateCourse, tempPassword }`。student 的 `canCreateCourse` 恆為 false。

**更新開課授權 body**：`{ canCreateCourse: boolean }`。成功回 `200` 與最新 `AccountDto`；僅 admin 可操作，target 可為 admin/teacher，student 設為 `true` 時回 `403 FORBIDDEN`。此 mutation 不停用帳號、不撤銷 WebSession/CLI credential/unused token，也不修改既有 Course、Question、LiveSession 或結果；`POST /courses` 仍是 server 授權來源。
**AccountDto**：`{ id, username, displayName, role, status, canCreateCourse, mustChangePassword, disabledAt, createdAt }`。

---

## 5. 已知限制（前端需設計 fallback）

| 限制 | 影響 | 前端對策 |
|---|---|---|
| 無 `GET /live-sessions/:id/results`（整場彙整） | teacher 全班總覽 | 逐題呼叫 per-question results 聚合 |
| Realtime 無 eventSeq / replay | 斷線復原 | 用 `snapshot.fetch` 重取 fresh snapshot，reset state |
| 無 auto-close scheduler | abandoned session 不自動收尾 | teacher 手動 close/cancel |
| admin account permission update 只支援 `canCreateCourse` | 帳號管理 UI | 使用 `PATCH /admin/accounts/:id/permissions`；disable/restore/CLI credential 仍走各自端點 |
| OpenAPI 顯示內層 DTO（非 envelope） | 自動產 client 型別 | client 手動解 `data`，或自訂 transformer |

---

## 6. 驗證狀態

> **Evidence boundary（2026-08-23）：** wire contract、runtime code、targeted DB-backed evidence 與 full regression 必須分開描述；本節不把 code presence 當作全量驗證，也不把 B4 realtime PASS 當作 P0-06 archive/retention PASS。

- Phase B B1/B2：既有 targeted DB-backed evidence 為 4 suites / 15 tests；student role、`canCreateCourse=false`、owner-path denial、enrollment roster、`/me/courses` 與 archived-course guard 已有測試覆蓋。
- Phase B B4：realtime targeted evidence 為 1 suite / 14 tests；student handshake/scope、participant-safe result push、teacher-only counts、enrollment/account revocation disconnect 與 anonymous fallback 已驗證。
- B5 focused privacy evidence（本次）：Pino/question-results unit 2 suites / 14 tests PASS；open-text REST + realtime e2e 2 suites / 15 tests PASS，使用 guarded `smartlearning_test`。open/closed open_text projection 均維持匿名 plain-text shape，student realtime close result 不含 identity linkage 或 teacher-only counts。
- Checkpoint D（2026-08-27）：smartlearning_test 12 migrations up to date；targeted 9 suites/36 tests；full unit 22/123、integration 3/12、E2E 23/146；typecheck/lint/format/build/git diff --check 全 PASS，0 failure/skip。
- 尚未 final sign-off：需完成本次 sibling-document sync 並取得 release approval；archive/retention 與 durable realtime/replay 仍 deferred。
- US-F16 permission mutation：static typecheck/lint/format/build、unit 與 OpenAPI e2e 已通過；account-admin DB-backed e2e **Blocked**（`smartlearning_test` 的 PostgreSQL `localhost:5432` 回 `P1001`）。
- 兩個契約修正（`/auth/session` expiresAt、batch preview clientRef）已套用並通過既有 typecheck/lint/unit/e2e。

---

## 7. 快速驗證命令（前端連線前 self-check）

```bash
# 後端啟動
NODE_ENV=development npm run start:dev    # http://localhost:3000

# health
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready

# OpenAPI（已啟用）
curl http://localhost:3000/api/docs-json       # Swagger UI: http://localhost:3000/api/docs
```