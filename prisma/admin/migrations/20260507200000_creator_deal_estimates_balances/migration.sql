-- creator_deal_estimates: add tip_balance_usd + battle_balance_usd
-- Flat one-time balances we pre-load on the creator's account for
-- tips and sponsored battles. Added straight to Max Cost (no per-
-- week scaling, no recoup adjustment).
--
-- Idempotent — safe to re-run.

ALTER TABLE "creator_deal_estimates"
  ADD COLUMN IF NOT EXISTS "tip_balance_usd"    NUMERIC(20, 2),
  ADD COLUMN IF NOT EXISTS "battle_balance_usd" NUMERIC(20, 2);
