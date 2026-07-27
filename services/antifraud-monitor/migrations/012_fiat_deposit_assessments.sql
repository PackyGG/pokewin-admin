CREATE TABLE IF NOT EXISTS fiat_deposit_assessments (
  deposit_intent_id uuid PRIMARY KEY,
  user_id text NOT NULL,
  username text,
  email text,
  avatar_url text,
  provider text NOT NULL,
  provider_payment_status text,
  status text NOT NULL,
  currency text NOT NULL,
  requested_amount_usd numeric(20,2) NOT NULL,
  credited_amount_usd numeric(20,2) NOT NULL,
  customer_total_usd numeric(20,2),
  provider_net_usd numeric(20,2),
  occurred_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  provider_risk_score integer,
  three_ds_verified boolean,
  risk_score smallint NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  verdict text NOT NULL CHECK (verdict IN ('good', 'review', 'bad')),
  recommendation text NOT NULL,
  summary text NOT NULL,
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  funding_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  behavior_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  account_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  score_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  flow_checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_status text NOT NULL DEFAULT 'unreviewed'
    CHECK (
      review_status IN (
        'unreviewed',
        'in_review',
        'cleared',
        'escalated',
        'hold_recommended'
      )
    ),
  review_decision text,
  reviewed_by text,
  reviewed_by_username text,
  review_note text,
  review_started_at timestamptz,
  reviewed_at timestamptz,
  score_version text NOT NULL DEFAULT 'fiat-v1',
  assessed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fiat_assessments_occurred_idx
  ON fiat_deposit_assessments (occurred_at DESC, deposit_intent_id DESC);

CREATE INDEX IF NOT EXISTS fiat_assessments_verdict_occurred_idx
  ON fiat_deposit_assessments (verdict, occurred_at DESC);

CREATE INDEX IF NOT EXISTS fiat_assessments_review_occurred_idx
  ON fiat_deposit_assessments (review_status, occurred_at DESC);

CREATE INDEX IF NOT EXISTS fiat_assessments_user_occurred_idx
  ON fiat_deposit_assessments (user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS fiat_deposit_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_intent_id uuid NOT NULL
    REFERENCES fiat_deposit_assessments(deposit_intent_id)
    ON DELETE CASCADE,
  action text NOT NULL
    CHECK (
      action IN ('start_review', 'clear', 'escalate', 'recommend_hold')
    ),
  actor_id text NOT NULL,
  actor_username text,
  note text,
  idempotency_key uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fiat_review_events_intent_created_idx
  ON fiat_deposit_review_events (deposit_intent_id, created_at DESC);
