-- Score validity belongs in the database; alert thresholds belong in policy.
-- Migration 043 established the public 0-100 score model but did not include
-- this delivery outbox. Repair its older snapshots before applying the same
-- invariant; clamping preserves their alert band while making validation safe.
UPDATE signup_alert_outbox
SET score = LEAST(100, GREATEST(0, score))
WHERE score NOT BETWEEN 0 AND 100;

-- Add and validate the policy-independent bound before removing the old floor
-- so there is never a window without score validation.
ALTER TABLE signup_alert_outbox
  ADD CONSTRAINT signup_alert_outbox_score_bounds_check
  CHECK (score BETWEEN 0 AND 100) NOT VALID;

ALTER TABLE signup_alert_outbox
  VALIDATE CONSTRAINT signup_alert_outbox_score_bounds_check;

ALTER TABLE signup_alert_outbox
  DROP CONSTRAINT IF EXISTS signup_alert_outbox_score_check;

-- Migration 053 fixed the constraint, but affected rows had already exhausted
-- their normal retry budget. Requeue only unresolved failures caused by that
-- exact contract mismatch; unrelated failures retain their attempt history.
UPDATE signup_ingestion_failures
SET failure_count = 0,
    last_failed_at = to_timestamp(0)
WHERE resolved_at IS NULL
  AND error_text LIKE '%signup_alert_outbox_score_check%';
