CREATE TABLE app.email_outbox (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose            varchar(40) NOT NULL,
  related_id         uuid NOT NULL,
  encrypted_payload  text NOT NULL,
  encryption_nonce   varchar(24) NOT NULL,
  encryption_tag     varchar(24) NOT NULL,
  status             varchar(20) NOT NULL DEFAULT 'PENDING',
  attempts           integer NOT NULL DEFAULT 0,
  available_at       timestamptz NOT NULL DEFAULT statement_timestamp(),
  locked_until       timestamptz,
  claim_token        uuid,
  sent_at            timestamptz,
  last_error_code    varchar(80),
  created_at         timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT ck_email_outbox_status CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED')),
  CONSTRAINT ck_email_outbox_attempts CHECK (attempts >= 0)
);
CREATE INDEX ix_email_outbox_claim ON app.email_outbox (status, available_at);
CREATE INDEX ix_email_outbox_related_id ON app.email_outbox (related_id);
COMMENT ON TABLE app.email_outbox IS 'Durable encrypted email delivery queue; sensitive message payload is encrypted with RESET_OUTBOX_ENCRYPTION_KEY.';
COMMENT ON COLUMN app.email_outbox.related_id IS 'Related app.one_time_link id; intentionally not a foreign key so queue history survives link cleanup.';
