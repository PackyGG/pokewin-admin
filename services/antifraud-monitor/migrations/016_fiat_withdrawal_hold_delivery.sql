INSERT INTO source_cursors(stream, occurred_at, source_id)
VALUES ('fiat-withdrawal-holds', now() - interval '10 minutes', '')
ON CONFLICT (stream) DO NOTHING;

CREATE TABLE IF NOT EXISTS fiat_withdrawal_hold_alert_outbox (
  source_ref text PRIMARY KEY,
  user_id text NOT NULL REFERENCES subjects(user_id) ON DELETE CASCADE,
  username text,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL,
  discord_delivered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fiat_withdrawal_hold_alert_outbox_pending_idx
  ON fiat_withdrawal_hold_alert_outbox (next_attempt_at, created_at)
  WHERE discord_delivered_at IS NULL;
