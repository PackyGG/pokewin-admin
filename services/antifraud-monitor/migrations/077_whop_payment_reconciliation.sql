CREATE TABLE IF NOT EXISTS whop_payment_snapshots (
  payment_id text PRIMARY KEY CHECK (payment_id ~ '^pay_[A-Za-z0-9]+$'),
  user_id text,
  deposit_intent_id text,
  status text,
  substatus text,
  provider_risk_score numeric,
  risk_signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_created_at timestamptz,
  provider_updated_at timestamptz,
  first_synced_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(risk_signals) = 'array')
);

CREATE INDEX IF NOT EXISTS whop_payment_snapshots_user_updated_idx
  ON whop_payment_snapshots(user_id, provider_updated_at DESC)
  WHERE user_id IS NOT NULL;

INSERT INTO source_cursors(stream, occurred_at, source_id)
VALUES ('whop-payment-reconciliation', now() - interval '48 hours', '')
ON CONFLICT (stream) DO NOTHING;
