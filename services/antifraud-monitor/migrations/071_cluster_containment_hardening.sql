-- Keep review-only post-Fiat outcomes durable, repair the rollout gap that
-- skipped them, and soften the second-account device signal to review-only.

ALTER TABLE fiat_deposit_identity_checks
  DROP CONSTRAINT IF EXISTS fiat_deposit_identity_checks_verdict_check;

ALTER TABLE fiat_deposit_identity_checks
  ADD CONSTRAINT fiat_deposit_identity_checks_verdict_check
  CHECK (verdict IN ('clear', 'watch', 'review', 'contain'));

-- Global cross-account comparisons must stay index probes as these histories
-- grow; neither checkout IP nor checkout device had a supporting index.
CREATE INDEX IF NOT EXISTS fiat_identity_checkout_ip_occurred_idx
  ON fiat_deposit_identity_checks (checkout_ip, occurred_at DESC)
  INCLUDE (user_id)
  WHERE checkout_ip IS NOT NULL;

CREATE INDEX IF NOT EXISTS fiat_identity_checkout_device_occurred_idx
  ON fiat_deposit_identity_checks (checkout_visitor_id, occurred_at DESC)
  INCLUDE (user_id)
  WHERE checkout_visitor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS fiat_eligibility_environment_created_idx
  ON fiat_eligibility_assessments (environment, created_at DESC);

CREATE INDEX IF NOT EXISTS fiat_eligibility_device_created_idx
  ON fiat_eligibility_assessments (
    environment,
    checkout_visitor_id,
    created_at DESC
  )
  INCLUDE (user_id)
  WHERE checkout_visitor_id IS NOT NULL;

-- Preserve deliberate staff tuning: only move the value when it is still the
-- old shipped default. The third exact fingerprint account remains a hard
-- score-100 containment policy independently of this editable weight.
UPDATE score_weights
SET
  points = 50,
  updated_by = 'migration:071_cluster_containment_hardening',
  updated_at = now()
WHERE key = 'shared_device_two_accounts'
  AND points = 70;

-- Repair cluster members that the broken promotion path had already labelled
-- as contained. Their original risk event is explicitly review-only, so a
-- second source namespace is required to create a new dashboard idempotency
-- key and execute the real lock.
INSERT INTO risk_events (
  case_id, session_id, user_id, event_type, source, source_ref,
  score_delta, score_after, title, detail, payload, occurred_at
)
SELECT
  review.case_id,
  review.session_id,
  review.user_id,
  'fiat_blacklisted_email_domain',
  'whop_checkout_cluster',
  review.source_ref,
  0,
  100,
  'Suspicious Whop deposit cluster member',
  'Whop checkout belongs to a corroborated same-amount cluster with distinct accounts and payment identities. Crypto and item withdrawals must be locked automatically.',
  review.payload || jsonb_build_object(
    'emailRiskType', 'suspicious_deposit_cluster',
    'emailRiskReason', 'Recovered corroborated same-amount deposit cluster',
    'reviewOnly', false
  ),
  review.occurred_at
FROM fiat_email_domain_matches AS match
JOIN risk_events AS review
  ON review.source = 'whop_checkout'
  AND review.source_ref =
    'blacklisted-checkout:' || match.source_event_id
WHERE match.match_type = 'suspicious_deposit_cluster'
  AND review.payload ->> 'reviewOnly' = 'true'
ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING;

UPDATE fiat_email_domain_matches AS match
SET
  lock_delivered_at = NULL,
  attempt_count = 0,
  next_attempt_at = now(),
  last_error = NULL,
  updated_at = now()
WHERE match.match_type = 'suspicious_deposit_cluster'
  AND EXISTS (
    SELECT 1
    FROM risk_events AS containment
    WHERE containment.source = 'whop_checkout_cluster'
      AND containment.source_ref =
        'blacklisted-checkout:' || match.source_event_id
      AND containment.dashboard_delivered_at IS NULL
  );

-- The broken build advanced the cursor after the constraint rejected review
-- rows. Rewind only when a durable failure alert proves this exact failure;
-- already-stored checks are idempotent, so replaying the intervening deposits
-- is safe. Successful replay removes an undelivered failure alert in code.
WITH earliest_constraint_failure AS (
  SELECT MIN(occurred_at) AS occurred_at
  FROM fiat_problem_alert_outbox
  WHERE problem_code = 'fiat_identity_drift'
    AND source_kind = 'deposit_intent'
    AND source_id LIKE '%:fiat_identity_error'
    AND details ->> 'failure_reason'
      LIKE '%fiat_deposit_identity_checks_verdict_check%'
)
UPDATE source_cursors AS cursor
SET
  occurred_at = LEAST(
    cursor.occurred_at,
    failure.occurred_at - interval '1 millisecond'
  ),
  source_id = '',
  updated_at = now()
FROM earliest_constraint_failure AS failure
WHERE cursor.stream = 'fiat-deposit-identity'
  AND failure.occurred_at IS NOT NULL
  AND cursor.occurred_at >= failure.occurred_at;
