-- Preserve optional wire-level option refs through source and activation snapshots.
-- Formal UUID option IDs remain the Submission persistence identity.
ALTER TABLE "question_option"
  ADD COLUMN "option_ref" TEXT,
  ADD CONSTRAINT "question_option_option_ref_length_check"
    CHECK ("option_ref" IS NULL OR char_length("option_ref") BETWEEN 1 AND 250);
CREATE UNIQUE INDEX "uq_question_option_question_ref"
  ON "question_option"("question_definition_id", "option_ref");

ALTER TABLE "session_question_option"
  ADD COLUMN "option_ref" TEXT,
  ADD CONSTRAINT "session_question_option_option_ref_length_check"
    CHECK ("option_ref" IS NULL OR char_length("option_ref") BETWEEN 1 AND 250);
CREATE UNIQUE INDEX "uq_session_question_option_question_ref"
  ON "session_question_option"("session_question_id", "option_ref");
