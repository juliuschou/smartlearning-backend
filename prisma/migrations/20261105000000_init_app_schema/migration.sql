-- ============================================================================
-- 智學互動平台 — PostgreSQL ER 模型 DDL
-- 詞彙基準：20_系統分析/GLOSSARY.md（權威版）
-- 規則：每個欄位皆以 COMMENT ON COLUMN 提供說明（\d+ 可見）；列舉欄位以 enum type 承載語意。
-- 適用：全新資料庫，單一交易執行。P1 表（organization/export_job）已建但預設不啟用。
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 列舉型別
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE user_status_e   AS ENUM ('INVITED', 'ACTIVE', 'DISABLED');
  COMMENT ON TYPE user_status_e IS '帳號狀態：INVITED 已邀請 / ACTIVE 啟用 / DISABLED 停用（M01/M03）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE one_time_link_kind_e AS ENUM ('INVITATION', 'EMAIL_VERIFICATION', 'PASSWORD_RESET');
  COMMENT ON TYPE one_time_link_kind_e IS '一次性連結種類：INVITATION 邀請（7 天）/ EMAIL_VERIFICATION Email 變更驗證 / PASSWORD_RESET 密碼重設（30 分鐘）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE link_status_e   AS ENUM ('PENDING', 'USED', 'SUPERSEDED', 'EXPIRED');
  COMMENT ON TYPE link_status_e IS '連結狀態：PENDING 待用 / USED 已使用（一次性）/ SUPERSEDED 被重發取代 / EXPIRED 逾期（M01/M03）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE login_session_status_e AS ENUM ('ACTIVE', 'REVOKED');
  COMMENT ON TYPE login_session_status_e IS '登入 Session 狀態：ACTIVE 有效 / REVOKED 已撤銷（登出/逾時/停用/密碼變更後）（M01）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE role_status_e   AS ENUM ('ENABLED', 'DISABLED');
  COMMENT ON TYPE role_status_e IS '角色狀態：ENABLED 啟用 / DISABLED 停用（停用立即撤銷受影響憑證）（M02）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE permission_status_e AS ENUM ('ENABLED', 'DISABLED');
  COMMENT ON TYPE permission_status_e IS '權限狀態：ENABLED 可指派 / DISABLED 不可指派且 API 一律拒絕（P1 權限 V1 預為 DISABLED）（M04）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE question_type_e AS ENUM ('SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'VOTE', 'OPEN_TEXT');
  COMMENT ON TYPE question_type_e IS '題型：SINGLE_CHOICE 單選 / MULTIPLE_CHOICE 多選 / VOTE 投票（無標準答案不計分）/ OPEN_TEXT 開放式文字（不自動判分）（M05）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE activity_status_e AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'ENDED');
  COMMENT ON TYPE activity_status_e IS '活動狀態：NOT_STARTED 尚未開始 / IN_PROGRESS 進行中 / ENDED 已結束（不可恢復）（M06）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE grouping_mode_e AS ENUM ('INDIVIDUAL', 'TEAM');
  COMMENT ON TYPE grouping_mode_e IS '分組模式 grouping_mode：INDIVIDUAL 不分組（預設）/ TEAM 分組（M11；禁止裸用代碼於文件書寫）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE leaderboard_mode_e AS ENUM ('NONE', 'INDIVIDUAL', 'TEAM');
  COMMENT ON TYPE leaderboard_mode_e IS '排行榜模式 leaderboard_mode：NONE（預設）/ INDIVIDUAL / TEAM；須與分組模式相容：INDIVIDUAL+NONE/INDIVIDUAL、TEAM+NONE/TEAM（M11）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE question_control_status_e AS ENUM ('NOT_SELECTED', 'SELECTED', 'OPEN', 'ANSWER_STOPPED');
  COMMENT ON TYPE question_control_status_e IS '題目控制狀態：NOT_SELECTED 未選題 / SELECTED 已選題未開放 / OPEN 作答中 / ANSWER_STOPPED 已停止作答（M07；轉換依題序、須原子）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE projection_state_e AS ENUM ('QUESTION', 'PUBLISHED_RESULT', 'JOIN_QRCODE', 'SAFE_STANDBY');
  COMMENT ON TYPE projection_state_e IS '投影狀態：QUESTION 題目 / PUBLISHED_RESULT 已公布結果 / JOIN_QRCODE 加入QR / SAFE_STANDBY 安全待機（失聯時顯示，避免過期或未授權資料）（M07）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE participant_phase_e AS ENUM ('WAITING', 'ACTIVE', 'OBSERVER');
  COMMENT ON TYPE participant_phase_e IS '參與階段：WAITING 等候（已加入但無開放題目）/ ACTIVE 可互動 / OBSERVER 旁聽（不具計分資格）；在線與否由心跳另判，不得混用（M08）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE team_member_reason_e AS ENUM ('INITIAL_RANDOM', 'MANUAL_ADJUST', 'LATE_ASSIGN');
  COMMENT ON TYPE team_member_reason_e IS '隊員編入原因：INITIAL_RANDOM 初始隨機分組 / MANUAL_ADJUST 手動調整 / LATE_ASSIGN 遲到指派（→人數最少隊伍，並列時隨機）（M11）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE settlement_status_e AS ENUM ('PENDING', 'COMPLETED');
  COMMENT ON TYPE settlement_status_e IS '統計/結算狀態：PENDING 處理中（不得視為就緒）/ COMPLETED 結算完成（可公布或進入下一題）；完整狀態機名稱待平台/M11 契約核定（M09）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE publish_kind_e  AS ENUM ('STATS', 'CORRECT_ANSWER', 'LEADERBOARD_INDIVIDUAL', 'LEADERBOARD_TEAM');
  COMMENT ON TYPE publish_kind_e IS '公布種類：STATS 公布統計（僅答案分布）/ CORRECT_ANSWER 公布正確答案（僅有標準答案題型）/ LEADERBOARD_INDIVIDUAL 個人排行榜 / LEADERBOARD_TEAM 隊伍排行榜；公布不可撤回（M07/M09/M11）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE event_kind_e AS ENUM (
    'SESSION_CREATED','SESSION_STARTED','SESSION_ENDED',
    'MODE_CHANGED','GROUPING_CONFIRMED','MODE_UNLOCKED','FIRST_SCORING_QUESTION_OPEN',
    'LEASE_GRANTED','LEASE_RENEWED','LEASE_RELEASED','LEASE_DENIED',
    'JOIN_INFO_ISSUED','JOIN_INFO_REVOKED',
    'QUESTION_SELECTED','ANSWERING_OPENED','ANSWERING_STOPPED','NEXT_QUESTION',
    'ACCOUNT_BATCH','GROUPING_REBUILT');
  COMMENT ON TYPE event_kind_e IS '活動/帳號事件種類：SESSION_* 建立/開始/結束、MODE_CHANGED 模式異動、GROUPING_CONFIRMED 分組確認、MODE_UNLOCKED/GROUPING_REBUILT 解鎖重建、FIRST_SCORING_QUESTION_OPEN 首道計分題開放鎖定、LEASE_* 租約授予/續期/釋放/拒絕、JOIN_INFO_* 加入資訊產生/撤銷、QUESTION_SELECTED 選題、ANSWERING_OPENED/STOPPED 開放/停止作答、NEXT_QUESTION 下一題、ACCOUNT_BATCH 批次帳號操作（M06/M07/M03/M11）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE batch_type_e    AS ENUM ('ACCOUNT_ENABLE','ACCOUNT_DISABLE','INVITE_RESEND','ROLE_ASSIGN');
  COMMENT ON TYPE batch_type_e IS '批次操作種類（M03）：ACCOUNT_ENABLE 啟用 / ACCOUNT_DISABLE 停用（含活動終止原子語意）/ INVITE_RESEND 重發邀請 / ROLE_ASSIGN 角色指派';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE batch_status_e  AS ENUM ('SUBMITTED','COMPLETED','FAILED','SUPERSEDED');
  COMMENT ON TYPE batch_status_e IS '批次狀態（全有全無）：SUBMITTED 已提交 / COMPLETED 完成 / FAILED 失敗（整批回復）/ SUPERSEDED 被取代（M03）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE export_format_e AS ENUM ('CSV', 'XLSX');
  COMMENT ON TYPE export_format_e IS '匯出格式（P1）：CSV（須 UTF-8、防公式注入）/ XLSX（M09）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE export_status_e AS ENUM ('PROCESSING','READY','EXPIRED','FAILED');
  COMMENT ON TYPE export_status_e IS '匯出作業狀態（P1）：PROCESSING 處理中 / READY 可下載 / EXPIRED 下載逾期 / FAILED 失敗（M09）';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA IF NOT EXISTS app;

-- ============================================================================
-- 1. 帳號、登入與憑證（M01/M03）
-- ============================================================================
CREATE TABLE app.user_account (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  email_verified    boolean NOT NULL DEFAULT false,
  password_hash     text NOT NULL,
  name              text NOT NULL,
  phone             text,
  account_name      text NOT NULL,
  status            user_status_e NOT NULL DEFAULT 'INVITED',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_user_password_hash CHECK (length(password_hash) >= 8),
  CONSTRAINT ck_user_name_len CHECK (char_length(trim(name)) BETWEEN 1 AND 100),
  CONSTRAINT ck_user_phone CHECK (phone IS NULL OR phone ~ '^\+[0-9]{1,14}$'),
  CONSTRAINT ck_user_account_name_fmt CHECK (account_name ~ '^[A-Za-z0-9._-]{3,32}$')
);
CREATE UNIQUE INDEX uq_user_email_lower ON app.user_account (lower(email));
CREATE UNIQUE INDEX uq_user_account_name ON app.user_account (lower(account_name));
COMMENT ON TABLE  app.user_account IS '帳號（正式系統帳號，使用者=系統管理者或老師；學員不建帳號，見 participant）。M01/M03。';
COMMENT ON COLUMN app.user_account.id IS '帳號代理主鍵（uuid；非登入識別）';
COMMENT ON COLUMN app.user_account.email IS '登入識別：已驗證且唯一 Email，最長 254，比對不分大小寫、去首尾空白；變更後須重新驗證（未驗證前禁止新登入）';
COMMENT ON COLUMN app.user_account.email_verified IS 'Email 是否已驗證；變更 Email 時重設為 false';
COMMENT ON COLUMN app.user_account.password_hash IS '密碼單向安全雜湊；明文不得儲存/記錄/回傳；最低長度 8，其餘政策依平台安全政策';
COMMENT ON COLUMN app.user_account.name IS '姓名：必填，1–100 Unicode code point，允許中英文與一般姓名符號（去首尾空白）';
COMMENT ON COLUMN app.user_account.phone IS '聯絡電話：選填，E.164 格式（含 + 國碼），最多 15 位數字';
COMMENT ON COLUMN app.user_account.account_name IS '帳號名稱：必填、全平台唯一（不分大小寫）；限英數與 . _ -，3–32 字元；不作登入識別';
COMMENT ON COLUMN app.user_account.status IS '帳號狀態：INVITED 已邀請 / ACTIVE 啟用 / DISABLED 停用；停用即撤銷登入憑證並原子終止其進行中活動（刪除操作即停用）；重新啟用需至少一個有效角色';
COMMENT ON COLUMN app.user_account.created_at IS '建立時間';
COMMENT ON COLUMN app.user_account.updated_at IS '最後更新時間';

CREATE TABLE app.one_time_link (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id   uuid NOT NULL REFERENCES app.user_account(id),
  kind              one_time_link_kind_e NOT NULL,
  token_hash        text NOT NULL UNIQUE,
  status            link_status_e NOT NULL DEFAULT 'PENDING',
  expires_at        timestamptz NOT NULL,
  used_at           timestamptz,
  superseded_at     timestamptz,
  last_sent_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_link_expiry CHECK (expires_at > created_at)
);
COMMENT ON TABLE app.one_time_link IS '一次性連結：邀請（7 天）/ Email 驗證 / 密碼重設（30 分鐘）共用一表；重發時舊連結立即失效（SUPERSEDED）。M01/M03。';
COMMENT ON COLUMN app.one_time_link.id IS '代理主鍵';
COMMENT ON COLUMN app.one_time_link.user_account_id IS '歸屬帳號（FK）；帳號不存在/停用/無驗證管道時不得建立可用連結';
COMMENT ON COLUMN app.one_time_link.kind IS '連結種類（見型別註解）';
COMMENT ON COLUMN app.one_time_link.token_hash IS 'Token 雜湊（唯一）；原始 token 不可預測、不得於回應或紀錄暴露';
COMMENT ON COLUMN app.one_time_link.status IS '連結狀態（見型別註解）；一次性使用後立即失效';
COMMENT ON COLUMN app.one_time_link.expires_at IS '到期時間：邀請 7 天、密碼重設 30 分鐘';
COMMENT ON COLUMN app.one_time_link.used_at IS '使用（完成啟用/驗證/重設）時間；同時將 Email 標記已驗證、帳號轉 ACTIVE（邀請）';
COMMENT ON COLUMN app.one_time_link.superseded_at IS '被重發連結取代（失效）時間';
COMMENT ON COLUMN app.one_time_link.last_sent_at IS '上次寄送時間；同一帳號 每 60 秒最多寄送一次（頻率限制，邀請與重設共用）';
COMMENT ON COLUMN app.one_time_link.created_at IS '建立時間';

CREATE TABLE app.login_session (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id       uuid NOT NULL REFERENCES app.user_account(id),
  token_hash            text NOT NULL UNIQUE,
  status                login_session_status_e NOT NULL DEFAULT 'ACTIVE',
  permission_snapshot   jsonb NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_used_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz
);
COMMENT ON TABLE app.login_session IS '登入 Session（驗證工作階段；多裝置可並存）。逾時：閒置 30 分鐘或登入後 24 小時，先到者逾。M01/M02/M04。';
COMMENT ON COLUMN app.login_session.id IS '代理主鍵';
COMMENT ON COLUMN app.login_session.user_account_id IS '歸屬帳號（FK）';
COMMENT ON COLUMN app.login_session.token_hash IS '登入憑證 Token 雜湊（唯一）；不得於回應/日誌暴露';
COMMENT ON COLUMN app.login_session.status IS '狀態：ACTIVE 有效 / REVOKED 已撤銷（登出、逾時、帳號停用、成功變更/重設密碼、角色停用時撤銷該帳號所有 Session）';
COMMENT ON COLUMN app.login_session.permission_snapshot IS '權限快照：登入時記錄的有效角色-權限集合（jsonb）；權限異動須重新登入後套用；帳號/角色停用例外：立即撤銷';
COMMENT ON COLUMN app.login_session.created_at IS '登入時間（24 小時絕對逾時計算基準）';
COMMENT ON COLUMN app.login_session.last_used_at IS '最後活動時間（閒置 30 分鐘計算基準）；兩種逾時以先到者為準';
COMMENT ON COLUMN app.login_session.revoked_at IS '撤銷時間';

-- ============================================================================
-- 2. 角色、權限與授權（M02/M04）
-- ============================================================================
CREATE TABLE app.role (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_code             text NOT NULL UNIQUE,
  name                  text NOT NULL,
  description           text NOT NULL,
  is_system_reserved    boolean NOT NULL DEFAULT true,
  status                role_status_e NOT NULL DEFAULT 'ENABLED',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.role IS '角色（固定系統角色目錄）；V1 僅 SYSTEM_ADMIN 系統管理者 與 TEACHER 老師 兩筆，代碼/名稱/描述不可修改、不可刪除。M02。';
COMMENT ON COLUMN app.role.id IS '代理主鍵';
COMMENT ON COLUMN app.role.role_code IS '角色代碼：SYSTEM_ADMIN / TEACHER；不可修改、不可刪除';
COMMENT ON COLUMN app.role.name IS '角色名稱：必填，不可修改';
COMMENT ON COLUMN app.role.description IS '角色描述：必填，不可修改';
COMMENT ON COLUMN app.role.is_system_reserved IS '是否系統保留角色（V1 兩筆皆為保留）';
COMMENT ON COLUMN app.role.status IS '角色狀態：唯一可變欄位；停用需通過最後有效系統管理者保護檢查，並立即撤銷受影響帳號所有 Session；停用不刪除 USER_ROLE 指派';
COMMENT ON COLUMN app.role.created_at IS '建立時間';
COMMENT ON COLUMN app.role.updated_at IS '最後更新時間';

CREATE TABLE app.permission (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permission_code       text NOT NULL UNIQUE,
  name                  text NOT NULL,
  description           text NOT NULL,
  module_category       text NOT NULL,
  status                permission_status_e NOT NULL DEFAULT 'ENABLED',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.permission IS '權限目錄：以模組讀取/寫入為單位的穩定授權單位（如 M05_WRITE）；未列入目錄者預設拒絕（fail-closed）。M04。';
COMMENT ON COLUMN app.permission.id IS '代理主鍵';
COMMENT ON COLUMN app.permission.permission_code IS '權限代碼：<MODULE>_READ / <MODULE>_WRITE；全域穩定唯一；不可由管理介面新增或改名（以版本化 migration/seed 管理）';
COMMENT ON COLUMN app.permission.name IS '權限名稱：必填';
COMMENT ON COLUMN app.permission.description IS '權限說明：必填；須載明涵蓋功能案例、可授權範圍與必要資源/業務條件';
COMMENT ON COLUMN app.permission.module_category IS '模組分類（帳號/角色/老師/題庫/活動/即時控制/統計報表/分組競賽/系統設定等）';
COMMENT ON COLUMN app.permission.status IS '權限狀態：ENABLED / DISABLED；停用權限不可指派，API 收到仍必須拒絕';
COMMENT ON COLUMN app.permission.created_at IS '建立時間';
COMMENT ON COLUMN app.permission.updated_at IS '最後更新時間';

CREATE TABLE app.role_permission (
  role_id        uuid NOT NULL REFERENCES app.role(id),
  permission_id  uuid NOT NULL REFERENCES app.permission(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);
COMMENT ON TABLE app.role_permission IS '角色—功能對應（ROLE_PERMISSION）：完整有效權限集合由 M04 一次提交取代（全有全無、最後寫入者勝），提交時原子檢查最後有效系統管理者保護。M04。';
COMMENT ON COLUMN app.role_permission.role_id IS '角色（FK；僅可引用存在且啟用之固定角色）';
COMMENT ON COLUMN app.role_permission.permission_id IS '權限（FK；僅可引用存在且 V1 可用之權限）';
COMMENT ON COLUMN app.role_permission.created_at IS '建立時間';

CREATE TABLE app.user_role (
  user_account_id  uuid NOT NULL REFERENCES app.user_account(id),
  role_id          uuid NOT NULL REFERENCES app.role(id),
  assigned_by      uuid REFERENCES app.user_account(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_account_id, role_id)
);
COMMENT ON TABLE app.user_role IS '帳號角色指派（多對多）；維護入口為 M03；停用角色時保留指派紀錄。有效角色=帳號啟用 + 角色狀態啟用 + 指派有效。M02/M03。';
COMMENT ON COLUMN app.user_role.user_account_id IS '帳號（FK）；重複新增相同指派採冪等，不得產生重複關聯';
COMMENT ON COLUMN app.user_role.role_id IS '角色（FK；僅可指派 ENABLED 角色）';
COMMENT ON COLUMN app.user_role.assigned_by IS '指派操作者帳號（FK，稽核用）';
COMMENT ON COLUMN app.user_role.created_at IS '指派時間';

-- ============================================================================
-- 3. 題庫（M05）
-- ============================================================================
CREATE TABLE app.question_set (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id      uuid NOT NULL REFERENCES app.user_account(id),
  name               text NOT NULL,
  topic              text,
  description        text,
  is_deleted         boolean NOT NULL DEFAULT false,
  deleted_at         timestamptz,
  copied_from_set_id uuid REFERENCES app.question_set(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_question_set_owner_updated ON app.question_set (owner_user_id, updated_at DESC);
COMMENT ON TABLE app.question_set IS '題庫（QUESTION_SET）：老師擁有、可跨活動重複使用的題目集合；支援軟刪除與複製副本。M05。';
COMMENT ON COLUMN app.question_set.id IS '代理主鍵';
COMMENT ON COLUMN app.question_set.owner_user_id IS '資源擁有者（老師帳號 FK；必填，不得為 NULL）；帳號停用不刪題庫、不級聯刪除';
COMMENT ON COLUMN app.question_set.name IS '題庫名稱：必填、Unicode、去首尾空白；不需唯一；複製時加「（副本）」與流水號後綴';
COMMENT ON COLUMN app.question_set.topic IS '主題：選填；每題庫至多一個';
COMMENT ON COLUMN app.question_set.description IS '描述：選填；純文字，不支援 Markdown/HTML';
COMMENT ON COLUMN app.question_set.is_deleted IS '軟刪除旗標：自清單隱藏但可由擁有者復原（內容維持刪除前狀態）；實體清除須經資料治理流程';
COMMENT ON COLUMN app.question_set.deleted_at IS '軟刪除時間';
COMMENT ON COLUMN app.question_set.copied_from_set_id IS '複製來源題庫（FK；複製產生副本時記錄，供追溯；改刪副本不影響來源）';
COMMENT ON COLUMN app.question_set.created_at IS '建立時間';
COMMENT ON COLUMN app.question_set.updated_at IS '最後更新時間（清單預設排序鍵：由新到舊）；同一題庫併發內容修改採最後提交者勝';

CREATE TABLE app.question (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_set_id  uuid NOT NULL REFERENCES app.question_set(id) ON DELETE CASCADE,
  stem             text NOT NULL,
  question_type    question_type_e NOT NULL,
  sort_order       integer NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_question_order UNIQUE (question_set_id, sort_order),
  CONSTRAINT ck_question_stem CHECK (char_length(trim(stem)) > 0)
);
COMMENT ON TABLE app.question IS '題目：題庫中的單一問題，含題幹、選項與答案；題型不得自行轉換；被活動引用後仍可編輯/刪除（不做引用保護，快照不受影響）。M05。';
COMMENT ON COLUMN app.question.id IS '代理主鍵（活動建立時複製為 session_question 快照）';
COMMENT ON COLUMN app.question.question_set_id IS '所屬題庫（FK；僅可在該題庫範圍變更）';
COMMENT ON COLUMN app.question.stem IS '題幹：必填、Unicode、去首尾空白後不得為空白';
COMMENT ON COLUMN app.question.question_type IS '題型（見型別註解）；正解規則：單選恰 1 個正解、多選>=1 個正解、投票/開放式文字不得設定正解';
COMMENT ON COLUMN app.question.sort_order IS '題庫內排序（唯一）；活動快照題序依此';
COMMENT ON COLUMN app.question.created_at IS '建立時間';
COMMENT ON COLUMN app.question.updated_at IS '最後更新時間';

CREATE TABLE app.question_option (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id    uuid NOT NULL REFERENCES app.question(id) ON DELETE CASCADE,
  option_text    text NOT NULL,
  is_correct     boolean NOT NULL DEFAULT false,
  sort_order     integer NOT NULL,
  CONSTRAINT uq_option_order UNIQUE (question_id, sort_order),
  CONSTRAINT ck_option_text CHECK (char_length(trim(option_text)) > 0)
);
CREATE UNIQUE INDEX uq_option_text_unique_in_q ON app.question_option (question_id, lower(trim(option_text)));
COMMENT ON TABLE app.question_option IS '選項：題目的作答選項；同一題內去首尾空白後不得重複；正解數量依題型規則（單選恰 1／多選>=1／投票與開放式文字為 0），驗證須於交易內聯合執行。M05。';
COMMENT ON COLUMN app.question_option.id IS '代理主鍵';
COMMENT ON COLUMN app.question_option.question_id IS '所屬題目（FK；來源題刪除時連同刪除）';
COMMENT ON COLUMN app.question_option.option_text IS '選項文字：必填、Unicode、去首尾空白；題內不得重複（唯一索引以 normalized 文字比對）';
COMMENT ON COLUMN app.question_option.is_correct IS '是否為正確答案；題型聯合規則於交易內驗證（此欄位本身不限定）';
COMMENT ON COLUMN app.question_option.sort_order IS '題內選項順序（公布統計的答案分布依此順序）';

CREATE TABLE app.tag (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  uuid NOT NULL REFERENCES app.user_account(id),
  name           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_tag_name CHECK (char_length(trim(name)) > 0)
);
CREATE UNIQUE INDEX uq_tag_owner_name ON app.tag (owner_user_id, lower(trim(name)));
COMMENT ON TABLE app.tag IS '標籤：老師自訂、僅用於本人題庫的分類標記；比對不分大小寫、去首尾空白。M05。';
COMMENT ON COLUMN app.tag.id IS '代理主鍵';
COMMENT ON COLUMN app.tag.owner_user_id IS '擁有者（老師帳號 FK；標籤僅供本人題庫使用）';
COMMENT ON COLUMN app.tag.name IS '標籤名稱：必填；該老師範圍內唯一（不分大小寫、去首尾空白）';
COMMENT ON COLUMN app.tag.created_at IS '建立時間';

CREATE TABLE app.question_set_tag (
  question_set_id  uuid NOT NULL REFERENCES app.question_set(id) ON DELETE CASCADE,
  tag_id           uuid NOT NULL REFERENCES app.tag(id),
  PRIMARY KEY (question_set_id, tag_id)
);
COMMENT ON TABLE app.question_set_tag IS '題庫—標籤關聯（多對多）；每題庫 0..N 標籤。M05。';
COMMENT ON COLUMN app.question_set_tag.question_set_id IS '題庫（FK）';
COMMENT ON COLUMN app.question_set_tag.tag_id IS '標籤（FK）';

-- ============================================================================
-- 4. 教學活動與生命週期（M06/M07/M11）
-- ============================================================================
CREATE TABLE app.control_lease (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL,
  host_user_id  uuid NOT NULL REFERENCES app.user_account(id),
  issued_to     text NOT NULL,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  renewed_at    timestamptz,
  released_at   timestamptz
);
CREATE UNIQUE INDEX uq_lease_active_per_session ON app.control_lease (session_id) WHERE released_at IS NULL;
COMMENT ON TABLE app.control_lease IS '控制端租約（Control Lease）：同一活動同一時間僅一個瀏覽器控制台可持有的控制權憑證（partial unique index）；期限/續期/到期偵測依平台即時契約（待確認）。M07。';
COMMENT ON COLUMN app.control_lease.id IS '代理主鍵（teaching_session.current_lease_id 引用）';
COMMENT ON COLUMN app.control_lease.session_id IS '所屬教學活動（FK；同活動同時僅一筆有效租約）';
COMMENT ON COLUMN app.control_lease.host_user_id IS '持有人：僅主持老師可取得/續期（重新取得須驗證當前權限與版本）';
COMMENT ON COLUMN app.control_lease.issued_to IS '控制端識別（瀏覽器/裝置識別；不含密碼或登入 Session Token）';
COMMENT ON COLUMN app.control_lease.granted_at IS '授予時間';
COMMENT ON COLUMN app.control_lease.expires_at IS '到期時間（到期由平台偵測並釋放）；具體租約期限依平台契約（待確認）';
COMMENT ON COLUMN app.control_lease.renewed_at IS '最近續期時間';
COMMENT ON COLUMN app.control_lease.released_at IS '釋放時間（NULL=有效；釋放後其他端才可取得）；無有效租約的控制操作一律後端拒絕';

CREATE TABLE app.teaching_session (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_user_id        uuid NOT NULL REFERENCES app.user_account(id),
  title               text NOT NULL,
  activity_date       date,
  activity_tz         text NOT NULL DEFAULT 'Asia/Taipei',
  organizer           text,
  current_question_id uuid,
  current_lease_id    uuid,
  projection_state    projection_state_e NOT NULL DEFAULT 'JOIN_QRCODE',
  grouping_mode       grouping_mode_e NOT NULL DEFAULT 'INDIVIDUAL',
  leaderboard_mode    leaderboard_mode_e NOT NULL DEFAULT 'NONE',
  mode_locked         boolean NOT NULL DEFAULT false,
  grouping_locked     boolean NOT NULL DEFAULT false,
  scoring_enabled     boolean NOT NULL DEFAULT false,
  first_scoring_opened boolean NOT NULL DEFAULT false,
  status              activity_status_e NOT NULL DEFAULT 'NOT_STARTED',
  started_at          timestamptz,
  ended_at            timestamptz,
  last_heartbeat_at   timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_title CHECK (char_length(trim(title)) > 0),
  CONSTRAINT ck_mode_compat CHECK (
    (grouping_mode = 'INDIVIDUAL' AND leaderboard_mode IN ('NONE','INDIVIDUAL')) OR
    (grouping_mode = 'TEAM'       AND leaderboard_mode IN ('NONE','TEAM'))
  )
);
CREATE INDEX idx_session_host_created ON app.teaching_session (host_user_id, created_at DESC);
-- 教學活動 ↔ 控制租約：延後至兩表建立完成後加 FK（避免建表順序前向引用）
COMMENT ON TABLE app.teaching_session IS '教學活動：老師建立並主持的一場課堂互動單元，含題目快照、參與者與結果（寫作禁用「Session」單稱本表）。M06。';
COMMENT ON COLUMN app.teaching_session.id IS '代理主鍵';
COMMENT ON COLUMN app.teaching_session.host_user_id IS '主持老師（Host Teacher / SESSION_HOST）：僅其可控制活動題目、公布、分組與模式；每次請求須進行活動擁有者範圍檢查';
COMMENT ON COLUMN app.teaching_session.title IS '活動名稱：必填、Unicode、去首尾空白後不得為空';
COMMENT ON COLUMN app.teaching_session.activity_date IS '活動日期：選填，允許過去日期，依所在時區解讀';
COMMENT ON COLUMN app.teaching_session.activity_tz IS '活動日期所屬時區（IANA tz 名稱），解讀 activity_date 用';
COMMENT ON COLUMN app.teaching_session.organizer IS '主辦單位：建立活動時的選填欄位；與 M11「組織」之關係待契約定義';
COMMENT ON COLUMN app.teaching_session.current_question_id IS '目前選定題目（題目快照 FK；NULL=未選題）；每活動最多一題 current；逐題前進、不得跳題或返回';
COMMENT ON COLUMN app.teaching_session.current_lease_id IS '目前有效控制租約（FK；無有效租約的控制操作一律後端拒絕；唯讀查詢不要求租約）';
COMMENT ON COLUMN app.teaching_session.projection_state IS '投影狀態（見型別註解）；切換投影不會自動公布任何結果；學員個資一律遮蔽';
COMMENT ON COLUMN app.teaching_session.grouping_mode IS '分組模式 grouping_mode：INDIVIDUAL 不分組（預設）/ TEAM 分組；INDIVIDUAL 時不得存在任何隊伍資料';
COMMENT ON COLUMN app.teaching_session.leaderboard_mode IS '排行榜模式 leaderboard_mode：NONE / INDIVIDUAL / TEAM；須與分組模式相容（CHECK 約束）；預設 NONE';
COMMENT ON COLUMN app.teaching_session.mode_locked IS '模式鎖定旗標：TEAM 分組確認或首道計分題開放時原子置 true，之後分組與排行榜模式不可再變更';
COMMENT ON COLUMN app.teaching_session.grouping_locked IS '隊伍安排鎖定旗標：TEAM 分組確認時原子鎖定；計分題開放前可經解鎖重建流程解除';
COMMENT ON COLUMN app.teaching_session.scoring_enabled IS '計分啟用：預設未啟用（投票/開放式文字一律不計分）；未啟用即使 TEAM 模式亦不得結算或產生排行榜';
COMMENT ON COLUMN app.teaching_session.first_scoring_opened IS '是否已有計分題開放過；首道計分題開放即原子鎖定模式至活動結束，之後不得解鎖/重建/切換模式';
COMMENT ON COLUMN app.teaching_session.status IS '活動狀態：NOT_STARTED 尚未開始 / IN_PROGRESS 進行中 / ENDED 已結束（不可恢復、不可再加入/互動；重複結束為冪等成功）';
COMMENT ON COLUMN app.teaching_session.started_at IS '開始活動時間（老師啟動進入進行中；不等同開放任何題目）';
COMMENT ON COLUMN app.teaching_session.ended_at IS '結束活動時間（保留結果；不可恢復）';
COMMENT ON COLUMN app.teaching_session.last_heartbeat_at IS '活動級最後連線活動時間（供 M10 營運監控之狀態新鮮度判定；過期或不可得時呈現「未知」）';
COMMENT ON COLUMN app.teaching_session.created_at IS '建立時間（清單預設排序鍵：由新到舊）';
COMMENT ON COLUMN app.teaching_session.updated_at IS '最後更新時間';

CREATE TABLE app.session_question (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            uuid NOT NULL REFERENCES app.teaching_session(id) ON DELETE CASCADE,
  source_question_id    uuid REFERENCES app.question(id) ON DELETE SET NULL,
  source_question_set_id uuid,
  copied_stem           text NOT NULL,
  question_type         question_type_e NOT NULL,
  sort_order            integer NOT NULL,
  control_status        question_control_status_e NOT NULL DEFAULT 'NOT_SELECTED',
  countdown_expires_at  timestamptz,
  stats_published       boolean NOT NULL DEFAULT false,
  answer_published      boolean NOT NULL DEFAULT false,
  opened_at             timestamptz,
  closed_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_session_q_order UNIQUE (session_id, sort_order)
);
COMMENT ON TABLE app.session_question IS '題目快照（SESSION_QUESTION）：活動建立時保存的不可變題目副本，事後改題庫不影響歷史結果；內容欄位建立後禁止 UPDATE（僅控制/公布狀態欄可寫）。M06/M07。';
COMMENT ON COLUMN app.session_question.id IS '代理主鍵（作答、統計、資格快照、結算均以本表為準，非來源題庫）';
COMMENT ON COLUMN app.session_question.session_id IS '所屬教學活動（FK）';
COMMENT ON COLUMN app.session_question.source_question_id IS '來源題目（FK，可 NULL；活動建立時複製後來源編輯/刪除/軟刪除均不影響本快照）';
COMMENT ON COLUMN app.session_question.source_question_set_id IS '來源題庫（追溯用冗餘快照欄位）';
COMMENT ON COLUMN app.session_question.copied_stem IS '快照題幹（活動建立時自 question.stem 複製，不可改）';
COMMENT ON COLUMN app.session_question.question_type IS '快照題型（複製自 question.question_type，不可改）';
COMMENT ON COLUMN app.session_question.sort_order IS '活動題序（唯一）；老師只能逐題前進，不得跳題或返回';
COMMENT ON COLUMN app.session_question.control_status IS '題目控制狀態（見型別註解）；開放作答若為首道計分題則原子觸發模式鎖定';
COMMENT ON COLUMN app.session_question.countdown_expires_at IS '作答倒數到期時間（老師可選）；到期只停止作答，不代表結算完成，由伺服器原子轉為已停止';
COMMENT ON COLUMN app.session_question.stats_published IS '公布統計旗標（僅顯示答案分布）：單向 false→true、公布不可撤回；與公布正確答案分別控制';
COMMENT ON COLUMN app.session_question.answer_published IS '公布正確答案旗標：單向 false→true、不可撤回；僅適用有標準答案題型';
COMMENT ON COLUMN app.session_question.opened_at IS '開放作答時間（同時建立題目資格快照）';
COMMENT ON COLUMN app.session_question.closed_at IS '停止作答時間（老師手動或倒數到期；與提交競態以伺服器原子受理順序裁決）';
COMMENT ON COLUMN app.session_question.created_at IS '建立（快照）時間';

CREATE TABLE app.session_question_option (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_question_id  uuid NOT NULL REFERENCES app.session_question(id) ON DELETE CASCADE,
  copied_option_text   text NOT NULL,
  is_correct           boolean NOT NULL DEFAULT false,
  sort_order           integer NOT NULL,
  CONSTRAINT uq_snapshot_option_order UNIQUE (session_question_id, sort_order)
);
COMMENT ON TABLE app.session_question_option IS '快照選項：活動建立時自 question_option 複製的不可變副本（文字/正解/順序）。M06。';
COMMENT ON COLUMN app.session_question_option.id IS '代理主鍵';
COMMENT ON COLUMN app.session_question_option.session_question_id IS '所屬題目快照（FK）';
COMMENT ON COLUMN app.session_question_option.copied_option_text IS '快照選項文字（複製自 question_option.option_text，不可改）';
COMMENT ON COLUMN app.session_question_option.is_correct IS '快照正解標記（活動建立時複製；公布正確答案依此）';
COMMENT ON COLUMN app.session_question_option.sort_order IS '快照選項順序（不可改）';

CREATE TABLE app.session_join_info (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL REFERENCES app.teaching_session(id) ON DELETE CASCADE,
  generation     integer NOT NULL DEFAULT 1,
  game_pin       char(6) NOT NULL,
  join_url_token text NOT NULL UNIQUE,
  is_active      boolean NOT NULL DEFAULT true,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  CONSTRAINT ck_pin_format CHECK (game_pin ~ '^[0-9]{6}$'),
  CONSTRAINT uq_join_gen UNIQUE (session_id, generation)
);
CREATE UNIQUE INDEX uq_game_pin_active ON app.session_join_info (game_pin) WHERE is_active;
COMMENT ON TABLE app.session_join_info IS '加入資訊：Game PIN + QR Code + 活動連結一組；僅在活動允許加入期間有效；輪替時舊組全組撤銷、新組生效，不得分別撤銷；不得包含密碼或不必要個資。M06/M08。';
COMMENT ON COLUMN app.session_join_info.id IS '代理主鍵';
COMMENT ON COLUMN app.session_join_info.session_id IS '所屬教學活動（FK）';
COMMENT ON COLUMN app.session_join_info.generation IS '世代序號：同活動多組加入資訊，同期僅一組有效';
COMMENT ON COLUMN app.session_join_info.game_pin IS 'Game PIN：6 位數字（允許前導 0 故存 char(6)）；於全平台仍允許加入的活動間唯一（partial unique index WHERE is_active）；衝突時重新產生';
COMMENT ON COLUMN app.session_join_info.join_url_token IS 'QR Code/活動連結 Token；與 Game PIN 同組產生/失效/撤銷';
COMMENT ON COLUMN app.session_join_info.is_active IS '是否為現行有效組（活動停止接受加入或結束即整組失效）';
COMMENT ON COLUMN app.session_join_info.issued_at IS '發出時間';
COMMENT ON COLUMN app.session_join_info.revoked_at IS '撤銷時間';

-- 教學活動 ↔ 控制租約（兩表皆建立後補 FK）
ALTER TABLE app.control_lease
  ADD CONSTRAINT fk_lease_session FOREIGN KEY (session_id) REFERENCES app.teaching_session(id);
ALTER TABLE app.teaching_session
  ADD CONSTRAINT fk_session_lease FOREIGN KEY (current_lease_id) REFERENCES app.control_lease(id);

-- ============================================================================
-- 5. 參與者與即時互動（M08）
-- ============================================================================
CREATE TABLE app.participant (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES app.teaching_session(id),
  display_name    text NOT NULL,
  nickname        text,
  phase           participant_phase_e NOT NULL DEFAULT 'ACTIVE',
  organization_id uuid,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_participant_in_session UNIQUE (session_id, id)
);
COMMENT ON TABLE app.participant IS '參與者：系統在單一活動範圍內唯一識別的臨時參與實體；不需正式帳號、不納入角色管理。學員是人、參與者是活動內身分。M06/M08。';
COMMENT ON COLUMN app.participant.id IS '參與者識別（uuid；與 session_id 合組為活動範圍內唯一身分）；重連不得建立重複參與者';
COMMENT ON COLUMN app.participant.session_id IS '所屬教學活動（FK）；已結束活動拒絕新加入';
COMMENT ON COLUMN app.participant.display_name IS '顯示名稱：暱稱缺席時系統分配的活動內名稱（活動內唯一）；不得作為唯一鍵，與暱稱為兩個概念';
COMMENT ON COLUMN app.participant.nickname IS '暱稱：學員自行輸入、可缺席；重複暱稱由系統附加辨識序號；不作唯一鍵';
COMMENT ON COLUMN app.participant.phase IS '參與階段（見型別註解）；已加入、在線、作答資格三者概念分開，不得混用';
COMMENT ON COLUMN app.participant.organization_id IS '組織歸屬（P1）：學員輸入組織代碼驗證後標記；P0 為 NULL';
COMMENT ON COLUMN app.participant.joined_at IS '加入時間（遲到者=首道計分題開放後才加入，僅可參與後續尚未開放且具資格之計分題）';
COMMENT ON COLUMN app.participant.created_at IS '建立時間';
COMMENT ON COLUMN app.participant.updated_at IS '最後更新時間';

CREATE TABLE app.participant_credential (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id  uuid NOT NULL REFERENCES app.participant(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  revoked_at      timestamptz
);
COMMENT ON TABLE app.participant_credential IS '參與者憑證：系統核發、不可猜測的匿名持久憑證，用於短暫斷線後重連恢復同一活動內身分；與加入資訊不同。格式/輪替/撤銷/重試限額依平台安全契約（待確認）。M08。';
COMMENT ON COLUMN app.participant_credential.id IS '代理主鍵';
COMMENT ON COLUMN app.participant_credential.participant_id IS '歸屬參與者（FK）；同一憑證跨裝置恢復同一身分，不得建第二個參與者';
COMMENT ON COLUMN app.participant_credential.token_hash IS '憑證 Token 雜湊（唯一、不可猜測、不可由客戶端指定）';
COMMENT ON COLUMN app.participant_credential.issued_at IS '核發時間';
COMMENT ON COLUMN app.participant_credential.expires_at IS '到期時間（待平台契約核定；NULL=活動期間有效）';
COMMENT ON COLUMN app.participant_credential.revoked_at IS '撤銷時間';

CREATE TABLE app.participant_heartbeat (
  participant_id  uuid NOT NULL REFERENCES app.participant(id) ON DELETE CASCADE,
  received_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (participant_id, received_at)
);
COMMENT ON TABLE app.participant_heartbeat IS '參與者心跳：平台即時服務驗證後接收的有效心跳；在線=最近 60 秒內收到有效心跳（不可由客戶端聲稱）。M07/M08。';
COMMENT ON COLUMN app.participant_heartbeat.participant_id IS '參與者（FK）';
COMMENT ON COLUMN app.participant_heartbeat.received_at IS '心跳接收時間（伺服器時間）；60 秒內有記錄即視為在線';

CREATE TABLE app.response (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            uuid NOT NULL REFERENCES app.teaching_session(id),
  session_question_id   uuid NOT NULL REFERENCES app.session_question(id),
  participant_id        uuid NOT NULL REFERENCES app.participant(id),
  question_type         question_type_e NOT NULL,
  answer                jsonb NOT NULL,
  is_valid              boolean NOT NULL DEFAULT true,
  is_latest             boolean NOT NULL DEFAULT true,
  client_submission_id  text,
  server_version        bigint NOT NULL DEFAULT 1,
  submitted_at          timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_response_latest UNIQUE (session_question_id, participant_id, is_latest, server_version)
);
COMMENT ON TABLE app.response IS '作答提交（有效提交）：伺服器成功接受、可納入統計或計分的答案；開放期間允許更新，以最後成功提交為準；每題每參與者至多一筆有效答案（去重）。M08/M09。';
COMMENT ON COLUMN app.response.id IS '代理主鍵';
COMMENT ON COLUMN app.response.session_id IS '所屬教學活動（FK，冗餘供查詢與擁有者範圍檢查）';
COMMENT ON COLUMN app.response.session_question_id IS '題目快照（FK）；必須關聯活動快照，不得指向來源題庫當前版本';
COMMENT ON COLUMN app.response.participant_id IS '作答參與者（FK）';
COMMENT ON COLUMN app.response.question_type IS '題型（須與題目快照題型相符）';
COMMENT ON COLUMN app.response.answer IS '答案內容（jsonb，依題型相容）：單選=單一有效選項；多選=至少一個有效選項且不重複（空集合整筆拒絕）；投票=僅限該題定義選項；開放式文字=文字回饋，合於平台共通輸入政策（長度/Unicode 正規化/安全過濾待契約）';
COMMENT ON COLUMN app.response.is_valid IS '是否有效提交：停題競態以伺服器原子受理順序裁決（提交先被接受則有效；停止先完成則無效且不納入統計/計分）；無效提交不保存為有效答案';
COMMENT ON COLUMN app.response.is_latest IS '是否最後成功提交（每題每參與者僅一筆 true）；開放期間多次更新以最後一筆通過的提交為準';
COMMENT ON COLUMN app.response.client_submission_id IS '冪等識別碼（Idempotency Key）：同識別碼重送回傳原結果，不重複建立或計分（細節依 M08/平台共通提交契約，待確認）';
COMMENT ON COLUMN app.response.server_version IS '伺服器版本序號：判定並行提交先後；同題同參與者版本唯一（於 uq_response_latest 約束）';
COMMENT ON COLUMN app.response.submitted_at IS '提交時間（伺服器受理時間）';
COMMENT ON COLUMN app.response.created_at IS '建立時間';
COMMENT ON COLUMN app.response.updated_at IS '最後更新時間';

-- ============================================================================
-- 6. 分組與團隊競賽（M11）
-- ============================================================================
CREATE TABLE app.session_team (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES app.teaching_session(id) ON DELETE CASCADE,
  team_no     integer NOT NULL,
  name        text NOT NULL,
  locked_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_team_no   UNIQUE (session_id, team_no),
  CONSTRAINT uq_team_name UNIQUE (session_id, name),
  CONSTRAINT ck_team_name CHECK (char_length(trim(name)) BETWEEN 1 AND 30)
);
COMMENT ON TABLE app.session_team IS '隊伍：單一活動內的合作/競賽單位；僅 grouping_mode=TEAM 存在（INDIVIDUAL 活動不得建立）；2–10 隊、任兩隊初始人數差至多 1、參與上限 300 有效學員/隊伍 10 隊。M06/M11。';
COMMENT ON COLUMN app.session_team.id IS '代理主鍵';
COMMENT ON COLUMN app.session_team.session_id IS '所屬教學活動（FK）';
COMMENT ON COLUMN app.session_team.team_no IS '隊號（活動內唯一序號；供預設隊名 Team-1、Team-2…）';
COMMENT ON COLUMN app.session_team.name IS '隊名：非空白 Unicode 自由文字，最多 30 字、去首尾空白、活動內唯一（可自訂）';
COMMENT ON COLUMN app.session_team.locked_at IS '分組確認時隊伍鎖定時間（老師確認分組的原子操作）';
COMMENT ON COLUMN app.session_team.created_at IS '建立時間';
COMMENT ON COLUMN app.session_team.updated_at IS '最後更新時間';

CREATE TABLE app.team_membership (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         uuid NOT NULL REFERENCES app.session_team(id) ON DELETE CASCADE,
  participant_id  uuid NOT NULL REFERENCES app.participant(id),
  assigned_reason team_member_reason_e NOT NULL,
  effective_from  timestamptz NOT NULL DEFAULT now(),
  is_active       boolean NOT NULL DEFAULT true,
  assigned_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_membership_active ON app.team_membership (participant_id) WHERE is_active;
COMMENT ON TABLE app.team_membership IS '隊員關聯：被編入隊伍的學員；同一有效學員同一時間至多屬於一個有效隊伍（partial unique index）。M11。';
COMMENT ON COLUMN app.team_membership.id IS '代理主鍵';
COMMENT ON COLUMN app.team_membership.team_id IS '隊伍（FK）';
COMMENT ON COLUMN app.team_membership.participant_id IS '隊員（參與者 FK）';
COMMENT ON COLUMN app.team_membership.assigned_reason IS '編入原因（見型別註解）；遲到指派不得改動既有隊員配置';
COMMENT ON COLUMN app.team_membership.effective_from IS '生效時點（必須紀錄，以界定遲到加入與資格快照的關係有效期）';
COMMENT ON COLUMN app.team_membership.is_active IS '有效旗標：同一時間至多一個有效隊伍；調離後保留紀錄（is_active=false）供追溯';
COMMENT ON COLUMN app.team_membership.assigned_at IS '編入操作時間';

CREATE TABLE app.question_eligibility_snapshot (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_question_id    uuid NOT NULL REFERENCES app.session_question(id),
  participant_id         uuid REFERENCES app.participant(id),
  team_id                uuid REFERENCES app.session_team(id),
  eligible_member_count  integer NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_eligibility_participant UNIQUE (session_question_id, participant_id),
  CONSTRAINT uq_eligibility_team       UNIQUE (session_question_id, team_id),
  CONSTRAINT ck_eligibility_target CHECK ((participant_id IS NULL) <> (team_id IS NULL))
);
COMMENT ON TABLE app.question_eligibility_snapshot IS '資格快照（Question Eligibility Snapshot）：每道計分題開放作答時固定的具作答資格名單，作為計分與統計分母；不可回溯變更、遲到者與旁聽不回寫。M09/M11。';
COMMENT ON COLUMN app.question_eligibility_snapshot.id IS '代理主鍵（team_score_ledger.eligibility_snapshot_id 引用）';
COMMENT ON COLUMN app.question_eligibility_snapshot.session_question_id IS '題目快照（FK；每計分題開放時建立一份）';
COMMENT ON COLUMN app.question_eligibility_snapshot.participant_id IS '具資格參與者（個人模式名單）；未作答計為錯誤/0 分';
COMMENT ON COLUMN app.question_eligibility_snapshot.team_id IS '具資格隊伍（TEAM 模式；每題每隊一列）';
COMMENT ON COLUMN app.question_eligibility_snapshot.eligible_member_count IS '資格快照人數（分母）：正確率=完全答對人數÷本值；完成率=有效作答人數÷本值；分母 0 顯示「不適用」';
COMMENT ON COLUMN app.question_eligibility_snapshot.created_at IS '快照建立（=該題開放作答）時間';

-- ============================================================================
-- 7. 計分、統計與排行榜（M09）
-- ============================================================================
CREATE TABLE app.personal_score (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            uuid NOT NULL REFERENCES app.teaching_session(id),
  session_question_id   uuid NOT NULL REFERENCES app.session_question(id),
  participant_id        uuid NOT NULL REFERENCES app.participant(id),
  score                 numeric(9,4) NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_personal_score UNIQUE (session_question_id, participant_id)
);
COMMENT ON TABLE app.personal_score IS '個人得分：每題答對 100、其餘 0、等權重累加；僅計分題；投票/開放式文字與 leaderboard_mode=NONE 之非統計用途不計分。M09。';
COMMENT ON COLUMN app.personal_score.id IS '代理主鍵';
COMMENT ON COLUMN app.personal_score.session_id IS '所屬教學活動（FK，冗餘）';
COMMENT ON COLUMN app.personal_score.session_question_id IS '題目快照（FK）';
COMMENT ON COLUMN app.personal_score.participant_id IS '參與者（FK）';
COMMENT ON COLUMN app.personal_score.score IS '該題個人得分：完全答對 100（多選須全對）、答錯或未答 0；numeric 高精度（畫面顯示 2 位小數）';
COMMENT ON COLUMN app.personal_score.created_at IS '計分時間';

CREATE TABLE app.answer_distribution (
  session_question_id         uuid NOT NULL REFERENCES app.session_question(id) ON DELETE CASCADE,
  session_question_option_id  uuid NOT NULL REFERENCES app.session_question_option(id) ON DELETE CASCADE,
  count                       integer NOT NULL DEFAULT 0,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_question_id, session_question_option_id)
);
COMMENT ON TABLE app.answer_distribution IS '答案分布：各選項的有效作答人數（以 is_valid 且 is_latest 之提交計）；比率以有效作答人數為分母另行計算（顯示 1 位小數，總和可能不為 100%）。M09。';
COMMENT ON COLUMN app.answer_distribution.session_question_id IS '題目快照（FK）';
COMMENT ON COLUMN app.answer_distribution.session_question_option_id IS '快照選項（FK）；僅統計該題定義選項';
COMMENT ON COLUMN app.answer_distribution.count IS '該選項有效作答人數';
COMMENT ON COLUMN app.answer_distribution.updated_at IS '最後更新時間';

CREATE TABLE app.question_stat (
  session_question_id  uuid PRIMARY KEY REFERENCES app.session_question(id) ON DELETE CASCADE,
  eligible_count       integer NOT NULL DEFAULT 0,
  answered_count       integer NOT NULL DEFAULT 0,
  correct_count        integer NOT NULL DEFAULT 0,
  status               settlement_status_e NOT NULL DEFAULT 'PENDING',
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_stat_counts CHECK (answered_count <= eligible_count OR eligible_count = 0)
);
COMMENT ON TABLE app.question_stat IS '逐題統計（Question Stat）；正確率=correct_count÷eligible_count（未作答計錯、多選須全對）、完成率=answered_count÷eligible_count，由計數推得避免重複儲存；分母 0 顯示「不適用」；中間計算不捨入、報表顯示 2 位小數。M09。';
COMMENT ON COLUMN app.question_stat.session_question_id IS '題目快照（PK/FK；一題一列）';
COMMENT ON COLUMN app.question_stat.eligible_count IS '資格快照人數（分母母體，取自 question_eligibility_snapshot；不得以在線/已加入人數代替）';
COMMENT ON COLUMN app.question_stat.answered_count IS '有效作答人數（不同參與者計）';
COMMENT ON COLUMN app.question_stat.correct_count IS '完全答對人數（多選須全對才算對；未作答計錯）';
COMMENT ON COLUMN app.question_stat.status IS '統計狀態（見型別註解）；未完成時回覆「處理中」；完成後才可供主持老師公布或進入下一題';
COMMENT ON COLUMN app.question_stat.updated_at IS '最後更新時間';

CREATE TABLE app.activity_summary (
  session_id               uuid PRIMARY KEY REFERENCES app.teaching_session(id) ON DELETE CASCADE,
  overall_correct_rate     numeric(6,4),
  overall_completion_rate  numeric(6,4),
  text_feedback_count      integer NOT NULL DEFAULT 0,
  updated_at               timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.activity_summary IS '活動摘要：逐題與整體正確率/完成率及文字回饋人數彙總；整體 rate 為僅納入「有標準答案且資格人數>0」題目之不加權算術平均（NULL=不適用）。M09。';
COMMENT ON COLUMN app.activity_summary.session_id IS '教學活動（PK/FK）';
COMMENT ON COLUMN app.activity_summary.overall_correct_rate IS '整體正確率（不加權平均；NULL=無適用題目「不適用」）';
COMMENT ON COLUMN app.activity_summary.overall_completion_rate IS '整體完成率（僅納入資格人數>0 之題目；NULL=不適用）';
COMMENT ON COLUMN app.activity_summary.text_feedback_count IS '文字回饋人數：逐題至少一筆有效文字回饋之不同參與者數（修改不重複計數）；P0 僅提供數量，內容僅供授課老師與授權分析';
COMMENT ON COLUMN app.activity_summary.updated_at IS '最後更新時間';

CREATE TABLE app.leaderboard_entry (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id             uuid NOT NULL REFERENCES app.teaching_session(id) ON DELETE CASCADE,
  target_participant_id  uuid REFERENCES app.participant(id),
  target_team_id         uuid REFERENCES app.session_team(id),
  rank_kind              leaderboard_mode_e NOT NULL,
  total_score            numeric(12,4) NOT NULL DEFAULT 0,
  rank                   integer NOT NULL,
  generated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_leaderboard_target CHECK ((target_participant_id IS NULL) <> (target_team_id IS NULL))
);
COMMENT ON TABLE app.leaderboard_entry IS '排行榜（Leaderboard）：依分數排序的名次清單；僅相容模式啟用且主持老師公布後向學員顯示（公布時點在 publish_log；計算完成≠已公布）。M09/M11。';
COMMENT ON COLUMN app.leaderboard_entry.id IS '代理主鍵';
COMMENT ON COLUMN app.leaderboard_entry.session_id IS '所屬教學活動（FK）';
COMMENT ON COLUMN app.leaderboard_entry.target_participant_id IS '個人排行榜之參與者（隊伍榜為 NULL）';
COMMENT ON COLUMN app.leaderboard_entry.target_team_id IS '隊伍排行榜之隊伍（個人榜為 NULL；學員端僅見隊名、總分、名次，不得含隊員名單或個人分數）';
COMMENT ON COLUMN app.leaderboard_entry.rank_kind IS '榜單種類（以 leaderboard_mode 語意命名）：INDIVIDUAL 個人排行榜 / TEAM 隊伍排行榜；須與活動 leaderboard_mode 相容';
COMMENT ON COLUMN app.leaderboard_entry.total_score IS '總分：個人=各題等權重累加；隊伍=各已結算計分題 team_question_score 加總；numeric 高精度、顯示 2 位小數';
COMMENT ON COLUMN app.leaderboard_entry.rank IS '名次：個人榜競賽排名（同分並列後跳號 1,1,3）；隊伍榜密集排名（同分並列不跳號 1,1,2）；並列名次不使用未公告的決勝規則（如速度加分）';
COMMENT ON COLUMN app.leaderboard_entry.generated_at IS '生成時間（計算完成≠已公布）';

CREATE TABLE app.team_score_ledger (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id              uuid NOT NULL REFERENCES app.teaching_session(id),
  session_question_id     uuid NOT NULL REFERENCES app.session_question(id),
  team_id                 uuid NOT NULL REFERENCES app.session_team(id),
  eligibility_snapshot_id uuid NOT NULL REFERENCES app.question_eligibility_snapshot(id),
  eligible_member_count   integer NOT NULL,
  raw_score_sum           numeric(12,4) NOT NULL,
  team_question_score     numeric(12,4) NOT NULL,
  status                  settlement_status_e NOT NULL DEFAULT 'PENDING',
  idempotency_key         text UNIQUE,
  settled_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ledger_qt UNIQUE (session_question_id, team_id),
  CONSTRAINT ck_ledger_nonneg CHECK (raw_score_sum >= 0 AND eligible_member_count >= 0)
);
COMMENT ON TABLE app.team_score_ledger IS '團隊結算（TEAM_SCORE_LEDGER）：每題每隊至多一筆有效結算（唯一約束）；分數=具資格隊員個人得分總和÷該題資格快照人數；未作答計 0；不得負分或加權配分。M11/M09。';
COMMENT ON COLUMN app.team_score_ledger.id IS '代理主鍵';
COMMENT ON COLUMN app.team_score_ledger.session_id IS '所屬教學活動（FK，冗餘）';
COMMENT ON COLUMN app.team_score_ledger.session_question_id IS '題目快照（FK；與 team_id 合組唯一）';
COMMENT ON COLUMN app.team_score_ledger.team_id IS '隊伍（FK）';
COMMENT ON COLUMN app.team_score_ledger.eligibility_snapshot_id IS '引用之資格快照（不得以即時在線或事後名單取代）';
COMMENT ON COLUMN app.team_score_ledger.eligible_member_count IS '該題該隊具資格人數（結算分母，取自資格快照）';
COMMENT ON COLUMN app.team_score_ledger.raw_score_sum IS '具資格隊員個人得分總和（未作答計 0）';
COMMENT ON COLUMN app.team_score_ledger.team_question_score IS '該題隊伍得分 = raw_score_sum ÷ eligible_member_count；numeric 高精度保存、不逐題捨入（如 200÷3 存 66.6667、畫面顯示 66.67）';
COMMENT ON COLUMN app.team_score_ledger.status IS '結算狀態（見型別註解）：失敗保持未完成、重試不得重複加分或部分加分';
COMMENT ON COLUMN app.team_score_ledger.idempotency_key IS '結算請求冪等識別碼（唯一）：同 key 重送回傳原結果，不重複執行';
COMMENT ON COLUMN app.team_score_ledger.settled_at IS '結算完成時間';
COMMENT ON COLUMN app.team_score_ledger.created_at IS '建立（試算開始）時間';

-- ============================================================================
-- 8. 公布、控制與事件稽核（M07/M11/M03）
-- ============================================================================
CREATE TABLE app.publish_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          uuid NOT NULL REFERENCES app.teaching_session(id),
  session_question_id uuid REFERENCES app.session_question(id),
  kind                publish_kind_e NOT NULL,
  version             integer NOT NULL DEFAULT 1,
  corrected           boolean NOT NULL DEFAULT false,
  correction_reason   text,
  published_by        uuid NOT NULL REFERENCES app.user_account(id),
  published_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_publish_version UNIQUE (session_id, session_question_id, kind, version),
  CONSTRAINT ck_question_kind CHECK (
    (kind IN ('STATS','CORRECT_ANSWER')) = (session_question_id IS NOT NULL)
  ),
  CONSTRAINT ck_correction CHECK (corrected = false OR correction_reason IS NOT NULL)
);
COMMENT ON TABLE app.publish_log IS '公布記錄：老師明確向學員或投影公布統計（答案分布）/正確答案/個人排行榜/隊伍排行榜；一經公布不可撤回；更正為新版本（保留原版與更正原因），學員端顯示最新有效版本並標示已更正。M07/M09/M11。';
COMMENT ON COLUMN app.publish_log.id IS '代理主鍵';
COMMENT ON COLUMN app.publish_log.session_id IS '所屬教學活動（FK）';
COMMENT ON COLUMN app.publish_log.session_question_id IS '題目（題目層公布：STATS、CORRECT_ANSWER 必填；活動層公布：兩種排行榜為 NULL）';
COMMENT ON COLUMN app.publish_log.kind IS '公布種類（見型別註解）；四項公布彼此獨立，一項公布不代表其他公布';
COMMENT ON COLUMN app.publish_log.version IS '公布版本號：更正為遞增新版本，原公布版本保留';
COMMENT ON COLUMN app.publish_log.corrected IS '是否為更正版本';
COMMENT ON COLUMN app.publish_log.correction_reason IS '更正原因（更正時必填）';
COMMENT ON COLUMN app.publish_log.published_by IS '公布者（主持老師 FK）';
COMMENT ON COLUMN app.publish_log.published_at IS '公布時間';

CREATE TABLE app.activity_event_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid REFERENCES app.teaching_session(id),
  actor_user_id   uuid REFERENCES app.user_account(id),
  kind            event_kind_e NOT NULL,
  detail          jsonb,
  idempotency_key text UNIQUE,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.activity_event_log IS '活動事件稽核：開始/結束活動、模式異動、分組確認與解鎖重建、控制租約授予/續期/釋放、加入資訊產生/撤銷、選題/開放/停止作答、公布、批次帳號操作等；不得記錄密碼、登入憑證、邀請連結等秘密。M06/M07/M03/M11。';
COMMENT ON COLUMN app.activity_event_log.id IS '代理主鍵';
COMMENT ON COLUMN app.activity_event_log.session_id IS '相關活動（FK；帳號層事件可為 NULL）';
COMMENT ON COLUMN app.activity_event_log.actor_user_id IS '操作者（Acting User）帳號（FK）';
COMMENT ON COLUMN app.activity_event_log.kind IS '事件種類（見型別註解）；公布類事件同時寫入 publish_log';
COMMENT ON COLUMN app.activity_event_log.detail IS '事件細節（jsonb）：如新舊模式值、新舊隊伍安排、更正原因等；禁止含秘密明文';
COMMENT ON COLUMN app.activity_event_log.idempotency_key IS '冪等識別碼（唯一）：控制台/批次重送不重複記錄或執行';
COMMENT ON COLUMN app.activity_event_log.occurred_at IS '事件時間';

-- ============================================================================
-- 9. 系統設定與營運監控（M10）
-- ============================================================================
CREATE TABLE app.system_parameter (
  code        text PRIMARY KEY,
  value       text NOT NULL,
  value_type  text NOT NULL,
  min_value   text,
  max_value   text,
  version     integer NOT NULL DEFAULT 1,
  updated_by  uuid REFERENCES app.user_account(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.system_parameter IS '系統參數：活動預設值與登入 Session 逾時兩類全域設定；活動建立時固化預設值於活動資料，變更不回溯既有活動與 Session。M10。';
COMMENT ON COLUMN app.system_parameter.code IS '參數代碼（PK；核准代碼/型別/範圍依平台政策核定，待確認）';
COMMENT ON COLUMN app.system_parameter.value IS '核准設定值（型別/預設值/可調範圍依平台政策核定，待確認）';
COMMENT ON COLUMN app.system_parameter.value_type IS '參數型別（依平台政策核定）';
COMMENT ON COLUMN app.system_parameter.min_value IS '可調下界（核准後依平台政策填入）';
COMMENT ON COLUMN app.system_parameter.max_value IS '可調上界（核准後依平台政策填入）';
COMMENT ON COLUMN app.system_parameter.version IS '樂觀鎖版本：批次更新全有全無（All-or-nothing）；版本不符即全數拒絕並要求重新讀取';
COMMENT ON COLUMN app.system_parameter.updated_by IS '更新操作者帳號（FK，稽核）';
COMMENT ON COLUMN app.system_parameter.updated_at IS '最後更新時間';

-- ============================================================================
-- 10. 批次操作（M03）
-- ============================================================================
CREATE TABLE app.batch_operation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  batch_type      batch_type_e NOT NULL,
  item_count      integer NOT NULL,
  status          batch_status_e NOT NULL DEFAULT 'SUBMITTED',
  payload         jsonb NOT NULL,
  created_by      uuid NOT NULL REFERENCES app.user_account(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  CONSTRAINT ck_batch_size CHECK (item_count BETWEEN 1 AND 100)
);
COMMENT ON TABLE app.batch_operation IS '批次操作（M03）：1–100 筆全有全無；相同冪等識別碼+相同內容重送回傳先前結果、內容不同則拒絕；任一項失敗整批回復（批次停用主持中老師需原子完成帳號停用+憑證撤銷+活動終止；活動終止失敗時帳號回復、已成功終止活動維持結定並保留結果）。';
COMMENT ON COLUMN app.batch_operation.id IS '代理主鍵';
COMMENT ON COLUMN app.batch_operation.idempotency_key IS '批次冪等識別碼（唯一）：重送一致性比對用';
COMMENT ON COLUMN app.batch_operation.batch_type IS '操作種類（見型別註解）';
COMMENT ON COLUMN app.batch_operation.item_count IS '項目數（1–100）';
COMMENT ON COLUMN app.batch_operation.status IS '批次狀態（見型別註解）';
COMMENT ON COLUMN app.batch_operation.payload IS '請求內容（jsonb；重送一致性比對用；不含秘密明文）';
COMMENT ON COLUMN app.batch_operation.created_by IS '操作者帳號（FK）';
COMMENT ON COLUMN app.batch_operation.created_at IS '建立時間';
COMMENT ON COLUMN app.batch_operation.completed_at IS '完成/失敗確定時間';

-- ============================================================================
-- 11. P1 概念（組織競賽、匯出）
-- ============================================================================
CREATE TABLE app.organization (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.organization IS '組織（P1）：公司、協會或公益團體，為組織間競賽（Inter-organization Competition）的比較單位；不可與隊伍混同。M11/規劃書。';
COMMENT ON COLUMN app.organization.id IS '代理主鍵';
COMMENT ON COLUMN app.organization.name IS '組織名稱';
COMMENT ON COLUMN app.organization.created_at IS '建立時間';

ALTER TABLE app.participant
  ADD CONSTRAINT fk_participant_org FOREIGN KEY (organization_id) REFERENCES app.organization(id);

CREATE TABLE app.export_job (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES app.teaching_session(id),
  requested_by    uuid NOT NULL REFERENCES app.user_account(id),
  format          export_format_e NOT NULL,
  status          export_status_e NOT NULL DEFAULT 'PROCESSING',
  generated_at    timestamptz,
  download_expiry timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.export_job IS '匯出作業（P1，Export Job）：活動報表匯出 CSV（UTF-8）/XLSX；欄位須與畫面報表一致、文字欄位防公式注入、不含未公布結果或未授權個資；匯出授權不得大於畫面報表授權。M09。';
COMMENT ON COLUMN app.export_job.id IS '代理主鍵';
COMMENT ON COLUMN app.export_job.session_id IS '活動（FK）';
COMMENT ON COLUMN app.export_job.requested_by IS '請求者帳號（FK）';
COMMENT ON COLUMN app.export_job.format IS '匯出格式（見型別註解）';
COMMENT ON COLUMN app.export_job.status IS '作業狀態（見型別註解）';
COMMENT ON COLUMN app.export_job.generated_at IS '產生時間';
COMMENT ON COLUMN app.export_job.download_expiry IS '下載連結逾期時間（依平台政策）';
COMMENT ON COLUMN app.export_job.created_at IS '建立時間';

COMMIT;