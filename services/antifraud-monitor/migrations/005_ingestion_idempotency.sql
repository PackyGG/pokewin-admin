ALTER TABLE service_audit_events
  ADD COLUMN IF NOT EXISTS request_state jsonb;

CREATE TABLE IF NOT EXISTS signup_ingestion_failures (
  user_id text PRIMARY KEY,
  source_created_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  error_text text NOT NULL,
  failure_count integer NOT NULL DEFAULT 1,
  first_failed_at timestamptz NOT NULL DEFAULT now(),
  last_failed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signup_ingestion_failures_time_idx
  ON signup_ingestion_failures(last_failed_at DESC);
