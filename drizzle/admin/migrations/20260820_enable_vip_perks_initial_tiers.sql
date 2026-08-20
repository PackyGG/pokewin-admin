-- Owner-authorized production rollout after the tier-aware API and bot were
-- both verified healthy. Recurring qualification intentionally remains at its
-- existing setting until a separate recurring threshold is approved.
INSERT INTO vip_perks_config (
  guild_id,
  enabled,
  initial_wager_usd,
  initial_wager_without_creator_code_usd,
  initial_wager_with_creator_code_usd,
  recurring_enabled,
  recurring_wager_usd,
  updated_at
) VALUES (
  '1505650386894327919',
  true,
  30000,
  30000,
  25000,
  false,
  NULL,
  NOW()
)
ON CONFLICT (guild_id) DO UPDATE SET
  enabled = true,
  initial_wager_usd = 30000,
  initial_wager_without_creator_code_usd = 30000,
  initial_wager_with_creator_code_usd = 25000,
  updated_at = NOW();

INSERT INTO admin_audit_events (event_type, metadata)
VALUES (
  'vip_perks_settings_updated',
  jsonb_build_object(
    'enabled', true,
    'initialWagerWithoutCreatorCodeUsd', 30000,
    'initialWagerWithCreatorCodeUsd', 25000,
    'recurringSettingsPreserved', true,
    'windowDays', 30,
    'source', 'owner_authorized_production_rollout'
  )
);
