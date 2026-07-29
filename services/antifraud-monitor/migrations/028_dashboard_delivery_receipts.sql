ALTER TABLE risk_events
  ADD COLUMN IF NOT EXISTS dashboard_delivered_at timestamptz;

-- The old tuple cursor could pass an event whose transaction had not committed
-- yet because PostgreSQL now() is fixed at transaction start. Preserve the
-- cursor's historical deliveries, but deliberately replay free-battle
-- containment commands so accounts missed by that race are contained.
UPDATE risk_events AS event
SET dashboard_delivered_at = now()
FROM ingest_delivery_cursors AS cursor
WHERE cursor.sink = 'admin-dashboard'
  AND event.dashboard_delivered_at IS NULL
  AND event.event_type <> 'risky_free_battle_containment'
  AND (event.recorded_at, event.id) <=
    (cursor.recorded_at, cursor.event_id);

CREATE INDEX IF NOT EXISTS risk_events_dashboard_pending_idx
  ON risk_events(recorded_at, id)
  WHERE dashboard_delivered_at IS NULL;
