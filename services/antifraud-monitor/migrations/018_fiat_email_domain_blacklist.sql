CREATE TABLE IF NOT EXISTS fiat_email_domain_blacklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL,
  reason text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  backfill_received_at timestamptz NOT NULL DEFAULT 'epoch',
  backfill_source_id text NOT NULL DEFAULT '',
  backfill_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiat_email_domain_blacklist_normalized CHECK (
    domain = lower(domain)
    AND domain = btrim(domain)
    AND domain !~ '^@'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS fiat_email_domain_blacklist_domain_unique
  ON fiat_email_domain_blacklist (lower(domain));

CREATE INDEX IF NOT EXISTS fiat_email_domain_blacklist_active_idx
  ON fiat_email_domain_blacklist (enabled, domain)
  WHERE enabled;

CREATE TABLE IF NOT EXISTS fiat_email_domain_blacklist_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES fiat_email_domain_blacklist(id)
    ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('created', 'updated')),
  actor_id text NOT NULL,
  actor_username text,
  idempotency_key uuid NOT NULL UNIQUE,
  before_state jsonb,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fiat_email_domain_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_event_id text NOT NULL UNIQUE,
  provider_event_id text NOT NULL,
  deposit_intent_id text,
  provider_payment_id text,
  user_id text NOT NULL,
  username text,
  checkout_email text NOT NULL,
  domain text NOT NULL,
  occurred_at timestamptz NOT NULL,
  lock_delivered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fiat_email_domain_matches_pending_lock_idx
  ON fiat_email_domain_matches (next_attempt_at, occurred_at)
  WHERE lock_delivered_at IS NULL;

CREATE INDEX IF NOT EXISTS fiat_email_domain_matches_intent_idx
  ON fiat_email_domain_matches (deposit_intent_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS fiat_email_domain_matches_domain_idx
  ON fiat_email_domain_matches (domain, occurred_at DESC);
