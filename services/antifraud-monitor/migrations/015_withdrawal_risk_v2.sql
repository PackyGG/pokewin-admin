ALTER TABLE withdrawal_assessments
  ADD COLUMN IF NOT EXISTS model_version integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS withdrawal_assessments_model_requested_idx
  ON withdrawal_assessments (model_version, requested_at DESC);

CREATE INDEX IF NOT EXISTS withdrawal_assessments_model_verdict_requested_idx
  ON withdrawal_assessments (model_version, verdict, requested_at DESC);
