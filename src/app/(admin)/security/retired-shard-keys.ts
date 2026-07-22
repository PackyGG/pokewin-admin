/**
 * RETIRED shard site_config keys.
 *
 * The shard system is no longer used on-site (owner, 2026-07), so the two
 * dedicated /security surfaces that owned these keys — "Shard Earn Rate"
 * (shard-config-card) and "Shard Wager Weights" (shard-wager-weights-card) —
 * were removed along with their actions + backend-API modules.
 *
 * This list is deliberately KEPT: the /security page filters these keys out of
 * its generic site_config table (the `movedKeys` Set in
 * security-sections-loader.tsx). Dropping the list would make the retired shard
 * rows RESURFACE as raw, editable config rows — the opposite of retiring the
 * feature. Keep them listed until the keys are deleted from site_config itself.
 *
 * Keys (formerly written by the backend's PUT /admin/shard-config and
 * PUT /admin/shard-wager-weights):
 *  - shard_usd_per_shard              USD of weighted wager to earn one shard
 *  - shard_wager_weight_packs_bps     pack wager weight toward shards
 *  - shard_wager_weight_battles_bps   battle wager weight toward shards
 *  - shard_wager_weight_upgrader_bps  upgrader wager weight toward shards
 *  - shard_wager_weight_keno_bps      keno wager weight toward shards
 */
export const RETIRED_SHARD_SITE_CONFIG_KEYS: readonly string[] = [
  "shard_usd_per_shard",
  "shard_wager_weight_packs_bps",
  "shard_wager_weight_battles_bps",
  "shard_wager_weight_upgrader_bps",
  "shard_wager_weight_keno_bps",
  // Formerly the "Shard earning" destination inside the Funding-Source Wager
  // Weights card — that column was removed with the rest of the shard surface.
  "shards_source_weight_race_prize_bps",
  "shards_source_weight_bonus_other_bps",
  "shards_source_weight_rakeback_bps",
  "shards_source_weight_affiliate_bps",
  "shards_source_weight_tips_bps",
];
