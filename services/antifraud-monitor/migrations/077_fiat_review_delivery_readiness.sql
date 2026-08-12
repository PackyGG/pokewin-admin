-- Review alerts are now resolved by completed risk/identity checks instead of
-- an elapsed-time guess. Keep a durable distinction between a message that was
-- sent and one deliberately suppressed by a stronger containment decision.
ALTER TABLE fiat_problem_alert_deliveries
  ADD COLUMN IF NOT EXISTS suppressed_at timestamptz,
  ADD COLUMN IF NOT EXISTS suppression_reason text;

ALTER TABLE fiat_problem_alert_deliveries
  DROP CONSTRAINT IF EXISTS fiat_problem_alert_delivery_suppression_check;

ALTER TABLE fiat_problem_alert_deliveries
  ADD CONSTRAINT fiat_problem_alert_delivery_suppression_check CHECK (
    (suppressed_at IS NULL AND suppression_reason IS NULL)
    OR (
      suppressed_at IS NOT NULL
      AND suppression_reason IS NOT NULL
      AND delivered_at IS NULL
    )
  );

DROP INDEX IF EXISTS fiat_problem_alert_deliveries_pending_idx;

CREATE INDEX fiat_problem_alert_deliveries_pending_idx
  ON fiat_problem_alert_deliveries (next_attempt_at, source_kind, source_id)
  WHERE delivered_at IS NULL AND suppressed_at IS NULL;

CREATE INDEX IF NOT EXISTS fiat_problem_alert_outbox_review_pending_idx
  ON fiat_problem_alert_outbox (occurred_at, source_id)
  WHERE problem_code = 'review' AND discord_delivered_at IS NULL;
