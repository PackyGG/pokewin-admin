/**
 * site_config keys owned by the shard wager-weights card on /security.
 *
 * This file is NOT a "use server" module — it only exports a plain
 * constant. Next.js rejects non-async exports from a "use server" file at
 * build time, which is why the value lives here (same pattern as
 * leaderboard-wager-weights-keys.ts / rakeback-wager-weights-keys.ts).
 *
 * The /security page filters these keys out of its generic site_config
 * table (the `movedKeys` Set) so the same row isn't editable in two
 * surfaces. The backend itself writes these keys via the admin API; the
 * panel never writes them directly — it goes through backendApi.put().
 *
 * Keys (managed by the backend's PUT /admin/shard-wager-weights):
 *  - shard_wager_weight_packs_bps     pack wager weight toward shards
 *  - shard_wager_weight_battles_bps   battle wager weight toward shards
 *  - shard_wager_weight_upgrader_bps  upgrader wager weight toward shards
 */
export const SHARD_WAGER_WEIGHT_SITE_CONFIG_KEYS: readonly string[] = [
  "shard_wager_weight_packs_bps",
  "shard_wager_weight_battles_bps",
  "shard_wager_weight_upgrader_bps",
];
