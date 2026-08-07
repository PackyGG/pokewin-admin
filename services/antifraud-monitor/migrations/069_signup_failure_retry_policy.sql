ALTER TABLE signup_ingestion_failures
  ADD COLUMN failure_kind text,
  ADD COLUMN next_retry_at timestamptz;

-- Legacy rows predate typed failures. Text is used once, during migration, to
-- retain their safest known disposition; runtime retry decisions use only the
-- structured columns below.
UPDATE signup_ingestion_failures
SET failure_kind = CASE
      WHEN error_text = 'Stored signup payload is invalid' THEN 'invalid_payload'
      WHEN error_text LIKE 'Provider enrichment unavailable:%'
        THEN 'provider_transient'
      ELSE 'transient'
    END,
    next_retry_at = CASE
      WHEN error_text = 'Stored signup payload is invalid' THEN NULL
      WHEN error_text LIKE 'Provider enrichment unavailable:%'
           AND failure_count < 8 THEN now()
      WHEN error_text NOT LIKE 'Provider enrichment unavailable:%'
           AND failure_count < 5 THEN now()
      ELSE NULL
    END;

ALTER TABLE signup_ingestion_failures
  ALTER COLUMN failure_kind SET DEFAULT 'transient',
  ALTER COLUMN failure_kind SET NOT NULL,
  ADD CONSTRAINT signup_ingestion_failures_kind_check
    CHECK (failure_kind IN (
      'provider_transient',
      'provider_configuration',
      'transient',
      'invalid_payload'
    ));

DROP INDEX IF EXISTS signup_ingestion_failures_pending_idx;

CREATE INDEX signup_ingestion_failures_retry_idx
  ON signup_ingestion_failures(next_retry_at, user_id)
  WHERE resolved_at IS NULL AND next_retry_at IS NOT NULL;
