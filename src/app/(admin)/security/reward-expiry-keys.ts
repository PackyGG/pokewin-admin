/**
 * site_config keys owned by the reward-expiry card on /security.
 *
 * This file is NOT a "use server" module — it only exports a plain
 * constant. Next.js rejects non-async exports from a "use server" file at
 * build time, which is why the value lives here (same pattern as
 * leaderboard-wager-weights-keys.ts / source-wager-weights-keys.ts).
 *
 * The /security page filters these keys out of its generic site_config
 * table (the `movedKeys` Set) so the same row isn't editable in two
 * surfaces. The backend itself writes these keys via the admin API; the
 * panel never writes them directly — it goes through backendApi.put().
 *
 * Keys (managed by the backend's PUT /admin/reward-expiry):
 *  - reward_expiry_race_days         race prize claim window
 *  - reward_expiry_leaderboard_days  creator/affiliate leaderboard prize window
 *  - reward_expiry_balance_days      balance reward (reload/bonus) window
 *
 * The rakeback windows are NOT site_config keys — they live per-type in the
 * backend's rakeback_config.expiration_days table.
 */
export const REWARD_EXPIRY_SITE_CONFIG_KEYS: readonly string[] = [
  "reward_expiry_race_days",
  "reward_expiry_leaderboard_days",
  "reward_expiry_balance_days",
];
