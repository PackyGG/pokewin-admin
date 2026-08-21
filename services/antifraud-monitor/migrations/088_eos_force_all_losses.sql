-- Emergency global override. This is intentionally separate from the normal
-- global flow because it must take priority over every per-user rule.
ALTER TABLE battle_test_config
  ADD COLUMN IF NOT EXISTS force_all_losses boolean NOT NULL DEFAULT false;
