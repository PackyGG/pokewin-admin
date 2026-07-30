CREATE INDEX IF NOT EXISTS monitor_sessions_started_id_idx
  ON monitor_sessions(started_at DESC, id DESC);
