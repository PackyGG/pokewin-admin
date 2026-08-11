-- Dedicated delivery route for confirmed Whop buyer-history auto-bans.
ALTER TABLE fiat_problem_alert_deliveries
  DROP CONSTRAINT IF EXISTS fiat_problem_alert_deliveries_destination_check;

ALTER TABLE fiat_problem_alert_deliveries
  ADD CONSTRAINT fiat_problem_alert_deliveries_destination_check
  CHECK (
    destination IN (
      'antifraud_risk',
      'fiat_operations',
      'email_blacklist',
      'high_risk_supplemental',
      'auto_banned'
    )
  );

INSERT INTO source_cursors(stream, occurred_at, source_id)
VALUES ('whop-history-auto-bans', now() - interval '24 hours', '')
ON CONFLICT (stream) DO NOTHING;

CREATE INDEX IF NOT EXISTS risk_events_whop_history_confirmation_idx
  ON risk_events (recorded_at DESC, id DESC)
  WHERE event_type = 'whop_history_auto_ban'
    AND dashboard_delivered_at IS NOT NULL;
