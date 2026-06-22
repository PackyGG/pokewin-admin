/**
 * site_config keys owned by the withdrawal wager-requirement defaults card
 * on /security.
 *
 * This file is NOT a "use server" module — it only exports a plain
 * constant. Next.js rejects non-async exports from a "use server" file at
 * build time, which is why the value lives here (same pattern as
 * rain/config-keys.ts → RAIN_CONFIG_SITE_CONFIG_KEYS).
 *
 * The /security page filters these keys out of its generic site_config
 * table (the `movedKeys` Set) so the same row isn't editable in two
 * surfaces. The backend itself writes these keys via the admin API; the
 * panel never writes them directly — it goes through backendApi.put().
 *
 * Keys (managed by the backend's PUT /admin/wager-requirement/default):
 *  - withdrawal_wager_requirement_bps           deposit-based requirement
 *  - withdrawal_bonus_wager_requirement_bps     general bonus-winnings requirement
 *  - withdrawal_affiliate_wager_requirement_bps             affiliate-claims requirement
 *  - withdrawal_affiliate_leaderboard_wager_requirement_bps affiliate-leaderboard prizes requirement
 *  - withdrawal_rakeback_wager_requirement_bps               rakeback requirement
 *  - withdrawal_tips_wager_requirement_bps                   tips requirement
 *  - withdrawal_admin_adjustment_wager_requirement_bps       admin-credit requirement
 *  - wager_weight_packs_bps                     pack wager weight
 *  - wager_weight_battles_bps                battle wager weight
 *  - wager_weight_upgrader_bps               upgrader wager weight
 */
export const WAGER_REQUIREMENT_SITE_CONFIG_KEYS: readonly string[] = [
  "withdrawal_wager_requirement_bps",
  "withdrawal_bonus_wager_requirement_bps",
  "withdrawal_affiliate_wager_requirement_bps",
  "withdrawal_affiliate_leaderboard_wager_requirement_bps",
  "withdrawal_rakeback_wager_requirement_bps",
  "withdrawal_tips_wager_requirement_bps",
  "withdrawal_admin_adjustment_wager_requirement_bps",
  "wager_weight_packs_bps",
  "wager_weight_battles_bps",
  "wager_weight_upgrader_bps",
];
