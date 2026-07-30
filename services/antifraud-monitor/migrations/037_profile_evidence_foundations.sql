-- Additive Antifraud-owned v2 profile/evidence foundation.
-- Existing cases, events, assessments, provider checks, blacklists, locks, KYC,
-- and audit rows remain untouched and compatible throughout the transition.

ALTER TABLE signup_assessments
  ADD COLUMN IF NOT EXISTS legacy_score integer,
  ADD COLUMN IF NOT EXISTS raw_score integer,
  ADD COLUMN IF NOT EXISTS assessment_version text NOT NULL DEFAULT 'legacy-v1',
  ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS completeness text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS confidence integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS policy_matches jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS explanation jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE signup_assessments
SET legacy_score = COALESCE(legacy_score, score),
    raw_score = COALESCE(raw_score, score)
WHERE legacy_score IS NULL OR raw_score IS NULL;

CREATE TABLE IF NOT EXISTS profile_assessment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES subjects(user_id) ON DELETE CASCADE,
  assessment_version text NOT NULL,
  source_ref text NOT NULL,
  raw_score integer NOT NULL,
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  outcome text NOT NULL CHECK (outcome IN ('clear','monitor','review_required','incomplete','unknown')),
  completeness text NOT NULL CHECK (completeness IN ('complete','partial','unknown')),
  confidence integer NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  provider_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_matches jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommended_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  monitor_duration_seconds integer NOT NULL DEFAULT 0
    CHECK (monitor_duration_seconds BETWEEN 0 AND 3600),
  explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
  assessed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, assessment_version, source_ref)
);

CREATE INDEX IF NOT EXISTS profile_assessment_history_user_time_idx
  ON profile_assessment_history(user_id, assessed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS profile_assessment_history_queue_idx
  ON profile_assessment_history(outcome, score DESC, assessed_at DESC);

CREATE TABLE IF NOT EXISTS antifraud_profiles (
  user_id text PRIMARY KEY REFERENCES subjects(user_id) ON DELETE CASCADE,
  current_assessment_id uuid REFERENCES profile_assessment_history(id) ON DELETE SET NULL,
  assessment_version text NOT NULL,
  raw_score integer NOT NULL,
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  outcome text NOT NULL CHECK (outcome IN ('clear','monitor','review_required','incomplete','unknown')),
  completeness text NOT NULL CHECK (completeness IN ('complete','partial','unknown')),
  confidence integer NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  provider_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_matches jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommended_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  monitor_duration_seconds integer NOT NULL DEFAULT 0
    CHECK (monitor_duration_seconds BETWEEN 0 AND 3600),
  explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
  assessed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS antifraud_profiles_queue_idx
  ON antifraud_profiles(outcome, score DESC, assessed_at DESC);

CREATE TABLE IF NOT EXISTS signup_identity_snapshots (
  user_id text PRIMARY KEY REFERENCES subjects(user_id) ON DELETE CASCADE,
  snapshot_version text NOT NULL DEFAULT 'signup-identity-v1',
  source_created_at timestamptz NOT NULL,
  earliest_auth_provider text,
  auth_provider_timeline jsonb NOT NULL DEFAULT '[]'::jsonb,
  signup_ip inet,
  ipv6_subnet_64 cidr,
  ipv6_subnet_56 cidr,
  ipv6_subnet_48 cidr,
  fingerprint_request_id text,
  fingerprint_visitor_id text,
  fingerprint_confidence numeric(6,5),
  affiliate_code text,
  referred_by text,
  country_code text,
  is_creator boolean NOT NULL DEFAULT false,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signup_identity_snapshot_ip_idx
  ON signup_identity_snapshots(signup_ip, source_created_at DESC)
  WHERE signup_ip IS NOT NULL;
CREATE INDEX IF NOT EXISTS signup_identity_snapshot_ipv6_64_idx
  ON signup_identity_snapshots(ipv6_subnet_64, source_created_at DESC)
  WHERE ipv6_subnet_64 IS NOT NULL;
CREATE INDEX IF NOT EXISTS signup_identity_snapshot_fingerprint_idx
  ON signup_identity_snapshots(fingerprint_visitor_id, source_created_at DESC)
  WHERE fingerprint_visitor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS signup_identity_snapshot_affiliate_time_idx
  ON signup_identity_snapshots(affiliate_code, source_created_at DESC)
  WHERE affiliate_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS profile_assessment_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES profile_assessment_history(id) ON DELETE CASCADE,
  signal_key text NOT NULL,
  category text NOT NULL CHECK (category IN (
    'identity','network','behavior','funding','relationship','provider','account'
  )),
  title text NOT NULL,
  detail text NOT NULL,
  raw_points integer NOT NULL,
  effective_points integer NOT NULL,
  hard_policy text,
  evidence_only boolean NOT NULL DEFAULT false,
  suppressed_reason text,
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(assessment_id, signal_key)
);

CREATE INDEX IF NOT EXISTS profile_assessment_signals_key_time_idx
  ON profile_assessment_signals(signal_key, observed_at DESC);
CREATE INDEX IF NOT EXISTS profile_assessment_signals_assessment_idx
  ON profile_assessment_signals(assessment_id, effective_points DESC);

CREATE TABLE IF NOT EXISTS profile_provider_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES subjects(user_id) ON DELETE CASCADE,
  provider text NOT NULL,
  lookup_key text NOT NULL,
  evidence_key text NOT NULL,
  request_id text,
  outcome text NOT NULL CHECK (outcome IN ('success','failed','skipped','not_applicable','unknown')),
  failure_kind text CHECK (failure_kind IN (
    'timeout','rate_limited','authentication','invalid_response','upstream','unknown'
  )),
  raw_evidence jsonb,
  normalized_signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_score numeric(8,2),
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider, evidence_key)
);

CREATE INDEX IF NOT EXISTS profile_provider_evidence_lookup_idx
  ON profile_provider_evidence(provider, lookup_key, observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS profile_provider_evidence_user_time_idx
  ON profile_provider_evidence(user_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS profile_provider_evidence_failures_idx
  ON profile_provider_evidence(outcome, observed_at DESC)
  WHERE outcome <> 'success';

CREATE TABLE IF NOT EXISTS account_relationship_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id text NOT NULL REFERENCES subjects(user_id) ON DELETE CASCADE,
  related_user_id text,
  relationship_type text NOT NULL CHECK (relationship_type IN (
    'shared_ipv4','shared_ipv4_subnet','shared_ipv6_subnet','shared_device',
    'affiliate','country_cluster','session_hop','fund_transfer','creator_sponsorship'
  )),
  relationship_key_hash text NOT NULL,
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_ref text NOT NULL,
  UNIQUE(subject_user_id, relationship_type, source_ref)
);

CREATE INDEX IF NOT EXISTS account_relationship_subject_time_idx
  ON account_relationship_evidence(subject_user_id, last_observed_at DESC);
CREATE INDEX IF NOT EXISTS account_relationship_hash_idx
  ON account_relationship_evidence(relationship_type, relationship_key_hash, last_observed_at DESC);
CREATE INDEX IF NOT EXISTS account_relationship_related_idx
  ON account_relationship_evidence(related_user_id, last_observed_at DESC)
  WHERE related_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS funding_trace_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id text NOT NULL REFERENCES subjects(user_id) ON DELETE CASCADE,
  source_user_id text,
  destination_user_id text NOT NULL,
  source_type text NOT NULL,
  source_ref text NOT NULL,
  amount_usd numeric(20,2),
  restricted_source boolean NOT NULL DEFAULT false,
  restriction_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  depth integer NOT NULL CHECK (depth BETWEEN 0 AND 6),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subject_user_id, source_type, source_ref, depth)
);

CREATE INDEX IF NOT EXISTS funding_trace_subject_time_idx
  ON funding_trace_edges(subject_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS funding_trace_restricted_idx
  ON funding_trace_edges(subject_user_id, occurred_at DESC)
  WHERE restricted_source = true;
CREATE INDEX IF NOT EXISTS funding_trace_source_time_idx
  ON funding_trace_edges(source_user_id, occurred_at DESC)
  WHERE source_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS antifraud_backfill_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream text NOT NULL,
  version text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','running','completed','failed','rolled_back')),
  cursor_occurred_at timestamptz,
  cursor_source_id text,
  source_count bigint NOT NULL DEFAULT 0,
  inserted_count bigint NOT NULL DEFAULT 0,
  updated_count bigint NOT NULL DEFAULT 0,
  duplicate_count bigint NOT NULL DEFAULT 0,
  parity_ok boolean,
  pre_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  post_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(stream, version)
);

CREATE INDEX IF NOT EXISTS antifraud_backfill_pending_idx
  ON antifraud_backfill_runs(status, updated_at)
  WHERE status IN ('pending','running','failed');

CREATE TABLE IF NOT EXISTS fiat_eligibility_gate_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('dev','prod')),
  user_id text NOT NULL,
  fingerprint_request_id text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  decision text NOT NULL CHECK (decision = 'deny'),
  reason_code text NOT NULL CHECK (reason_code = 'fiat_globally_disabled'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fiat_eligibility_gate_user_time_idx
  ON fiat_eligibility_gate_events(environment, user_id, created_at DESC);

-- Compatibility backfill. Provider coverage is deliberately unknown unless a
-- historical provider_checks row exists; absence is never interpreted clean.
INSERT INTO profile_assessment_history (
  user_id, assessment_version, source_ref, raw_score, score, severity,
  outcome, completeness, confidence, provider_status, policy_matches,
  recommended_actions, monitor_duration_seconds, explanation, assessed_at
)
SELECT
  sa.user_id,
  'legacy-v1',
  'legacy:signup_assessment',
  COALESCE(sa.raw_score, sa.score),
  LEAST(100, GREATEST(0, sa.score)),
  CASE
    WHEN sa.score >= 100 THEN 'critical'
    WHEN sa.score >= 80 THEN 'high'
    WHEN sa.score >= 40 THEN 'medium'
    ELSE 'low'
  END,
  'unknown',
  'unknown',
  0,
  jsonb_build_object('legacy', jsonb_build_object(
    'provider', 'legacy',
    'outcome', 'unknown',
    'required', true
  )),
  '[]'::jsonb,
  '[]'::jsonb,
  0,
  jsonb_build_object(
    'legacyScore', sa.score,
    'note', 'Legacy score preserved; historical provider absence is unknown.'
  ),
  sa.assessed_at
FROM signup_assessments sa
ON CONFLICT (user_id, assessment_version, source_ref) DO NOTHING;

INSERT INTO antifraud_profiles (
  user_id, current_assessment_id, assessment_version, raw_score, score,
  severity, outcome, completeness, confidence, provider_status,
  policy_matches, recommended_actions, monitor_duration_seconds,
  explanation, assessed_at
)
SELECT
  history.user_id, history.id, history.assessment_version, history.raw_score,
  history.score, history.severity, history.outcome, history.completeness,
  history.confidence, history.provider_status, history.policy_matches,
  '[]'::jsonb, 0, history.explanation, history.assessed_at
FROM profile_assessment_history history
WHERE history.assessment_version = 'legacy-v1'
  AND history.source_ref = 'legacy:signup_assessment'
ON CONFLICT (user_id) DO NOTHING;

-- Existing Antifraud subjects become immutable legacy signup snapshots without
-- inventing auth-provider or Fingerprint history that was never captured.
INSERT INTO signup_identity_snapshots (
  user_id, snapshot_version, source_created_at, earliest_auth_provider,
  auth_provider_timeline, signup_ip, affiliate_code, referred_by, country_code,
  is_creator, captured_at
)
SELECT
  subject.user_id,
  'legacy-subject-v1',
  subject.source_created_at,
  NULL,
  '[]'::jsonb,
  CASE
    WHEN pg_input_is_valid(subject.signup_ip, 'inet')
      THEN subject.signup_ip::inet
    ELSE NULL
  END,
  subject.affiliate_code,
  subject.referred_by,
  subject.country_code,
  false,
  subject.first_seen_at
FROM subjects subject
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO profile_assessment_signals (
  assessment_id, signal_key, category, title, detail, raw_points,
  effective_points, observed_at, payload
)
SELECT
  history.id,
  COALESCE(signal->>'key', 'legacy_unknown_' || ordinal::text),
  'behavior',
  COALESCE(signal->>'title', 'Legacy signal'),
  COALESCE(signal->>'detail', 'Historical signal detail unavailable.'),
  CASE WHEN (signal->>'points') ~ '^-?[0-9]+$' THEN (signal->>'points')::integer ELSE 0 END,
  CASE WHEN (signal->>'points') ~ '^-?[0-9]+$' THEN (signal->>'points')::integer ELSE 0 END,
  history.assessed_at,
  COALESCE(signal->'payload', '{}'::jsonb)
FROM signup_assessments sa
JOIN profile_assessment_history history
  ON history.user_id = sa.user_id
 AND history.assessment_version = 'legacy-v1'
 AND history.source_ref = 'legacy:signup_assessment'
CROSS JOIN LATERAL jsonb_array_elements(sa.signals) WITH ORDINALITY AS item(signal, ordinal)
ON CONFLICT (assessment_id, signal_key) DO NOTHING;

INSERT INTO profile_provider_evidence (
  user_id, provider, lookup_key, evidence_key, request_id, outcome, failure_kind,
  raw_evidence, normalized_signals, provider_score, observed_at
)
SELECT
  pc.user_id,
  pc.provider,
  pc.lookup_key,
  'legacy-provider-check:' || pc.id::text,
  pc.request_id,
  CASE
    WHEN pc.status = 'success' THEN 'success'
    WHEN pc.status = 'failed' THEN 'failed'
    ELSE 'unknown'
  END,
  CASE WHEN pc.status = 'failed' THEN 'unknown' ELSE NULL END,
  pc.response,
  pc.signals,
  pc.score,
  pc.checked_at
FROM provider_checks pc
ON CONFLICT (user_id, provider, evidence_key) DO NOTHING;

-- Reuse already-derived withdrawal provenance. This is intentionally bounded
-- to the repository's 365-day operational history window and to the first 200
-- allocated credits per withdrawal. Original withdrawal assessments remain the
-- authoritative compatibility record.
--
-- Older withdrawal assessments can predate signup-subject retention. Preserve
-- those assessments by creating the minimum truthful subject shell before the
-- funding-edge foreign key is enforced; identity fields remain unknown.
INSERT INTO subjects (user_id, source_created_at, first_seen_at, updated_at)
SELECT
  assessment.user_id,
  MIN(assessment.requested_at),
  MIN(assessment.requested_at),
  MAX(assessment.requested_at)
FROM withdrawal_assessments assessment
WHERE assessment.requested_at >= now() - interval '365 days'
  AND assessment.user_id IS NOT NULL
GROUP BY assessment.user_id
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO funding_trace_edges (
  subject_user_id, source_user_id, destination_user_id, source_type,
  source_ref, amount_usd, restricted_source, restriction_evidence, depth,
  occurred_at
)
SELECT
  assessment.user_id,
  NULLIF(entry->>'counterpartyUserId', ''),
  assessment.user_id,
  COALESCE(NULLIF(entry->>'type', ''), 'legacy_unknown'),
  assessment.withdrawal_id::text || ':' || COALESCE(entry->>'id', ordinal::text),
  CASE
    WHEN (entry->>'allocatedUsd') ~ '^[0-9]+([.][0-9]+)?$'
      THEN (entry->>'allocatedUsd')::numeric(20,2)
    ELSE NULL
  END,
  COALESCE(NULLIF(entry->>'counterpartyReason', ''), '') <> '',
  CASE
    WHEN COALESCE(NULLIF(entry->>'counterpartyReason', ''), '') <> ''
      THEN jsonb_build_object(
        'legacyReason', entry->>'counterpartyReason',
        'withdrawalId', assessment.withdrawal_id
      )
    ELSE '{}'::jsonb
  END,
  1,
  COALESCE(
    CASE
      WHEN (entry->>'occurredAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
        THEN (entry->>'occurredAt')::timestamptz
      ELSE NULL
    END,
    assessment.requested_at
  )
FROM withdrawal_assessments assessment
CROSS JOIN LATERAL (
  SELECT item.entry, item.ordinal
  FROM jsonb_array_elements(
    COALESCE(assessment.flow->'fundingTrace'->'entries', '[]'::jsonb)
  ) WITH ORDINALITY AS item(entry, ordinal)
  WHERE item.ordinal <= 200
) bounded
WHERE assessment.requested_at >= now() - interval '365 days'
  AND NULLIF(entry->>'counterpartyUserId', '') IS NOT NULL
ON CONFLICT (subject_user_id, source_type, source_ref, depth) DO NOTHING;

INSERT INTO antifraud_backfill_runs (
  stream, version, status, source_count, inserted_count, duplicate_count,
  parity_ok, pre_counts, post_counts, started_at, completed_at
)
SELECT
  'legacy-profile-compatibility',
  '037',
  'completed',
  (SELECT COUNT(*) FROM signup_assessments),
  (SELECT COUNT(*) FROM profile_assessment_history WHERE assessment_version='legacy-v1'),
  (
    SELECT COUNT(*) - COUNT(DISTINCT (user_id, assessment_version, source_ref))
    FROM profile_assessment_history
    WHERE assessment_version='legacy-v1'
  ),
  (
    SELECT COUNT(*) FROM signup_assessments
  ) = (
    SELECT COUNT(*) FROM profile_assessment_history
    WHERE assessment_version='legacy-v1'
      AND source_ref='legacy:signup_assessment'
  ),
  jsonb_build_object(
    'subjects', (SELECT COUNT(*) FROM subjects),
    'signupAssessments', (SELECT COUNT(*) FROM signup_assessments),
    'providerChecks', (SELECT COUNT(*) FROM provider_checks),
    'cases', (SELECT COUNT(*) FROM cases),
    'riskEvents', (SELECT COUNT(*) FROM risk_events)
  ),
  jsonb_build_object(
    'profiles', (SELECT COUNT(*) FROM antifraud_profiles),
    'assessmentHistory', (SELECT COUNT(*) FROM profile_assessment_history),
    'providerEvidence', (SELECT COUNT(*) FROM profile_provider_evidence),
    'normalizedSignals', (SELECT COUNT(*) FROM profile_assessment_signals)
  ),
  now(),
  now()
ON CONFLICT (stream, version) DO UPDATE SET
  status = EXCLUDED.status,
  source_count = EXCLUDED.source_count,
  inserted_count = EXCLUDED.inserted_count,
  duplicate_count = EXCLUDED.duplicate_count,
  parity_ok = EXCLUDED.parity_ok,
  pre_counts = EXCLUDED.pre_counts,
  post_counts = EXCLUDED.post_counts,
  completed_at = EXCLUDED.completed_at,
  updated_at = now();
