-- Apply to the Packy READ REPLICA only, never the primary production DB.
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction.

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_user_signup_cursor_idx
  ON "user" (created_at, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_user_signup_ip_time_idx
  ON "user" (signup_ip, created_at)
  WHERE signup_ip IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_user_signup_ipv6_64_time_idx
  ON "user" (
    (network(set_masklen(signup_ip::inet, 64))),
    created_at
  )
  WHERE signup_ip IS NOT NULL AND family(signup_ip::inet) = 6;

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_fingerprints_signup_latest_idx
  ON fingerprints (user_id, event_type, created_at DESC)
  INCLUDE (request_id, visitor_id, confidence, ip);

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_audit_register_latest_idx
  ON audit_events (user_id, event_type, created_at DESC)
  INCLUDE (user_agent);

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_ledger_user_time_idx
  ON ledger_transactions (user_id, created_at)
  INCLUDE (type, amount, status, balance_before, balance_after, description);

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_user_rewards_activity_idx
  ON user_rewards (user_id, (COALESCE(opened_at, granted_at)))
  INCLUDE (reward_id, opened_at, granted_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_rain_entries_user_time_idx
  ON rain_entries (user_id, created_at)
  INCLUDE (rain_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_rain_win_leaderboard_idx
  ON ledger_transactions (user_id)
  INCLUDE (amount, created_at)
  WHERE type = 'rain_win' AND status = 'completed';
