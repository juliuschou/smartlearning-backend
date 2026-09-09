CREATE TABLE "deletion_manifest_outbox" (
  "id" UUID NOT NULL,
  "archived_result_id" UUID NOT NULL,
  "deletion_event_id" UUID NOT NULL,
  "contract_version" TEXT NOT NULL,
  "manifest" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "exported_at" TIMESTAMPTZ,
  CONSTRAINT "deletion_manifest_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "deletion_manifest_outbox_archived_result_id_key" UNIQUE ("archived_result_id"),
  CONSTRAINT "deletion_manifest_outbox_deletion_event_id_key" UNIQUE ("deletion_event_id"),
  CONSTRAINT "deletion_manifest_outbox_archived_result_id_fkey" FOREIGN KEY ("archived_result_id") REFERENCES "archived_result"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "deletion_manifest_outbox_deletion_event_id_fkey" FOREIGN KEY ("deletion_event_id") REFERENCES "deletion_event"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "deletion_manifest_outbox_status_check" CHECK ("status" IN ('pending', 'exported', 'failed')),
  CONSTRAINT "deletion_manifest_outbox_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "deletion_manifest_outbox_exported_at_check" CHECK (("status" = 'exported') = ("exported_at" IS NOT NULL))
);
CREATE INDEX "idx_deletion_manifest_outbox_pending" ON "deletion_manifest_outbox" ("status", "next_attempt_at", "id");
