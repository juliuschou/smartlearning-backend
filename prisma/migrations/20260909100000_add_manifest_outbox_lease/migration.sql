ALTER TABLE "deletion_manifest_outbox"
  ADD COLUMN "lease_token" UUID,
  ADD COLUMN "lease_expires_at" TIMESTAMPTZ;

CREATE INDEX "idx_deletion_manifest_outbox_lease"
  ON "deletion_manifest_outbox" ("status", "lease_expires_at");

ALTER TABLE "deletion_manifest_outbox"
  DROP CONSTRAINT "deletion_manifest_outbox_status_check",
  ADD CONSTRAINT "deletion_manifest_outbox_status_check"
    CHECK ("status" IN ('pending', 'processing', 'retry', 'exported', 'failed'));
