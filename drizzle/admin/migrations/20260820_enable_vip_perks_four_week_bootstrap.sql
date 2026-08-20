-- Final enablement after the fixed four-week bootstrap and Discord role-sync
-- repair were both deployed and verified in production.
UPDATE vip_perks_config
SET enabled = true,
    initial_wager_usd = 30000,
    initial_wager_without_creator_code_usd = 30000,
    initial_wager_with_creator_code_usd = 25000,
    updated_at = NOW()
WHERE guild_id = '1505650386894327919';

INSERT INTO admin_audit_events (event_type, metadata)
VALUES (
  'vip_perks_settings_updated',
  jsonb_build_object(
    'enabled', true,
    'initialWagerWithoutCreatorCodeUsd', 30000,
    'initialWagerWithCreatorCodeUsd', 25000,
    'initialWagerCountingStartedAt', '2026-07-23T11:27:00.000Z',
    'recurringSettingsPreserved', true,
    'windowDays', 30,
    'source', 'owner_authorized_corrected_production_rollout'
  )
);
