CREATE TABLE monitor_activity_cursors (
  session_id uuid PRIMARY KEY REFERENCES monitor_sessions(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL,
  source text NOT NULL DEFAULT '',
  source_ref text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO monitor_activity_cursors(session_id, occurred_at)
SELECT id, started_at - interval '2 seconds'
FROM monitor_sessions
ON CONFLICT (session_id) DO NOTHING;
