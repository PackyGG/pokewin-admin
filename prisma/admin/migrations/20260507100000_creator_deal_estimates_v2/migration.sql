-- creator_deal_estimates v2 — switch to a daily-fill / weekly-cap
-- model with leaderboard sponsorship and explicit deal length.
-- Drops fields the v1 schema had (cadence, fill_amount_usd,
-- fill_percent, tip_cap_usd, free_battle_cap_usd) since admins
-- requested a simpler, more accurate field set. Idempotent — every
-- statement is IF EXISTS / IF NOT EXISTS so re-runs are no-ops.

-- 1) Drop v1 columns + indexes that no longer exist on the model.
DROP INDEX IF EXISTS "creator_deal_estimates_cadence_idx";

ALTER TABLE "creator_deal_estimates"
  DROP COLUMN IF EXISTS "cadence",
  DROP COLUMN IF EXISTS "fill_amount_usd",
  DROP COLUMN IF EXISTS "fill_percent",
  DROP COLUMN IF EXISTS "tip_cap_usd",
  DROP COLUMN IF EXISTS "free_battle_cap_usd";

-- 2) Add v2 columns. All optional.
ALTER TABLE "creator_deal_estimates"
  ADD COLUMN IF NOT EXISTS "daily_fill_usd"       NUMERIC(20, 2),
  ADD COLUMN IF NOT EXISTS "leaderboard_cost_usd" NUMERIC(20, 2),
  ADD COLUMN IF NOT EXISTS "packy_paid_percent"   NUMERIC(5, 2),
  ADD COLUMN IF NOT EXISTS "deal_length_weeks"    INTEGER;
