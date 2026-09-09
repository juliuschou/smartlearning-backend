DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "archived_result"
    WHERE ("status" = 'active' AND "payload" IS NULL)
       OR ("status" = 'deleted' AND "payload" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'archive status/payload invariant violated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "deletion_event"
    WHERE "trigger" = 'teacher_request' AND "status" = 'requested'
    GROUP BY "live_session_id" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'multiple outstanding deletion requests exist for one session';
  END IF;
END $$;

ALTER TABLE "archived_result" ADD COLUMN "session_label" TEXT;
ALTER TABLE "archived_result" ADD COLUMN "started_at" TIMESTAMPTZ;

UPDATE "archived_result" a
SET "started_at" = COALESCE(s."started_at", a."closed_at"),
    "session_label" = to_char(COALESCE(s."started_at", a."closed_at") AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM "live_session" s
WHERE s."id" = a."live_session_id";

ALTER TABLE "archived_result" ALTER COLUMN "session_label" SET NOT NULL;
ALTER TABLE "archived_result" ALTER COLUMN "started_at" SET NOT NULL;
ALTER TABLE "archived_result" ADD CONSTRAINT "ck_archived_result_status_payload"
  CHECK (("status" = 'active' AND "payload" IS NOT NULL) OR ("status" = 'deleted' AND "payload" IS NULL));
CREATE INDEX "idx_archived_result_closed_id" ON "archived_result" ("closed_at" DESC, "id" DESC);

DROP INDEX "uq_deletion_event_outstanding_request";
ALTER TABLE "deletion_event" ADD COLUMN "resolved_by_event_id" UUID;
ALTER TABLE "deletion_event" ADD CONSTRAINT "fk_deletion_event_resolved_by"
  FOREIGN KEY ("resolved_by_event_id") REFERENCES "deletion_event"("id") ON DELETE RESTRICT;
ALTER TABLE "deletion_event" ADD CONSTRAINT "ck_deletion_event_state"
  CHECK (
    ("trigger" = 'teacher_request' AND "status" = 'requested' AND "completed_at" IS NULL AND "resolved_by_event_id" IS NULL AND "executor_id" IS NULL)
    OR
    ("trigger" = 'teacher_request' AND "status" = 'success' AND "completed_at" IS NOT NULL AND "resolved_by_event_id" IS NOT NULL AND "executor_id" IS NULL)
    OR
    ("trigger" = 'early_delete' AND "status" = 'success' AND "completed_at" IS NOT NULL AND "resolved_by_event_id" IS NULL)
    OR
    ("trigger" = 'retention' AND "status" = 'success' AND "completed_at" IS NOT NULL AND "resolved_by_event_id" IS NULL AND "executor_id" IS NULL AND "reason" = 'retention')
    OR "status" = 'failure'
  );
CREATE UNIQUE INDEX "uq_deletion_event_outstanding_request"
  ON "deletion_event" ("live_session_id")
  WHERE "trigger" = 'teacher_request' AND "status" = 'requested';
CREATE UNIQUE INDEX "uq_deletion_event_canonical_deletion"
  ON "deletion_event" ("live_session_id")
  WHERE "trigger" IN ('early_delete','retention') AND "status" = 'success';
CREATE UNIQUE INDEX "uq_deletion_event_resolved_by"
  ON "deletion_event" ("resolved_by_event_id")
  WHERE "resolved_by_event_id" IS NOT NULL;
CREATE INDEX "idx_deletion_event_pending_queue"
  ON "deletion_event" ("status", "created_at", "id")
  WHERE "trigger" = 'teacher_request';
