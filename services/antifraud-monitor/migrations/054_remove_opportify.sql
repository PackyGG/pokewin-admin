-- Remove all active and persisted Opportify integration state after the
-- application release that stopped outbound calls. Historical migration names
-- remain immutable, but provider evidence and derived scoring are purged.

CREATE TEMP TABLE retired_provider_user_contribution ON COMMIT DROP AS
SELECT
  assessment.user_id,
  COALESCE(SUM(
    CASE
      WHEN (signal->>'effectivePoints') ~ '^-?[0-9]+$'
        THEN (signal->>'effectivePoints')::integer
      WHEN (signal->>'points') ~ '^-?[0-9]+$'
        THEN (signal->>'points')::integer
      ELSE 0
    END
  ), 0)::integer AS effective_points,
  COALESCE(SUM(
    CASE
      WHEN (signal->>'points') ~ '^-?[0-9]+$'
        THEN (signal->>'points')::integer
      ELSE 0
    END
  ), 0)::integer AS raw_points
FROM signup_assessments assessment
CROSS JOIN LATERAL jsonb_array_elements(assessment.signals) signal
WHERE signal->>'key' LIKE 'opportify_%'
GROUP BY assessment.user_id;

WITH cleaned AS (
  SELECT
    assessment.user_id,
    GREATEST(0, assessment.score - contribution.effective_points) AS score,
    GREATEST(
      0,
      COALESCE(assessment.raw_score, assessment.score) - contribution.raw_points
    ) AS raw_score,
    COALESCE((
      SELECT jsonb_agg(signal ORDER BY ordinal)
      FROM jsonb_array_elements(assessment.signals)
        WITH ORDINALITY AS item(signal, ordinal)
      WHERE signal->>'key' NOT LIKE 'opportify_%'
    ), '[]'::jsonb) AS signals,
    assessment.provider_status - 'opportify' AS provider_status,
    assessment.policy_matches,
    jsonb_set(
      jsonb_set(
        jsonb_set(
          assessment.explanation,
          '{categoryTotals,provider}',
          to_jsonb(GREATEST(
            0,
            CASE
              WHEN assessment.explanation #>> '{categoryTotals,provider}'
                ~ '^-?[0-9]+$'
                THEN (assessment.explanation #>> '{categoryTotals,provider}')::integer
              ELSE 0
            END - contribution.effective_points
          )),
          true
        ),
        '{positivePoints}',
        to_jsonb(GREATEST(
          0,
          CASE
            WHEN assessment.explanation->>'positivePoints' ~ '^-?[0-9]+$'
              THEN (assessment.explanation->>'positivePoints')::integer
            ELSE assessment.score
          END - contribution.effective_points
        )),
        true
      ),
      '{notes}',
      COALESCE((
        SELECT jsonb_agg(note ORDER BY ordinal)
        FROM jsonb_array_elements(
          COALESCE(assessment.explanation->'notes', '[]'::jsonb)
        ) WITH ORDINALITY AS item(note, ordinal)
        WHERE note #>> '{}' NOT ILIKE '%opportify%'
      ), '[]'::jsonb),
      true
    ) AS explanation
  FROM signup_assessments assessment
  JOIN retired_provider_user_contribution contribution
    ON contribution.user_id = assessment.user_id
), coverage AS (
  SELECT
    cleaned.*,
    provider_counts.required_count,
    provider_counts.successful_required,
    provider_counts.failed_required,
    provider_counts.unknown_required
  FROM cleaned
  CROSS JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (
        WHERE COALESCE((provider.value->>'required')::boolean, false)
      )::integer AS required_count,
      COUNT(*) FILTER (
        WHERE COALESCE((provider.value->>'required')::boolean, false)
          AND provider.value->>'outcome' = 'success'
          AND COALESCE(provider.value->>'completeness', 'complete')
            NOT IN ('partial', 'unknown')
      )::integer AS successful_required,
      COUNT(*) FILTER (
        WHERE COALESCE((provider.value->>'required')::boolean, false)
          AND provider.value->>'outcome' = 'failed'
      )::integer AS failed_required,
      COUNT(*) FILTER (
        WHERE COALESCE((provider.value->>'required')::boolean, false)
          AND (
            provider.value->>'outcome' IN ('unknown', 'skipped')
            OR provider.value->>'completeness' IN ('partial', 'unknown')
          )
      )::integer AS unknown_required
    FROM jsonb_each(cleaned.provider_status) provider
  ) provider_counts
)
UPDATE signup_assessments assessment
SET
  score = coverage.score,
  raw_score = coverage.raw_score,
  severity = CASE
    WHEN coverage.score >= 70 THEN 'critical'
    WHEN coverage.score >= 50 THEN 'high'
    WHEN coverage.score >= 21 THEN 'medium'
    ELSE 'low'
  END,
  signals = coverage.signals,
  provider_status = coverage.provider_status,
  completeness = CASE
    WHEN coverage.failed_required > 0 THEN 'partial'
    WHEN coverage.unknown_required > 0 THEN 'unknown'
    ELSE 'complete'
  END,
  confidence = CASE
    WHEN coverage.required_count = 0 THEN 0
    ELSE ROUND(
      coverage.successful_required::numeric / coverage.required_count * 100
    )::integer
  END,
  outcome = CASE
    WHEN coverage.failed_required > 0 OR coverage.unknown_required > 0
      THEN 'incomplete'
    WHEN jsonb_array_length(coverage.policy_matches) > 0 OR coverage.score >= 50
      THEN 'review_required'
    WHEN coverage.score >= 21 THEN 'monitor'
    ELSE 'clear'
  END,
  explanation = coverage.explanation
FROM coverage
WHERE assessment.user_id = coverage.user_id;

CREATE TEMP TABLE retired_provider_assessment_contribution ON COMMIT DROP AS
SELECT
  signal.assessment_id,
  COALESCE(SUM(signal.effective_points), 0)::integer AS effective_points,
  COALESCE(SUM(signal.raw_points), 0)::integer AS raw_points
FROM profile_assessment_signals signal
WHERE signal.signal_key LIKE 'opportify_%'
GROUP BY signal.assessment_id;

WITH adjusted AS (
  SELECT
    history.id,
    GREATEST(0, history.score - contribution.effective_points) AS score,
    GREATEST(0, history.raw_score - contribution.raw_points) AS raw_score,
    history.provider_status - 'opportify' AS provider_status,
    history.policy_matches,
    jsonb_set(
      jsonb_set(
        jsonb_set(
          history.explanation,
          '{categoryTotals,provider}',
          to_jsonb(GREATEST(
            0,
            CASE
              WHEN history.explanation #>> '{categoryTotals,provider}'
                ~ '^-?[0-9]+$'
                THEN (history.explanation #>> '{categoryTotals,provider}')::integer
              ELSE 0
            END - contribution.effective_points
          )),
          true
        ),
        '{positivePoints}',
        to_jsonb(GREATEST(
          0,
          CASE
            WHEN history.explanation->>'positivePoints' ~ '^-?[0-9]+$'
              THEN (history.explanation->>'positivePoints')::integer
            ELSE history.score
          END - contribution.effective_points
        )),
        true
      ),
      '{notes}',
      COALESCE((
        SELECT jsonb_agg(note ORDER BY ordinal)
        FROM jsonb_array_elements(
          COALESCE(history.explanation->'notes', '[]'::jsonb)
        ) WITH ORDINALITY AS item(note, ordinal)
        WHERE note #>> '{}' NOT ILIKE '%opportify%'
      ), '[]'::jsonb),
      true
    ) AS explanation
  FROM profile_assessment_history history
  JOIN retired_provider_assessment_contribution contribution
    ON contribution.assessment_id = history.id
), coverage AS (
  SELECT
    adjusted.*,
    provider_counts.required_count,
    provider_counts.successful_required,
    provider_counts.failed_required,
    provider_counts.unknown_required,
    jsonb_array_length(adjusted.policy_matches) > 0 AS has_policy,
    adjusted.policy_matches ?| ARRAY[
      'blocklist.ip',
      'blocklist.fingerprint',
      'cluster.fingerprint_third_account',
      'cluster.exact_ip_third_account',
      'promotion.third_redemption',
      'network.tor',
      'device.confirmed_vm',
      'fingerprint.replayed',
      'fingerprint.identity_mismatch',
      'fingerprint.automation',
      'funds.restricted_downstream_active_use'
    ] AS priority_policy,
    adjusted.policy_matches ?| ARRAY[
      'email.catchall',
      'blocklist.email_domain'
    ] AS deterministic_ban
  FROM adjusted
  CROSS JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (
        WHERE COALESCE((provider.value->>'required')::boolean, false)
      )::integer AS required_count,
      COUNT(*) FILTER (
        WHERE COALESCE((provider.value->>'required')::boolean, false)
          AND provider.value->>'outcome' = 'success'
          AND COALESCE(provider.value->>'completeness', 'complete')
            NOT IN ('partial', 'unknown')
      )::integer AS successful_required,
      COUNT(*) FILTER (
        WHERE COALESCE((provider.value->>'required')::boolean, false)
          AND provider.value->>'outcome' = 'failed'
      )::integer AS failed_required,
      COUNT(*) FILTER (
        WHERE COALESCE((provider.value->>'required')::boolean, false)
          AND (
            provider.value->>'outcome' IN ('unknown', 'skipped')
            OR provider.value->>'completeness' IN ('partial', 'unknown')
          )
      )::integer AS unknown_required
    FROM jsonb_each(adjusted.provider_status) provider
  ) provider_counts
), rebuilt AS (
  SELECT
    coverage.*,
    COALESCE((
      SELECT jsonb_agg(action ORDER BY sort_order)
      FROM (
        SELECT 'monitor' AS action, 10 AS sort_order
        WHERE coverage.score >= 21
        UNION ALL
        SELECT 'notify_standard', 20
        WHERE coverage.score >= 50
          AND NOT (coverage.score >= 70 OR coverage.priority_policy OR coverage.deterministic_ban)
        UNION ALL
        SELECT 'notify_priority', 30
        WHERE coverage.score >= 70 OR coverage.priority_policy OR coverage.deterministic_ban
        UNION ALL
        SELECT 'review', 40
        WHERE coverage.score >= 50 OR coverage.priority_policy OR coverage.deterministic_ban
        UNION ALL
        SELECT 'lock_withdrawals', 50
        WHERE coverage.score >= 70 OR coverage.priority_policy OR coverage.deterministic_ban
        UNION ALL
        SELECT 'ban', 60
        WHERE coverage.deterministic_ban
        UNION ALL
        SELECT 'block_domain', 70
        WHERE coverage.policy_matches ? 'email.catchall'
        UNION ALL
        SELECT 'block_ip', 80
        WHERE coverage.policy_matches ? 'email.catchall'
        UNION ALL
        SELECT 'block_fingerprint', 90
        WHERE coverage.policy_matches ? 'email.catchall'
      ) actions
    ), '[]'::jsonb) AS recommended_actions
  FROM coverage
)
UPDATE profile_assessment_history history
SET
  raw_score = rebuilt.raw_score,
  score = rebuilt.score,
  severity = CASE
    WHEN rebuilt.score >= 70 THEN 'critical'
    WHEN rebuilt.score >= 50 THEN 'high'
    WHEN rebuilt.score >= 21 THEN 'medium'
    ELSE 'low'
  END,
  outcome = CASE
    WHEN rebuilt.failed_required > 0 OR rebuilt.unknown_required > 0
      THEN 'incomplete'
    WHEN rebuilt.has_policy OR rebuilt.score >= 50 THEN 'review_required'
    WHEN rebuilt.score >= 21 THEN 'monitor'
    ELSE 'clear'
  END,
  completeness = CASE
    WHEN rebuilt.failed_required > 0 THEN 'partial'
    WHEN rebuilt.unknown_required > 0 THEN 'unknown'
    ELSE 'complete'
  END,
  confidence = CASE
    WHEN rebuilt.required_count = 0 THEN 0
    ELSE ROUND(
      rebuilt.successful_required::numeric / rebuilt.required_count * 100
    )::integer
  END,
  provider_status = rebuilt.provider_status,
  recommended_actions = rebuilt.recommended_actions,
  monitor_duration_seconds = CASE
    WHEN rebuilt.score >= 70 OR rebuilt.priority_policy OR rebuilt.deterministic_ban
      THEN 900
    WHEN rebuilt.score >= 50 THEN 600
    WHEN rebuilt.score >= 21 THEN 300
    ELSE 0
  END,
  explanation = rebuilt.explanation
FROM rebuilt
WHERE history.id = rebuilt.id;

DELETE FROM profile_assessment_signals
WHERE signal_key LIKE 'opportify_%';

UPDATE antifraud_profiles profile
SET
  assessment_version = history.assessment_version,
  raw_score = history.raw_score,
  score = history.score,
  severity = history.severity,
  outcome = history.outcome,
  completeness = history.completeness,
  confidence = history.confidence,
  provider_status = history.provider_status,
  policy_matches = history.policy_matches,
  recommended_actions = history.recommended_actions,
  monitor_duration_seconds = history.monitor_duration_seconds,
  explanation = history.explanation,
  assessed_at = history.assessed_at,
  updated_at = now()
FROM profile_assessment_history history
WHERE profile.current_assessment_id = history.id;

WITH cleaned AS (
  SELECT
    outbox.user_id,
    COALESCE((
      SELECT jsonb_agg(signal ORDER BY ordinal)
      FROM jsonb_array_elements(outbox.signals)
        WITH ORDINALITY AS item(signal, ordinal)
      WHERE signal->>'key' NOT LIKE 'opportify_%'
    ), '[]'::jsonb) AS signals
  FROM signup_alert_outbox outbox
  WHERE outbox.signals::text ILIKE '%opportify%'
), rescored AS (
  SELECT
    cleaned.*,
    COALESCE((
      SELECT SUM(
        CASE
          WHEN signal->>'points' ~ '^-?[0-9]+$'
            THEN (signal->>'points')::integer
          ELSE 0
        END
      )
      FROM jsonb_array_elements(cleaned.signals) signal
    ), 0)::integer AS score
  FROM cleaned
)
UPDATE signup_alert_outbox outbox
SET
  score = rescored.score,
  signals = rescored.signals,
  last_error = CASE
    WHEN outbox.last_error ILIKE '%opportify%' THEN NULL
    ELSE outbox.last_error
  END,
  updated_at = now()
FROM rescored
WHERE outbox.user_id = rescored.user_id
  AND rescored.score >= 21;

DELETE FROM signup_alert_outbox outbox
USING retired_provider_user_contribution contribution
WHERE outbox.user_id = contribution.user_id
  AND (
    SELECT COALESCE(SUM(
      CASE
        WHEN signal->>'points' ~ '^-?[0-9]+$'
          THEN (signal->>'points')::integer
        ELSE 0
      END
    ), 0)
    FROM jsonb_array_elements(outbox.signals) signal
    WHERE signal->>'key' NOT LIKE 'opportify_%'
  ) < 21;

UPDATE monitor_sessions session
SET
  initial_score = GREATEST(0, session.initial_score - contribution.effective_points),
  current_score = GREATEST(0, session.current_score - contribution.effective_points),
  peak_score = GREATEST(0, session.peak_score - contribution.effective_points)
FROM retired_provider_user_contribution contribution
WHERE session.user_id = contribution.user_id;

UPDATE cases review_case
SET
  score = GREATEST(0, review_case.score - contribution.effective_points),
  peak_score = GREATEST(0, review_case.peak_score - contribution.effective_points),
  severity = CASE
    WHEN GREATEST(0, review_case.score - contribution.effective_points) >= 70
      THEN 'critical'
    WHEN GREATEST(0, review_case.score - contribution.effective_points) >= 50
      THEN 'high'
    WHEN GREATEST(0, review_case.score - contribution.effective_points) >= 21
      THEN 'medium'
    ELSE 'low'
  END,
  summary = CASE
    WHEN review_case.summary ILIKE '%opportify%'
      THEN 'Automated signup risk assessment'
    ELSE review_case.summary
  END,
  updated_at = now()
FROM retired_provider_user_contribution contribution
WHERE review_case.user_id = contribution.user_id;

UPDATE risk_events event
SET score_after = GREATEST(0, event.score_after - contribution.effective_points)
FROM retired_provider_user_contribution contribution
WHERE event.user_id = contribution.user_id;

DELETE FROM risk_events
WHERE event_type LIKE 'opportify_%'
   OR source_ref LIKE '%:opportify_%';

UPDATE risk_events event
SET payload = jsonb_set(
  event.payload,
  '{signals}',
  COALESCE((
    SELECT jsonb_agg(signal ORDER BY ordinal)
    FROM jsonb_array_elements(event.payload->'signals')
      WITH ORDINALITY AS item(signal, ordinal)
    WHERE signal->>'key' NOT LIKE 'opportify_%'
  ), '[]'::jsonb),
  true
)
WHERE jsonb_typeof(event.payload->'signals') = 'array'
  AND (event.payload->'signals')::text ILIKE '%opportify%';

UPDATE signup_ingestion_failures
SET error_text = 'Retired provider failure; ready for retry.'
WHERE error_text ILIKE '%opportify%';

UPDATE fiat_eligibility_assessments assessment
SET
  reason_codes = ARRAY(
    SELECT reason_code
    FROM unnest(assessment.reason_codes) reason_code
    WHERE reason_code NOT LIKE 'opportify_%'
  ),
  signals = COALESCE((
    SELECT jsonb_agg(signal ORDER BY ordinal)
    FROM jsonb_array_elements(assessment.signals)
      WITH ORDINALITY AS item(signal, ordinal)
    WHERE signal->>'key' NOT LIKE 'opportify_%'
  ), '[]'::jsonb),
  provider_evidence = jsonb_set(
    jsonb_set(
      assessment.provider_evidence,
      '{providers}',
      COALESCE(assessment.provider_evidence->'providers', '{}'::jsonb)
        - 'opportify',
      true
    ),
    '{providerSignals}',
    COALESCE((
      SELECT jsonb_agg(signal ORDER BY ordinal)
      FROM jsonb_array_elements(
        COALESCE(assessment.provider_evidence->'providerSignals', '[]'::jsonb)
      ) WITH ORDINALITY AS item(signal, ordinal)
      WHERE signal->>'provider' <> 'opportify'
        AND signal->>'key' NOT LIKE 'opportify_%'
    ), '[]'::jsonb),
    true
  )
WHERE assessment.signals::text ILIKE '%opportify%'
   OR assessment.provider_evidence::text ILIKE '%opportify%'
   OR EXISTS (
     SELECT 1
     FROM unnest(assessment.reason_codes) reason_code
     WHERE reason_code LIKE 'opportify_%'
   );

DELETE FROM profile_provider_evidence WHERE provider = 'opportify';
DELETE FROM provider_checks WHERE provider = 'opportify';
DELETE FROM fiat_perk_candidate_provider_evidence WHERE provider = 'opportify';
DELETE FROM score_weights WHERE key LIKE 'opportify_%';

ALTER TABLE provider_checks
  DROP CONSTRAINT IF EXISTS provider_checks_provider_check;
ALTER TABLE provider_checks
  ADD CONSTRAINT provider_checks_provider_check
  CHECK (provider IN (
    'fingerprint',
    'proxycheck',
    'abstract_ip',
    'abstract_email',
    'maxmind'
  ));

ALTER TABLE fiat_perk_candidate_provider_evidence
  DROP CONSTRAINT IF EXISTS fiat_perk_candidate_provider_evidence_provider_check;
ALTER TABLE fiat_perk_candidate_provider_evidence
  ADD CONSTRAINT fiat_perk_candidate_provider_evidence_provider_check
  CHECK (provider IN (
    'fingerprint',
    'proxycheck',
    'abstract_ip',
    'abstract_email',
    'maxmind'
  ));

ALTER TABLE fiat_eligibility_assessments
  DROP CONSTRAINT IF EXISTS fiat_eligibility_opportify_status_check;
ALTER TABLE fiat_eligibility_assessments
  DROP COLUMN IF EXISTS opportify_status;
