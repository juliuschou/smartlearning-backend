-- BE-7: durable realtime sequence, question aggregate versions, and outbox/event log.
-- This migration is additive. Event rows are delivery/replay evidence and must not
-- make the existing archive/tombstone governance path depend on a live question.

ALTER TABLE "live_session"
  ADD COLUMN "realtime_event_seq" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "live_session"
  ADD CONSTRAINT "ck_live_session_realtime_event_seq_nonnegative"
  CHECK ("realtime_event_seq" >= 0);

ALTER TABLE "session_question"
  ADD COLUMN "aggregate_version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "session_question"
  ADD CONSTRAINT "ck_session_question_aggregate_version_nonnegative"
  CHECK ("aggregate_version" >= 0);

CREATE TABLE "live_session_event" (
  "id" UUID PRIMARY KEY,
  "live_session_id" UUID NOT NULL
    REFERENCES "live_session"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  "session_question_id" UUID
    REFERENCES "session_question"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  "target_participant_id" UUID,
  "event_name" TEXT NOT NULL
    CHECK ("event_name" IN (
      'session.snapshot',
      'session.state_changed',
      'question.opened',
      'question.closed',
      'result.updated',
      'session.closed',
      'sync.required'
    )),
  "schema_version" INTEGER NOT NULL DEFAULT 1
    CHECK ("schema_version" = 1),
  "event_seq" BIGINT NOT NULL
    CHECK ("event_seq" > 0),
  "aggregate_version" INTEGER NOT NULL DEFAULT 0
    CHECK ("aggregate_version" >= 0),
  "server_timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "visibility" TEXT NOT NULL
    CHECK ("visibility" IN (
      'session',
      'teacher',
      'participant',
      'participant_after_submit'
    )),
  "projection_input" JSONB
    CHECK (
      "projection_input" IS NULL
      OR jsonb_typeof("projection_input") = 'object'
    ),
  CHECK (
    ("visibility" = 'participant_after_submit') =
    ("target_participant_id" IS NOT NULL)
  ),
  "delivery_state" TEXT NOT NULL DEFAULT 'pending'
    CHECK ("delivery_state" IN (
      'pending',
      'processing',
      'retry',
      'delivered',
      'dead'
    )),
  "attempt_count" INTEGER NOT NULL DEFAULT 0
    CHECK ("attempt_count" >= 0),
  "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimed_at" TIMESTAMPTZ,
  "claim_token" UUID,
  "lease_expires_at" TIMESTAMPTZ,
  "last_failure_class" TEXT,
  "coalesced" BOOLEAN NOT NULL DEFAULT FALSE,
  "delivered_at" TIMESTAMPTZ,
  "expires_at" TIMESTAMPTZ
);

ALTER TABLE "live_session_event"
  ADD CONSTRAINT "uq_live_session_event_session_seq"
  UNIQUE ("live_session_id", "event_seq");

CREATE INDEX "idx_live_session_event_replay"
  ON "live_session_event" ("live_session_id", "event_seq");

CREATE INDEX "idx_live_session_event_delivery"
  ON "live_session_event" ("delivery_state", "next_attempt_at", "lease_expires_at");

CREATE INDEX "idx_live_session_event_expiry"
  ON "live_session_event" ("expires_at");

CREATE INDEX "idx_live_session_event_coalesce"
  ON "live_session_event" (
    "live_session_id",
    "session_question_id",
    "visibility",
    "delivery_state",
    "aggregate_version"
  );

CREATE INDEX "idx_live_session_event_target"
  ON "live_session_event" (
    "live_session_id",
    "target_participant_id",
    "event_seq"
  );
