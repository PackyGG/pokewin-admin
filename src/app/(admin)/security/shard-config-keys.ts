/**
 * site_config keys owned by the shard earn-rate card on /security.
 *
 * This file is NOT a "use server" module — it only exports a plain
 * constant. Next.js rejects non-async exports from a "use server" file at
 * build time, which is why the value lives here (same pattern as
 * shard-wager-weights-keys.ts).
 *
 * The /security page filters these keys out of its generic site_config
 * table (the `movedKeys` Set) so the same row isn't editable in two
 * surfaces. The backend itself writes these keys via the admin API; the
 * panel never writes them directly — it goes through backendApi.put().
 *
 * Keys (managed by the backend's PUT /admin/shard-config):
 *  - shard_usd_per_shard   USD of weighted wager required to earn one shard
 */
export const SHARD_CONFIG_SITE_CONFIG_KEYS: readonly string[] = [
  "shard_usd_per_shard",
];
