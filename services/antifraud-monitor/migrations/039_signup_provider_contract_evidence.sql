ALTER TABLE profile_provider_evidence
  ADD COLUMN IF NOT EXISTS completeness text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS provider_model text,
  ADD COLUMN IF NOT EXISTS provider_version text,
  ADD COLUMN IF NOT EXISTS native_score numeric(12,4),
  ADD COLUMN IF NOT EXISTS native_rank text,
  ADD COLUMN IF NOT EXISTS native_confidence numeric(12,4),
  ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS error_code text;

ALTER TABLE profile_provider_evidence
  DROP CONSTRAINT IF EXISTS profile_provider_evidence_completeness_check;
ALTER TABLE profile_provider_evidence
  ADD CONSTRAINT profile_provider_evidence_completeness_check
  CHECK (completeness IN ('complete','partial','unknown'));

ALTER TABLE profile_provider_evidence
  DROP CONSTRAINT IF EXISTS profile_provider_evidence_failure_kind_check;
ALTER TABLE profile_provider_evidence
  ADD CONSTRAINT profile_provider_evidence_failure_kind_check
  CHECK (failure_kind IN (
    'timeout','rate_limited','authentication','invalid_response','upstream',
    'missing_compatible_datum','unknown'
  ));

UPDATE profile_provider_evidence
SET
  completeness = CASE
    WHEN outcome = 'success' THEN 'complete'
    WHEN outcome IN ('failed','skipped','unknown') THEN 'unknown'
    ELSE 'partial'
  END,
  provider_model = CASE provider
    WHEN 'fingerprint' THEN 'Fingerprint Pro Plus'
    WHEN 'proxycheck' THEN 'ProxyCheck v3 Pro'
    WHEN 'abstract_ip' THEN 'Abstract IP Intelligence'
    WHEN 'abstract_email' THEN 'Abstract Email Reputation'
    WHEN 'opportify' THEN 'Opportify Full Fraud Check'
    ELSE provider
  END,
  provider_version = CASE provider
    WHEN 'fingerprint' THEN 'legacy-unknown'
    WHEN 'proxycheck' THEN 'legacy-unknown'
    WHEN 'abstract_ip' THEN 'v1'
    WHEN 'abstract_email' THEN 'v1'
    WHEN 'opportify' THEN 'intel-v1-fraud-analyze'
    ELSE 'legacy-unknown'
  END,
  native_score = provider_score,
  provenance = jsonb_build_object(
    'source', 'legacy_provider_checks_backfill',
    'independent', true
  )
WHERE provider_model IS NULL;

ALTER TABLE profile_provider_evidence
  ALTER COLUMN provider_model SET NOT NULL,
  ALTER COLUMN provider_version SET NOT NULL;

CREATE INDEX IF NOT EXISTS profile_provider_evidence_contract_idx
  ON profile_provider_evidence(provider, provider_version, outcome, observed_at DESC);
