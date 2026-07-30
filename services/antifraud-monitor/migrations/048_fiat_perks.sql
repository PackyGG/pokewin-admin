-- Fiat perks: the allowlist that decides WHICH accounts may reach a Fiat
-- checkout at all.
--
-- The live `/v1/fiat-eligibility/check` endpoint answers "is this checkout, on
-- this device, from this IP, safe right now". It cannot answer "is this account
-- one we want on cards in the first place" — that is a slower, evidence-heavy,
-- human-confirmed judgement. These tables hold it:
--
--   fiat_perk_runs        one operator-triggered screening sweep over a scope
--   fiat_perk_candidates  one screened account inside a run, with its evidence
--   fiat_perk_grants      the durable per-account verdict the checkout reads
--   fiat_perk_audit       every decision, keyed for idempotent retries
--
-- Nothing here writes to MAIN. A grant is enforced by the eligibility endpoint,
-- so revoking access is one row change and takes effect on the next checkout.

CREATE TABLE IF NOT EXISTS fiat_perk_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  scope_label text NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  requested_by text NOT NULL,
  requested_by_username text,
  idempotency_key uuid NOT NULL UNIQUE,
  scanned_count integer NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  candidate_count integer NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  pass_count integer NOT NULL DEFAULT 0 CHECK (pass_count >= 0),
  review_count integer NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  fail_count integer NOT NULL DEFAULT 0 CHECK (fail_count >= 0),
  provider_checks integer NOT NULL DEFAULT 0 CHECK (provider_checks >= 0),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS fiat_perk_runs_recent_idx
  ON fiat_perk_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS fiat_perk_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES fiat_perk_runs(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  username text,
  email text,
  avatar_url text,
  country_code text,
  account_age_days numeric(12, 2) NOT NULL DEFAULT 0,
  verdict text NOT NULL CHECK (verdict IN ('pass', 'review', 'fail')),
  risk_score integer NOT NULL DEFAULT 0
    CHECK (risk_score BETWEEN 0 AND 100),
  blocking_reasons text[] NOT NULL DEFAULT ARRAY[]::text[],
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_checked boolean NOT NULL DEFAULT false,
  decision text NOT NULL DEFAULT 'pending'
    CHECK (decision IN ('pending', 'approved', 'declined')),
  decided_by text,
  decided_by_username text,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, user_id)
);

-- The review queue reads one run ordered by verdict then score; the second
-- index answers "has this account been screened before" on the user page.
CREATE INDEX IF NOT EXISTS fiat_perk_candidates_queue_idx
  ON fiat_perk_candidates (run_id, decision, verdict, risk_score);
CREATE INDEX IF NOT EXISTS fiat_perk_candidates_user_idx
  ON fiat_perk_candidates (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fiat_perk_grants (
  user_id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('granted', 'revoked')),
  candidate_id uuid REFERENCES fiat_perk_candidates(id) ON DELETE SET NULL,
  run_id uuid REFERENCES fiat_perk_runs(id) ON DELETE SET NULL,
  username text,
  risk_score integer CHECK (risk_score BETWEEN 0 AND 100),
  granted_by text,
  granted_by_username text,
  granted_at timestamptz,
  granted_note text,
  revoked_by text,
  revoked_by_username text,
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The checkout only ever asks for live grants, so keep that slice cheap.
CREATE INDEX IF NOT EXISTS fiat_perk_grants_active_idx
  ON fiat_perk_grants (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS fiat_perk_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid REFERENCES fiat_perk_candidates(id) ON DELETE SET NULL,
  user_id text NOT NULL,
  action text NOT NULL
    CHECK (action IN ('approved', 'declined', 'revoked', 'reinstated')),
  actor_id text NOT NULL,
  actor_username text,
  note text,
  idempotency_key uuid NOT NULL UNIQUE,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fiat_perk_audit_user_idx
  ON fiat_perk_audit (user_id, created_at DESC);
