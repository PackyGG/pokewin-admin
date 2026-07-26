-- Apply to the Packy READ REPLICA only, never the primary production DB.
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction.

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_user_signup_cursor_idx
  ON "user" (created_at, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_user_signup_ip_time_idx
  ON "user" (signup_ip, created_at)
  WHERE signup_ip IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_user_signup_ipv6_64_time_v2_idx
  ON "user" (
    (network(set_masklen((
      CASE WHEN signup_ip ~
        '^(([0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|([0-9A-Fa-f]{1,4}:){1,7}:|([0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|([0-9A-Fa-f]{1,4}:){1,5}(:[0-9A-Fa-f]{1,4}){1,2}|([0-9A-Fa-f]{1,4}:){1,4}(:[0-9A-Fa-f]{1,4}){1,3}|([0-9A-Fa-f]{1,4}:){1,3}(:[0-9A-Fa-f]{1,4}){1,4}|([0-9A-Fa-f]{1,4}:){1,2}(:[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:(:[0-9A-Fa-f]{1,4}){1,6}|:((:[0-9A-Fa-f]{1,4}){1,7}|:))$'
      THEN signup_ip END
    )::inet, 64))),
    created_at
  )
  WHERE signup_ip IS NOT NULL;

-- The original expression cast every text value directly to inet. Drop it
-- only after the guarded replacement exists, otherwise a malformed future IP
-- can break mirror ingestion while PostgreSQL maintains the old index.
DROP INDEX CONCURRENTLY IF EXISTS antifraud_user_signup_ipv6_64_time_idx;

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_fingerprints_signup_latest_idx
  ON fingerprints (user_id, event_type, created_at DESC)
  INCLUDE (request_id, visitor_id, confidence, ip);

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_fingerprints_network_device_idx
  ON fingerprints (visitor_id, user_id)
  WHERE confidence >= 0.9;

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_audit_register_latest_idx
  ON audit_events (user_id, event_type, created_at DESC)
  INCLUDE (user_agent);

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_ledger_user_time_idx
  ON ledger_transactions (user_id, created_at)
  INCLUDE (
    type,
    amount,
    status,
    balance_before,
    balance_after,
    description,
    crypto_asset,
    crypto_amount,
    deposit_address_id,
    fireblocks_tx_id,
    blockchain_tx_hash
  );

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_creator_usage_window_idx
  ON affiliate_code_usages (affiliate_user_id, created_at DESC, referred_user_id)
  INCLUDE (
    deposit_amount_usd,
    wager_amount_usd,
    referrer_cut_usd,
    user_bonus_usd
  );

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_creator_deposit_signal_idx
  ON ledger_transactions (user_id, created_at DESC)
  INCLUDE (source_address)
  WHERE type = 'deposit' AND status = 'completed';

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_creator_withdrawal_window_idx
  ON card_withdrawal_requests (user_id, created_at DESC)
  INCLUDE (status, total_value_usd);

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

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_rain_win_time_user_idx
  ON ledger_transactions (created_at DESC, user_id)
  INCLUDE (amount)
  WHERE type = 'rain_win' AND status = 'completed';

CREATE INDEX CONCURRENTLY IF NOT EXISTS antifraud_fiat_completed_ledger_idx
  ON fiat_deposit_intents (completed_ledger_id)
  INCLUDE (
    provider,
    currency,
    status,
    requested_amount_cents,
    credited_amount_cents
  )
  WHERE completed_ledger_id IS NOT NULL;
