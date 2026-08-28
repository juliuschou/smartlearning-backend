CREATE TABLE "archived_result" (
  "id" UUID PRIMARY KEY,
  "live_session_id" UUID NOT NULL UNIQUE REFERENCES "live_session"("id") ON DELETE RESTRICT,
  "course_id" UUID NOT NULL REFERENCES "course"("id") ON DELETE RESTRICT,
  "closed_at" TIMESTAMPTZ NOT NULL,
  "purge_at" TIMESTAMPTZ NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active','deleted')),
  "payload" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "idx_archived_result_course_closed" ON "archived_result" ("course_id", "closed_at");
CREATE INDEX "idx_archived_result_purge_status" ON "archived_result" ("purge_at", "status");
CREATE TABLE "deletion_event" (
  "id" UUID PRIMARY KEY,
  "archived_result_id" UUID REFERENCES "archived_result"("id") ON DELETE SET NULL,
  "live_session_id" UUID NOT NULL REFERENCES "live_session"("id") ON DELETE RESTRICT,
  "course_id" UUID NOT NULL REFERENCES "course"("id") ON DELETE RESTRICT,
  "requester_id" UUID REFERENCES "account"("id") ON DELETE SET NULL,
  "executor_id" UUID REFERENCES "account"("id") ON DELETE SET NULL,
  "trigger" TEXT NOT NULL CHECK ("trigger" IN ('teacher_request','early_delete','retention')),
  "reason" TEXT CHECK ("reason" IS NULL OR "reason" IN ('privacy','support','retention')),
  "status" TEXT NOT NULL CHECK ("status" IN ('requested','success','failure')),
  "deleted_categories" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ,
  "error_code" TEXT
);
CREATE INDEX "idx_deletion_event_session_trigger" ON "deletion_event" ("live_session_id", "trigger");
