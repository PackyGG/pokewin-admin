-- Fiat perks v2: MaxMind screening evidence and durable upstream access jobs.
--
-- The backend per-user Fiat flag is the authoritative switch. A local grant is
-- only considered live after that backend confirms the requested value. These
-- tables make single and bulk changes recoverable after timeouts or deploys.

ALTER TABLE fiat_perk_candidates
  ADD COLUMN IF NOT EXISTS maxmind_status text NOT NULL DEFAULT 'not_checked',
  ADD COLUMN IF NOT EXISTS maxmind_risk_score numeric(6,2),
  ADD COLUMN IF NOT EXISTS maxmind_ip_risk numeric(6,2),
  ADD COLUMN IF NOT EXISTS maxmind_disposition text,
  ADD COLUMN IF NOT EXISTS maxmind_reason_codes text[] NOT NULL DEFAULT ARRAY[]::text[];

DO $$ BEGIN
  ALTER TABLE fiat_perk_candidates
    ADD CONSTRAINT fiat_perk_candidates_maxmind_status_check
    CHECK (maxmind_status IN ('success', 'failed', 'skipped', 'not_checked'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE fiat_perk_candidates
    ADD CONSTRAINT fiat_perk_candidates_maxmind_risk_check
    CHECK (maxmind_risk_score IS NULL OR maxmind_risk_score BETWEEN 0 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE fiat_perk_candidates
    ADD CONSTRAINT fiat_perk_candidates_maxmind_ip_risk_check
    CHECK (maxmind_ip_risk IS NULL OR maxmind_ip_risk BETWEEN 0 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS fiat_perk_candidates_maxmind_filter_idx
  ON fiat_perk_candidates (run_id, maxmind_status, maxmind_risk_score);

ALTER TABLE fiat_perk_grants
  ADD COLUMN IF NOT EXISTS access_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS access_error_code text,
  ADD COLUMN IF NOT EXISTS access_confirmed_at timestamptz;

DO $$ BEGIN
  ALTER TABLE fiat_perk_grants
    ADD CONSTRAINT fiat_perk_grants_access_status_check
    CHECK (access_status IN ('unknown', 'syncing', 'enabled', 'disabled', 'error'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS fiat_perk_access_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL CHECK (action IN ('enable', 'disable')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  requested_count integer NOT NULL CHECK (requested_count BETWEEN 1 AND 100),
  succeeded_count integer NOT NULL DEFAULT 0 CHECK (succeeded_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  note text,
  filter_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by text NOT NULL,
  requested_by_username text,
  idempotency_key uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS fiat_perk_access_batches_recent_idx
  ON fiat_perk_access_batches (created_at DESC);

CREATE TABLE IF NOT EXISTS fiat_perk_access_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES fiat_perk_access_batches(id) ON DELETE CASCADE,
  candidate_id uuid REFERENCES fiat_perk_candidates(id) ON DELETE SET NULL,
  user_id text NOT NULL,
  desired_enabled boolean NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'applying', 'succeeded', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code text,
  confirmed_enabled boolean,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, user_id)
);

CREATE INDEX IF NOT EXISTS fiat_perk_access_operations_work_idx
  ON fiat_perk_access_operations (batch_id, status, created_at);
CREATE INDEX IF NOT EXISTS fiat_perk_access_operations_user_idx
  ON fiat_perk_access_operations (user_id, created_at DESC);
