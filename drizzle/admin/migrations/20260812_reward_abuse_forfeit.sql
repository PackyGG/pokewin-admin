ALTER TABLE reward_abuse_reviews
  ADD COLUMN IF NOT EXISTS rain_funds_removed_usd numeric(20, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rain_forfeit_ledger_tx_id uuid;
