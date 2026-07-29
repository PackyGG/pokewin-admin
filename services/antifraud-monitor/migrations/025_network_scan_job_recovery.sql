ALTER TABLE network_scan_jobs
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

UPDATE network_scan_jobs
SET lease_expires_at = now() + interval '3 minutes',
    heartbeat_at = COALESCE(started_at, now())
WHERE status = 'running'
  AND lease_expires_at IS NULL;

CREATE INDEX IF NOT EXISTS network_scan_jobs_running_lease_idx
  ON network_scan_jobs(lease_expires_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS rule_alert_outbox (
  rule_match_id uuid PRIMARY KEY REFERENCES rule_matches(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  delivered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rule_alert_outbox_pending_idx
  ON rule_alert_outbox(next_attempt_at, created_at)
  WHERE delivered_at IS NULL;
