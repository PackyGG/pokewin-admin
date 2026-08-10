CREATE INDEX IF NOT EXISTS discord_community_xp_events_time_idx
  ON discord_community_xp_events (occurred_at DESC, id DESC);
