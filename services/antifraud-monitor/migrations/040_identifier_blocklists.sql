-- Operator-managed IP and Fingerprint blocklists.
-- Additive only: existing profile, provider, domain, case, and audit history
-- remains authoritative. Historical identifier matches are review-only.

CREATE TABLE IF NOT EXISTS identifier_blocklists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('ip','fingerprint')),
  ip_network cidr,
  fingerprint_id text,
  match_mode text NOT NULL CHECK (match_mode IN ('exact','cidr')),
  reason text NOT NULL,
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','automatic','legacy')),
  enabled boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_by text NOT NULL,
  created_by_username text,
  updated_by text NOT NULL,
  updated_by_username text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'ip' AND ip_network IS NOT NULL AND fingerprint_id IS NULL)
    OR
    (kind = 'fingerprint' AND ip_network IS NULL
      AND fingerprint_id IS NOT NULL AND length(fingerprint_id) BETWEEN 4 AND 255)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS identifier_blocklists_ip_unique
  ON identifier_blocklists(ip_network)
  WHERE kind = 'ip';
CREATE UNIQUE INDEX IF NOT EXISTS identifier_blocklists_fingerprint_unique
  ON identifier_blocklists(fingerprint_id)
  WHERE kind = 'fingerprint';
CREATE INDEX IF NOT EXISTS identifier_blocklists_active_ip_idx
  ON identifier_blocklists(ip_network)
  WHERE kind = 'ip' AND enabled;
CREATE INDEX IF NOT EXISTS identifier_blocklists_active_fingerprint_idx
  ON identifier_blocklists(fingerprint_id)
  WHERE kind = 'fingerprint' AND enabled;
CREATE INDEX IF NOT EXISTS identifier_blocklists_expiry_idx
  ON identifier_blocklists(expires_at)
  WHERE enabled AND expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS identifier_blocklist_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocklist_id uuid NOT NULL REFERENCES identifier_blocklists(id)
    ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES subjects(user_id) ON DELETE CASCADE,
  source_ref text NOT NULL,
  match_context text NOT NULL CHECK (
    match_context IN ('historical_backfill','signup','profile_link','manual_review')
  ),
  resulting_action text NOT NULL DEFAULT 'review_only' CHECK (
    resulting_action IN ('review_only','lock_review','locked','no_action','unknown')
  ),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  matched_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(blocklist_id, user_id, source_ref)
);

CREATE INDEX IF NOT EXISTS identifier_blocklist_matches_rule_time_idx
  ON identifier_blocklist_matches(blocklist_id, matched_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS identifier_blocklist_matches_user_time_idx
  ON identifier_blocklist_matches(user_id, matched_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS identifier_blocklist_matches_action_time_idx
  ON identifier_blocklist_matches(resulting_action, matched_at DESC);

CREATE TABLE IF NOT EXISTS identifier_blocklist_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocklist_id uuid NOT NULL REFERENCES identifier_blocklists(id)
    ON DELETE RESTRICT,
  action text NOT NULL CHECK (
    action IN ('created','updated','disabled','reactivated','expired')
  ),
  actor_id text NOT NULL,
  actor_username text,
  reason text NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE,
  before_state jsonb,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS identifier_blocklist_audit_rule_time_idx
  ON identifier_blocklist_audit(blocklist_id, created_at DESC);

CREATE INDEX IF NOT EXISTS antifraud_profiles_score_time_idx
  ON antifraud_profiles(score DESC, assessed_at DESC, user_id);
CREATE INDEX IF NOT EXISTS subjects_username_prefix_idx
  ON subjects(lower(username) text_pattern_ops)
  WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS subjects_email_prefix_idx
  ON subjects(lower(email) text_pattern_ops)
  WHERE email IS NOT NULL;

ALTER TABLE risky_locations
  ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT
    'Legacy risky-location rule; original reason unavailable.',
  ADD COLUMN IF NOT EXISTS risk_weight integer NOT NULL DEFAULT 20
    CHECK (risk_weight BETWEEN 0 AND 49),
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS risky_locations_expiry_idx
  ON risky_locations(expires_at)
  WHERE enabled AND expires_at IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_risky_location_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'risky_location_audit is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS risky_location_audit_no_update ON risky_location_audit;
CREATE TRIGGER risky_location_audit_no_update
  BEFORE UPDATE OR DELETE ON risky_location_audit
  FOR EACH ROW EXECUTE FUNCTION reject_risky_location_audit_mutation();

DROP TRIGGER IF EXISTS risky_location_audit_no_truncate ON risky_location_audit;
CREATE TRIGGER risky_location_audit_no_truncate
  BEFORE TRUNCATE ON risky_location_audit
  FOR EACH STATEMENT EXECUTE FUNCTION reject_risky_location_audit_mutation();

CREATE OR REPLACE FUNCTION reject_identifier_blocklist_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'identifier_blocklist_audit is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS identifier_blocklist_audit_no_update
  ON identifier_blocklist_audit;
CREATE TRIGGER identifier_blocklist_audit_no_update
  BEFORE UPDATE OR DELETE ON identifier_blocklist_audit
  FOR EACH ROW EXECUTE FUNCTION reject_identifier_blocklist_audit_mutation();

DROP TRIGGER IF EXISTS identifier_blocklist_audit_no_truncate
  ON identifier_blocklist_audit;
CREATE TRIGGER identifier_blocklist_audit_no_truncate
  BEFORE TRUNCATE ON identifier_blocklist_audit
  FOR EACH STATEMENT EXECUTE FUNCTION reject_identifier_blocklist_audit_mutation();

INSERT INTO antifraud_backfill_runs (
  stream, version, status, source_count, inserted_count, duplicate_count,
  parity_ok, pre_counts, post_counts, started_at, completed_at
) VALUES (
  'identifier-blocklists',
  '039',
  'completed',
  0,
  0,
  0,
  true,
  jsonb_build_object('existingIdentifierRules', 0),
  jsonb_build_object(
    'ipRules', (SELECT count(*) FROM identifier_blocklists WHERE kind='ip'),
    'fingerprintRules',
      (SELECT count(*) FROM identifier_blocklists WHERE kind='fingerprint')
  ),
  now(),
  now()
)
ON CONFLICT (stream, version) DO UPDATE SET
  status = EXCLUDED.status,
  parity_ok = EXCLUDED.parity_ok,
  post_counts = EXCLUDED.post_counts,
  completed_at = EXCLUDED.completed_at,
  updated_at = now();
