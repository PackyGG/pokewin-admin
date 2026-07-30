-- Automatic Fiat checkout eligibility v2.
--
-- Additive: every existing assessment row stays valid and readable. New columns
-- record the corroborating provider statuses, the behaviour evidence the trust
-- leg used, and whether the assessment queued account containment.

ALTER TABLE fiat_eligibility_assessments
  ADD COLUMN IF NOT EXISTS abstract_ip_status text NOT NULL DEFAULT 'skipped',
  ADD COLUMN IF NOT EXISTS opportify_status text NOT NULL DEFAULT 'skipped',
  ADD COLUMN IF NOT EXISTS enforcement text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS enforcement_reasons text[] NOT NULL
    DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS behaviour_evidence jsonb NOT NULL
    DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fiat_eligibility_abstract_ip_status_check'
  ) THEN
    ALTER TABLE fiat_eligibility_assessments
      ADD CONSTRAINT fiat_eligibility_abstract_ip_status_check
      CHECK (abstract_ip_status IN ('success', 'skipped', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fiat_eligibility_opportify_status_check'
  ) THEN
    ALTER TABLE fiat_eligibility_assessments
      ADD CONSTRAINT fiat_eligibility_opportify_status_check
      CHECK (opportify_status IN ('success', 'skipped', 'failed'));
  END IF;

  -- 'contained'  = containment was queued for the dashboard.
  -- 'suppressed' = the policy demanded containment but the environment or the
  --                master switch withheld it. Kept distinct so an observe-only
  --                window is auditable after the fact.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fiat_eligibility_enforcement_check'
  ) THEN
    ALTER TABLE fiat_eligibility_assessments
      ADD CONSTRAINT fiat_eligibility_enforcement_check
      CHECK (enforcement IN ('none', 'contained', 'suppressed'));
  END IF;

  -- An enforced assessment can never be an allow.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fiat_eligibility_enforcement_denies_check'
  ) THEN
    ALTER TABLE fiat_eligibility_assessments
      ADD CONSTRAINT fiat_eligibility_enforcement_denies_check
      CHECK (enforcement = 'none' OR decision = 'deny');
  END IF;
END
$$;

-- Containment audit view for the workspace: the enforced denials, newest first.
CREATE INDEX IF NOT EXISTS fiat_eligibility_enforcement_created_idx
  ON fiat_eligibility_assessments (environment, enforcement, created_at DESC)
  WHERE enforcement <> 'none';

-- Checkout enforcement is a new match context for operator blocklist rules.
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'identifier_blocklist_matches'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%match_context%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE identifier_blocklist_matches DROP CONSTRAINT %I',
      constraint_name
    );
  END IF;

  ALTER TABLE identifier_blocklist_matches
    ADD CONSTRAINT identifier_blocklist_matches_match_context_check
    CHECK (match_context IN (
      'historical_backfill',
      'signup',
      'profile_link',
      'manual_review',
      'fiat_checkout'
    ));
END
$$;

-- Containment events are delivered ahead of the ordinary risk-event stream, so
-- the delivery loop needs to find undelivered ones without scanning.
CREATE INDEX IF NOT EXISTS risk_events_fiat_containment_pending_idx
  ON risk_events (recorded_at, id)
  WHERE event_type = 'fiat_eligibility_containment'
    AND dashboard_delivered_at IS NULL;
