-- One durable, filterable record for every provider used by a Fiat screening.
-- Provider responses are already sanitized by EnrichmentService before they
-- reach this table; lookup keys and request identifiers are deliberately not
-- stored here.

CREATE TABLE IF NOT EXISTS fiat_perk_candidate_provider_evidence (
  candidate_id uuid NOT NULL
    REFERENCES fiat_perk_candidates(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN (
    'fingerprint',
    'proxycheck',
    'abstract_ip',
    'abstract_email',
    'opportify',
    'maxmind'
  )),
  status text NOT NULL CHECK (status IN ('success', 'skipped', 'failed')),
  completeness text NOT NULL CHECK (completeness IN ('complete', 'partial', 'unknown')),
  score numeric,
  native_score numeric,
  native_rank text,
  native_confidence numeric,
  provider_model text NOT NULL,
  provider_version text NOT NULL,
  source text NOT NULL CHECK (source IN ('live', 'cache', 'input')),
  failure_kind text,
  error_code text,
  signal_keys text[] NOT NULL DEFAULT ARRAY[]::text[],
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (candidate_id, provider)
);

CREATE INDEX IF NOT EXISTS fiat_perk_provider_filter_idx
  ON fiat_perk_candidate_provider_evidence
  (provider, status, completeness, score, candidate_id);

CREATE INDEX IF NOT EXISTS fiat_perk_provider_signal_keys_idx
  ON fiat_perk_candidate_provider_evidence USING gin (signal_keys);
