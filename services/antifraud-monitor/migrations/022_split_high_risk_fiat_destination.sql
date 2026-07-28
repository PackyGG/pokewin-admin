ALTER TABLE fiat_problem_alert_deliveries
  DROP CONSTRAINT IF EXISTS fiat_problem_alert_deliveries_destination_check;

ALTER TABLE fiat_problem_alert_deliveries
  ADD CONSTRAINT fiat_problem_alert_deliveries_destination_check CHECK (
    destination IN (
      'antifraud_risk',
      'fiat_operations',
      'high_risk_supplemental',
      'email_blacklist'
    )
  );

DELETE FROM fiat_problem_alert_deliveries AS delivery
USING fiat_problem_alert_outbox AS alert
WHERE delivery.source_kind = alert.source_kind
  AND delivery.source_id = alert.source_id
  AND delivery.destination = 'fiat_operations'
  AND alert.problem_code IN ('high_risk', 'fiat_locked_account');

INSERT INTO fiat_problem_alert_deliveries (
  source_kind,
  source_id,
  destination,
  delivered_at,
  attempt_count,
  next_attempt_at,
  last_error,
  created_at,
  updated_at
)
SELECT
  alert.source_kind,
  alert.source_id,
  'high_risk_supplemental',
  CASE
    WHEN alert.source_kind = 'deposit_intent'
      AND alert.source_id =
        'd67b5118-9926-47bd-b58c-9203a15620be:high_risk'
      THEN NULL
    ELSE now()
  END,
  0,
  CASE
    WHEN alert.source_kind = 'deposit_intent'
      AND alert.source_id =
        'd67b5118-9926-47bd-b58c-9203a15620be:high_risk'
      THEN now()
    ELSE 'infinity'::timestamptz
  END,
  NULL,
  alert.created_at,
  now()
FROM fiat_problem_alert_outbox AS alert
WHERE alert.problem_code = 'high_risk'
ON CONFLICT (source_kind, source_id, destination) DO NOTHING;

WITH delivery_state AS (
  SELECT
    alert.source_kind,
    alert.source_id,
    count(*) FILTER (WHERE delivery.delivered_at IS NULL) AS pending_count,
    COALESCE(sum(delivery.attempt_count), 0)::integer AS attempt_count,
    min(delivery.next_attempt_at) FILTER (
      WHERE delivery.delivered_at IS NULL
    ) AS next_attempt_at,
    string_agg(
      delivery.last_error,
      '; ' ORDER BY delivery.destination
    ) FILTER (
      WHERE delivery.delivered_at IS NULL
        AND delivery.last_error IS NOT NULL
    ) AS last_error
  FROM fiat_problem_alert_outbox AS alert
  JOIN fiat_problem_alert_deliveries AS delivery
    USING (source_kind, source_id)
  WHERE alert.problem_code IN ('high_risk', 'fiat_locked_account')
  GROUP BY alert.source_kind, alert.source_id
)
UPDATE fiat_problem_alert_outbox AS alert
SET
  discord_delivered_at = CASE
    WHEN state.pending_count = 0
      THEN COALESCE(alert.discord_delivered_at, now())
    ELSE NULL
  END,
  attempt_count = state.attempt_count,
  next_attempt_at = COALESCE(
    state.next_attempt_at,
    'infinity'::timestamptz
  ),
  last_error = state.last_error,
  updated_at = now()
FROM delivery_state AS state
WHERE alert.source_kind = state.source_kind
  AND alert.source_id = state.source_id;
