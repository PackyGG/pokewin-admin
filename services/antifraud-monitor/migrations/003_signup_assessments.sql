ALTER TABLE subjects
  ADD COLUMN IF NOT EXISTS avatar_url text;

CREATE INDEX IF NOT EXISTS subjects_signup_time_idx
  ON subjects(source_created_at DESC, user_id DESC);

CREATE TABLE IF NOT EXISTS signup_assessments (
  user_id text PRIMARY KEY REFERENCES subjects(user_id) ON DELETE CASCADE,
  score integer NOT NULL DEFAULT 0,
  severity text NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  assessed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signup_assessments_risk_idx
  ON signup_assessments(score DESC, assessed_at DESC);

CREATE INDEX IF NOT EXISTS cases_user_updated_idx
  ON cases(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS monitor_sessions_user_started_idx
  ON monitor_sessions(user_id, started_at DESC)
  INCLUDE (status, ends_at);
