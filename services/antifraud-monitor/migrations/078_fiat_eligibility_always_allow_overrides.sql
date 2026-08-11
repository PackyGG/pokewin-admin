-- Explicit, staff-managed escape hatch for known-safe users whose checkouts
-- must bypass the automatic pre-Fiat decision engine. The override is scoped
-- by environment and every state change has its own immutable audit row.

CREATE TABLE IF NOT EXISTS fiat_eligibility_overrides (
  environment text NOT NULL CHECK (environment IN ('dev', 'prod')),
  user_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  reason text NOT NULL,
  created_by text NOT NULL,
  created_by_username text,
  updated_by text NOT NULL,
  updated_by_username text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, user_id)
);

CREATE TABLE IF NOT EXISTS fiat_eligibility_override_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('dev', 'prod')),
  user_id text NOT NULL,
  enabled boolean NOT NULL,
  reason text NOT NULL,
  actor_id text NOT NULL,
  actor_username text,
  idempotency_key uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fiat_eligibility_override_audit_user_time_idx
  ON fiat_eligibility_override_audit (environment, user_id, created_at DESC);

-- Gate events also hold the lightweight allow produced by an enabled override.
-- This keeps every bypass decision durable without pretending provider checks
-- ran or writing a synthetic full assessment row.
ALTER TABLE fiat_eligibility_gate_events
  DROP CONSTRAINT IF EXISTS fiat_eligibility_gate_events_decision_check,
  DROP CONSTRAINT IF EXISTS fiat_eligibility_gate_events_reason_code_check,
  DROP CONSTRAINT IF EXISTS fiat_eligibility_gate_events_decision_reason_check;

ALTER TABLE fiat_eligibility_gate_events
  ADD CONSTRAINT fiat_eligibility_gate_events_decision_check
    CHECK (decision IN ('allow', 'deny')),
  ADD CONSTRAINT fiat_eligibility_gate_events_reason_code_check
    CHECK (reason_code IN (
      'fiat_globally_disabled',
      'fiat_always_allow_override'
    )),
  ADD CONSTRAINT fiat_eligibility_gate_events_decision_reason_check
    CHECK (
      (decision = 'deny' AND reason_code = 'fiat_globally_disabled')
      OR
      (decision = 'allow' AND reason_code = 'fiat_always_allow_override')
    );
