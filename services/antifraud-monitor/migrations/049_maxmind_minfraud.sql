CREATE TABLE IF NOT EXISTS maxmind_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE,
  user_id text NOT NULL,
  event_type text NOT NULL,
  transaction_id text NOT NULL UNIQUE,
  minfraud_id uuid UNIQUE,
  status text NOT NULL CHECK (status IN ('success','failed')),
  risk_score numeric(6,2),
  ip_risk numeric(6,2),
  disposition text,
  response jsonb,
  normalized_signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code text,
  occurred_at timestamptz NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maxmind_evaluations_risk_range
    CHECK (risk_score IS NULL OR risk_score BETWEEN 0 AND 100)
);
CREATE INDEX IF NOT EXISTS maxmind_evaluations_user_checked_idx
  ON maxmind_evaluations(user_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS maxmind_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  minfraud_id uuid NOT NULL,
  user_id text,
  old_risk_score numeric(6,2),
  new_risk_score numeric(6,2),
  reason_code text,
  reason text,
  payload jsonb NOT NULL,
  provider_updated_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (minfraud_id, new_risk_score, reason_code, provider_updated_at)
);
CREATE INDEX IF NOT EXISTS maxmind_alerts_user_received_idx
  ON maxmind_alerts(user_id, received_at DESC);

CREATE TABLE IF NOT EXISTS maxmind_report_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  minfraud_id uuid NOT NULL,
  user_id text NOT NULL,
  tag text NOT NULL CHECK (tag IN (
    'not_fraud','suspected_fraud','spam_or_abuse','chargeback','clear'
  )),
  source_ref text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (minfraud_id, tag, source_ref)
);
CREATE INDEX IF NOT EXISTS maxmind_report_outbox_pending_idx
  ON maxmind_report_outbox(next_attempt_at, created_at)
  WHERE delivered_at IS NULL;

ALTER TABLE provider_checks DROP CONSTRAINT IF EXISTS provider_checks_provider_check;
ALTER TABLE provider_checks ADD CONSTRAINT provider_checks_provider_check
  CHECK (provider IN (
    'fingerprint','proxycheck','abstract_ip','abstract_email','opportify','maxmind'
  ));
