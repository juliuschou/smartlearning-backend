-- Phase B3: bind an optional Participant identity to a student Account.
-- Anonymous token-backed rows remain valid; PostgreSQL permits multiple NULLs in
-- the account uniqueness index, so anonymous joins retain their old behavior.

ALTER TABLE "participant"
  ADD COLUMN "account_id" UUID;

ALTER TABLE "participant"
  ADD CONSTRAINT "participant_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "account"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE UNIQUE INDEX "uq_participant_session_account"
  ON "participant"("live_session_id", "account_id");
CREATE INDEX "idx_participant_account"
  ON "participant"("account_id");
