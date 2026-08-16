-- Enforce that a LiveSessionQuestionSelection joins parents from the same Course.
-- Backfill from the session and fail closed if existing rows are cross-course.

ALTER TABLE "live_session_question_selection"
  ADD COLUMN "course_id" UUID;

UPDATE "live_session_question_selection" AS selection
SET "course_id" = session."course_id"
FROM "live_session" AS session
WHERE session."id" = selection."live_session_id";

ALTER TABLE "live_session_question_selection"
  ALTER COLUMN "course_id" SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "live_session_question_selection" AS selection
    JOIN "question_definition" AS question
      ON question."id" = selection."question_definition_id"
    WHERE question."course_id" <> selection."course_id"
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce course scope: live_session_question_selection contains cross-course rows';
  END IF;
END $$;

CREATE UNIQUE INDEX "uq_live_session_id_course"
  ON "live_session"("id", "course_id");
CREATE UNIQUE INDEX "uq_question_definition_id_course"
  ON "question_definition"("id", "course_id");

ALTER TABLE "live_session_question_selection"
  DROP CONSTRAINT "live_session_question_selection_live_session_id_fkey",
  DROP CONSTRAINT "live_session_question_selection_question_definition_id_fkey",
  ADD CONSTRAINT "live_session_question_selection_live_session_course_fkey"
    FOREIGN KEY ("live_session_id", "course_id")
    REFERENCES "live_session"("id", "course_id")
    ON DELETE CASCADE,
  ADD CONSTRAINT "live_session_question_selection_question_definition_course_fkey"
    FOREIGN KEY ("question_definition_id", "course_id")
    REFERENCES "question_definition"("id", "course_id")
    ON DELETE RESTRICT;
