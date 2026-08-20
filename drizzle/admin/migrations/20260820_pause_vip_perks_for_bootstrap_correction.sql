-- Product correction immediately after the first enablement: older lifetime
-- history must not seed qualification. Pause evaluation and clear only the
-- provisional unlocks created by that rollout before any Discord role grant.
UPDATE vip_perks_config
SET enabled = false, updated_at = NOW()
WHERE guild_id = '1505650386894327919';

UPDATE vip_perk_entitlements
SET initial_unlocked_at = NULL,
    initial_threshold_usd = NULL,
    initial_had_creator_code = NULL,
    last_status = 'inactive',
    last_active = false,
    last_initial_wager_usd = 0,
    last_previous_cycle_wager_usd = 0,
    last_current_cycle_wager_usd = 0,
    last_evaluated_at = NOW(),
    updated_at = NOW()
WHERE initial_unlocked_at >= '2026-08-20T11:27:00Z'::timestamptz;

INSERT INTO admin_audit_events (event_type, metadata)
VALUES (
  'vip_perks_rollout_paused',
  jsonb_build_object(
    'reason', 'initial_baseline_changed_to_four_week_bootstrap',
    'provisionalUnlocksCleared', true,
    'source', 'owner_product_correction'
  )
);
