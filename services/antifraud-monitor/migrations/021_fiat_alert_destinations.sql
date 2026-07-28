CREATE TABLE IF NOT EXISTS fiat_problem_alert_deliveries (
  source_kind text NOT NULL,
  source_id text NOT NULL,
  destination text NOT NULL CHECK (
    destination IN (
      'antifraud_risk',
      'fiat_operations',
      'email_blacklist'
    )
  ),
  delivered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_kind, source_id, destination),
  FOREIGN KEY (source_kind, source_id)
    REFERENCES fiat_problem_alert_outbox(source_kind, source_id)
    ON DELETE CASCADE
);

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
  destination.destination,
  alert.discord_delivered_at,
  alert.attempt_count,
  CASE
    WHEN destination.destination = 'email_blacklist' THEN now()
    ELSE alert.next_attempt_at
  END,
  alert.last_error,
  alert.created_at,
  alert.updated_at
FROM fiat_problem_alert_outbox AS alert
CROSS JOIN LATERAL (
  SELECT 'email_blacklist'::text AS destination
  WHERE alert.problem_code = 'blacklisted_email_domain'

  UNION ALL

  SELECT 'antifraud_risk'::text
  WHERE alert.problem_code IN ('high_risk', 'fiat_locked_account')

  UNION ALL

  SELECT 'fiat_operations'::text
  WHERE alert.problem_code <> 'blacklisted_email_domain'
) AS destination
ON CONFLICT (source_kind, source_id, destination) DO NOTHING;

CREATE INDEX IF NOT EXISTS fiat_problem_alert_deliveries_pending_idx
  ON fiat_problem_alert_deliveries (next_attempt_at, source_kind, source_id)
  WHERE delivered_at IS NULL;
