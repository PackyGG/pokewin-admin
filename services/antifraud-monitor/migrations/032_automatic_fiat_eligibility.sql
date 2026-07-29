CREATE TABLE IF NOT EXISTS fiat_eligibility_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('dev', 'prod')),
  user_id text NOT NULL,
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  request_created_at timestamptz NOT NULL,
  request_ip inet NOT NULL,
  fingerprint_request_id text NOT NULL UNIQUE,
  signup_ip text,
  signup_visitor_id text,
  checkout_visitor_id text,
  account_age_days numeric(12,4),
  fingerprint_status text NOT NULL
    CHECK (fingerprint_status IN ('success', 'skipped', 'failed')),
  proxycheck_status text NOT NULL
    CHECK (proxycheck_status IN ('success', 'skipped', 'failed')),
  risk_score smallint NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  decision text NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason_codes text[] NOT NULL DEFAULT '{}'::text[],
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fiat_eligibility_user_created_idx
  ON fiat_eligibility_assessments (
    environment,
    user_id,
    created_at DESC
  );

CREATE INDEX IF NOT EXISTS fiat_eligibility_decision_created_idx
  ON fiat_eligibility_assessments (
    environment,
    decision,
    created_at DESC
  );

CREATE INDEX IF NOT EXISTS fiat_eligibility_ip_created_idx
  ON fiat_eligibility_assessments (
    environment,
    request_ip,
    created_at DESC
  );
