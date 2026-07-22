/**
 * site_config keys owned by the funding-source wager-weights card on
 * /security.
 *
 * This file is NOT a "use server" module — it only exports a plain constant.
 * Next.js rejects non-async exports from a "use server" file at build time,
 * which is why the value lives here (same pattern as
 * rakeback-wager-weights-keys.ts / leaderboard-wager-weights-keys.ts).
 *
 * The /security page filters these keys out of its generic site_config table
 * (the `movedKeys` Set) so the same row isn't editable in two surfaces. The
 * backend itself writes these keys via the admin API; the panel never writes
 * them directly — it goes through backendApi.put().
 *
 * Keys (managed by the backend's PUT /admin/source-wager-weights):
 *  - {withdrawal,rakeback,leaderboard}_source_weight_{race_prize,
 *    bonus_other,rakeback,affiliate,tips}_bps
 */
export const SOURCE_WAGER_WEIGHT_SITE_CONFIG_KEYS: readonly string[] = [
  "withdrawal_source_weight_race_prize_bps",
  "withdrawal_source_weight_bonus_other_bps",
  "withdrawal_source_weight_rakeback_bps",
  "withdrawal_source_weight_affiliate_bps",
  "withdrawal_source_weight_tips_bps",
  "rakeback_source_weight_race_prize_bps",
  "rakeback_source_weight_bonus_other_bps",
  "rakeback_source_weight_rakeback_bps",
  "rakeback_source_weight_affiliate_bps",
  "rakeback_source_weight_tips_bps",
  "leaderboard_source_weight_race_prize_bps",
  "leaderboard_source_weight_bonus_other_bps",
  "leaderboard_source_weight_rakeback_bps",
  "leaderboard_source_weight_affiliate_bps",
  "leaderboard_source_weight_tips_bps",
];
