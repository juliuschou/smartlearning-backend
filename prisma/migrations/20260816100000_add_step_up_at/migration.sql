-- Migration: add_step_up_at
-- Additive auth hardening: persist the last successful password step-up
-- timestamp on the PostgreSQL-backed WebSession. Raw password/token values
-- are never stored.

ALTER TABLE "web_session"
  ADD COLUMN "step_up_at" TIMESTAMPTZ;
