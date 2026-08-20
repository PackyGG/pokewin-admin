-- The first VIP-perks unlock uses lifetime cash-eligible weighted wager.
-- Players on a currently active creator code receive a separate threshold.
-- Existing unlocked entitlements freeze the tier that qualified them; later
-- code/config changes must never revoke or rewrite a completed unlock.
ALTER TABLE "vip_perks_config"
  ADD COLUMN IF NOT EXISTS "initial_wager_without_creator_code_usd"
    numeric(20, 2) NOT NULL DEFAULT 30000,
  ADD COLUMN IF NOT EXISTS "initial_wager_with_creator_code_usd"
    numeric(20, 2) NOT NULL DEFAULT 25000;

ALTER TABLE "vip_perks_config"
  ADD CONSTRAINT "vip_perks_config_initial_without_code_check"
    CHECK ("initial_wager_without_creator_code_usd" > 0),
  ADD CONSTRAINT "vip_perks_config_initial_with_code_check"
    CHECK ("initial_wager_with_creator_code_usd" > 0);

ALTER TABLE "vip_perk_entitlements"
  ADD COLUMN IF NOT EXISTS "initial_threshold_usd" numeric(20, 2),
  ADD COLUMN IF NOT EXISTS "initial_had_creator_code" boolean;

ALTER TABLE "vip_perk_entitlements"
  ADD CONSTRAINT "vip_perk_entitlements_initial_threshold_check"
    CHECK ("initial_threshold_usd" IS NULL OR "initial_threshold_usd" > 0),
  ADD CONSTRAINT "vip_perk_entitlements_initial_tier_shape_check"
    CHECK (
      ("initial_threshold_usd" IS NULL) =
      ("initial_had_creator_code" IS NULL)
    );
