CREATE TABLE IF NOT EXISTS fiat_problem_alert_outbox (
  source_kind text NOT NULL CHECK (
    source_kind IN ('deposit_intent', 'payment_webhook')
  ),
  source_id text NOT NULL,
  problem_code text NOT NULL,
  user_id text,
  username text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  discord_delivered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_kind, source_id)
);

CREATE INDEX IF NOT EXISTS fiat_problem_alert_outbox_pending_idx
  ON fiat_problem_alert_outbox (next_attempt_at, occurred_at)
  WHERE discord_delivered_at IS NULL;
