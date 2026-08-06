CREATE TABLE IF NOT EXISTS fiat_refunded_amount_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  currency text NOT NULL,
  requested_amount_cents integer NOT NULL CHECK (requested_amount_cents > 0),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  total_payment_count integer NOT NULL CHECK (total_payment_count > 0),
  refunded_payment_count integer NOT NULL CHECK (refunded_payment_count > 0),
  account_count integer NOT NULL CHECK (account_count > 0),
  payment_count integer NOT NULL CHECK (payment_count > 0),
  refund_ratio numeric(8,6) NOT NULL CHECK (
    refund_ratio >= 0 AND refund_ratio <= 1
  ),
  reason text NOT NULL,
  source_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(source_event_ids) = 'array'
  ),
  active_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (currency, requested_amount_cents),
  CHECK (window_end >= window_start)
);

CREATE INDEX IF NOT EXISTS fiat_refunded_amount_clusters_active_idx
  ON fiat_refunded_amount_clusters(active_until DESC)
  WHERE active_until > 'epoch'::timestamptz;

INSERT INTO source_cursors(stream, occurred_at, source_id)
VALUES ('fiat_refunded_amount_clusters_v1', now() - interval '30 days', '')
ON CONFLICT (stream) DO NOTHING;
