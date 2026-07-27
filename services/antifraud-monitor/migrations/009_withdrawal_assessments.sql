CREATE TABLE IF NOT EXISTS withdrawal_assessments (
  withdrawal_id uuid PRIMARY KEY,
  user_id text NOT NULL,
  username text,
  email text,
  avatar_url text,
  method text NOT NULL,
  status text NOT NULL,
  amount_usd numeric(20,2) NOT NULL,
  asset_count integer NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  risk_score integer NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  verdict text NOT NULL CHECK (verdict IN ('good', 'review', 'bad')),
  summary text NOT NULL,
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  flow jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  assessed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS withdrawal_assessments_requested_idx
  ON withdrawal_assessments (requested_at DESC, withdrawal_id DESC);

CREATE INDEX IF NOT EXISTS withdrawal_assessments_verdict_requested_idx
  ON withdrawal_assessments (verdict, requested_at DESC);

CREATE INDEX IF NOT EXISTS withdrawal_assessments_status_requested_idx
  ON withdrawal_assessments (status, requested_at DESC);

CREATE INDEX IF NOT EXISTS withdrawal_assessments_user_requested_idx
  ON withdrawal_assessments (user_id, requested_at DESC);
