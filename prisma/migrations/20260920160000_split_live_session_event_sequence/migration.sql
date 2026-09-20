-- Separate durable event ordering from the LiveSession lifecycle row. This is
-- additive: the legacy counter remains available for a quiesced rollback.
CREATE TABLE "live_session_event_sequence" (
  "live_session_id" UUID NOT NULL,
  "last_event_seq" BIGINT NOT NULL DEFAULT 0,

  CONSTRAINT "live_session_event_sequence_pkey" PRIMARY KEY ("live_session_id"),
  CONSTRAINT "ck_live_session_event_sequence_nonnegative"
    CHECK ("last_event_seq" >= 0),
  CONSTRAINT "live_session_event_sequence_live_session_id_fkey"
    FOREIGN KEY ("live_session_id")
    REFERENCES "live_session"("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION
);

-- Retention may have removed old event rows, while the legacy counter remains
-- the high-water mark. Prefer the greatest authoritative value for cutover.
INSERT INTO "live_session_event_sequence" (
  "live_session_id",
  "last_event_seq"
)
SELECT
  session_row."id",
  GREATEST(
    session_row."realtime_event_seq",
    COALESCE(MAX(event_row."event_seq"), 0::BIGINT)
  )
FROM "live_session" AS session_row
LEFT JOIN "live_session_event" AS event_row
  ON event_row."live_session_id" = session_row."id"
GROUP BY session_row."id", session_row."realtime_event_seq";
