CREATE TABLE IF NOT EXISTS ingest_delivery_cursors (
  sink text PRIMARY KEY,
  recorded_at timestamptz NOT NULL,
  event_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ingest_delivery_cursors(sink, recorded_at, event_id)
VALUES (
  'admin-dashboard',
  now(),
  '00000000-0000-0000-0000-000000000000'::uuid
)
ON CONFLICT (sink) DO NOTHING;

CREATE INDEX IF NOT EXISTS risk_events_ingest_delivery_idx
  ON risk_events(recorded_at, id);
