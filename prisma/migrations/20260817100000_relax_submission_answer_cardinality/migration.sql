-- Relax the submission answer constraints so poll-multiple, quiz, and
-- open_text answers can be persisted. The prior hardening migration
-- (20260816130000) locked `selected_option_refs` to exactly one string to
-- match the poll/single vertical slice; this replaces it with a shape-only
-- guard and adds a length bound for open-text answers.
--
-- PostgreSQL CHECK constraints cannot contain subqueries, so element type and
-- per-element length are validated with the SQL/JSON path predicate
-- `jsonb_path_exists` (an IMMUTABLE function allowed in CHECK).
--
-- Type-specific cardinality (poll single/multiple, quiz exact-set, open_text
-- text-only) and the refs/text mutual exclusion remain application-layer
-- invariants keyed off `session_question.snapshot_type`; PostgreSQL CHECK
-- cannot express cross-table rules.
ALTER TABLE "submission"
  DROP CONSTRAINT "submission_selected_option_refs_array_check",
  ADD CONSTRAINT "submission_selected_option_refs_array_check"
    CHECK (
      "selected_option_refs" IS NULL
      OR (
        jsonb_typeof("selected_option_refs") = 'array'
        AND jsonb_array_length("selected_option_refs") >= 1
        AND NOT jsonb_path_exists(
          "selected_option_refs",
          '$[*] ? (@.type() != "string" || @.size() > 250)'
        )
      )
    );

-- Bound open-text answers to the contract length (<=2000 Unicode code points
-- after normalization). NULL remains allowed for option-type answers.
ALTER TABLE "submission"
  ADD CONSTRAINT "submission_text_answer_length_check"
    CHECK (
      "text_answer" IS NULL
      OR char_length("text_answer") <= 2000
    );