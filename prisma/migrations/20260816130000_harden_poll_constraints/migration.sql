-- Harden additive poll constraints after the initial vertical-slice migration.
-- PostgreSQL CHECK expressions accept NULL unless the expression is FALSE, so
-- the poll selection-mode branch must explicitly reject NULL.
ALTER TABLE "question_definition"
  DROP CONSTRAINT "question_definition_selection_check",
  ADD CONSTRAINT "question_definition_selection_check"
    CHECK (
      ("type" = 'poll'
        AND "selection_mode" IS NOT NULL
        AND "selection_mode" IN ('single', 'multiple'))
      OR ("type" IN ('open_text', 'quiz') AND "selection_mode" IS NULL)
    );

-- The runtime slice only writes one-choice poll answers. Keep NULL available for
-- future open-text rows, but reject malformed non-null JSON arrays at the DB edge.
ALTER TABLE "submission"
  DROP CONSTRAINT "submission_selected_option_refs_array_check",
  ADD CONSTRAINT "submission_selected_option_refs_array_check"
    CHECK (
      "selected_option_refs" IS NULL
      OR (
        jsonb_typeof("selected_option_refs") = 'array'
        AND jsonb_array_length("selected_option_refs") = 1
        AND jsonb_typeof("selected_option_refs" -> 0) = 'string'
      )
    );

-- Enforce that denormalized Submission scope columns all point to the same
-- LiveSession, even for direct/future writers that bypass the application.
CREATE UNIQUE INDEX "uq_session_question_id_live_session"
  ON "session_question"("id", "live_session_id");
CREATE UNIQUE INDEX "uq_participant_id_live_session"
  ON "participant"("id", "live_session_id");

ALTER TABLE "submission"
  ADD CONSTRAINT "submission_session_question_live_session_fkey"
    FOREIGN KEY ("session_question_id", "live_session_id")
    REFERENCES "session_question"("id", "live_session_id")
    ON DELETE RESTRICT,
  ADD CONSTRAINT "submission_participant_live_session_fkey"
    FOREIGN KEY ("participant_id", "live_session_id")
    REFERENCES "participant"("id", "live_session_id")
    ON DELETE RESTRICT;
