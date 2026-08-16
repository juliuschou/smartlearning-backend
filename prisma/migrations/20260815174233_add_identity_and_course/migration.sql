-- Migration: add_identity_and_course
-- 垂直切片：最小 Auth（account/web_session）+ Course CRUD。
-- 慣例沿用 init_system_setting：additive only；identity 為 UUID v7 由 app 層產生
-- （無 DB default）；狀態欄位用 TEXT + 手寫 CHECK（Prisma 無法產生 CHECK）。
--
-- 設計前提（M2 關鍵技術決策）：
--   §1 Identity：UUID v7，app 層產生，寫入帶值（PK 為 UUID，非 BIGINT identity）。
--   §2 狀態：TEXT + CHECK，不用 PostgreSQL native ENUM。
--   §4 Web Session：PostgreSQL opaque session，cookie 只放高熵 token，DB 存 hash。
--   §5 Argon2id：m=64MiB t=3 p=1（應用層常數，非 DB 範疇）。
--
-- 切片延後（不在本 migration）：credential_version/auth_epoch、AuditEvent、
--   login_attempt、cli_credential、step_up_at、course 題目/live_session。

-- Account ----------------------------------------------------------------
CREATE TABLE "account" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "can_create_course" BOOLEAN NOT NULL DEFAULT false,
    "password_hash" TEXT,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "password_changed_at" TIMESTAMPTZ,
    "disabled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" UUID,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "account_role_check" CHECK ("role" IN ('admin', 'teacher')),
    CONSTRAINT "account_status_check" CHECK ("status" IN ('active', 'disabled'))
);

CREATE UNIQUE INDEX "account_username_key" ON "account"("username");
CREATE INDEX "idx_account_created_by" ON "account"("created_by");

-- Self-FK：建立者帳號；bootstrap 首位 admin 為 NULL。ON DELETE RESTRICT。
ALTER TABLE "account"
  ADD CONSTRAINT "account_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "account"("id") ON DELETE RESTRICT;

-- WebSession -------------------------------------------------------------
CREATE TABLE "web_session" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "cookie_hash" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "web_session_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "web_session_account_id_fkey"
      FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "web_session_cookie_hash_key" ON "web_session"("cookie_hash");
CREATE INDEX "idx_web_session_account" ON "web_session"("account_id");
-- Partial index：僅活躍 session，供 idle/absolute 過期掃描（切片未實作掃描，先建）。
CREATE INDEX "idx_web_session_active"
  ON "web_session"("expires_at") WHERE "revoked_at" IS NULL;

-- Course -----------------------------------------------------------------
CREATE TABLE "course" (
    "id" UUID NOT NULL,
    "owner_account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "course_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "course_status_check" CHECK ("status" IN ('draft', 'archived')),
    CONSTRAINT "course_owner_account_id_fkey"
      FOREIGN KEY ("owner_account_id") REFERENCES "account"("id") ON DELETE RESTRICT
);

CREATE INDEX "idx_course_owner" ON "course"("owner_account_id");