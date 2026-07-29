ALTER TABLE signup_ingestion_failures
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by text,
  ADD COLUMN IF NOT EXISTS resolution_note text;

CREATE INDEX IF NOT EXISTS signup_ingestion_failures_pending_idx
  ON signup_ingestion_failures(last_failed_at, user_id)
  WHERE resolved_at IS NULL;
