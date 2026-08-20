-- VIP-perks initial wager starts with a one-time four-week historical seed,
-- then accumulates forward for the lifetime of the program. This is a fixed
-- global epoch, not a rolling 28-day window and not full account history.
ALTER TABLE vip_perks_config
  ADD COLUMN IF NOT EXISTS initial_wager_counting_started_at timestamptz
  NOT NULL DEFAULT '2026-07-23T11:27:00Z'::timestamptz;

UPDATE vip_perks_config
SET initial_wager_counting_started_at = '2026-07-23T11:27:00Z'::timestamptz,
    updated_at = NOW()
WHERE guild_id = '1505650386894327919';
