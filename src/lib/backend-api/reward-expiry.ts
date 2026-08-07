import "server-only";

import { backendApi } from "./client";

/**
 * Reward-expiry admin API — claim windows for reward prizes, in whole DAYS
 * after each reward type's anchor event. 0 = never expires (the historical
 * behavior for race / leaderboard / balance rewards).
 *
 *  - rakeback (daily/weekly/monthly): days after the rakeback period ends.
 *    Stored per-type in the backend's rakeback_config.expiration_days (the
 *    pre-existing enforcement) — NOT in site_config.
 *  - race_days: days after a race period ends that its prizes stay
 *    claimable (site_config reward_expiry_race_days).
 *  - leaderboard_days: days after a creator/affiliate leaderboard ends
 *    (site_config reward_expiry_leaderboard_days).
 *  - balance_days: days after a balance reward (reload / bonus / deposit-fix
 *    / giveaway / lossback) is granted (site_config
 *    reward_expiry_balance_days).
 *
 * All windows are enforced at claim time only — changes apply to future
 * claim attempts immediately, already-settled claims are never re-touched.
 * Shrinking a window can make currently-claimable prizes unclaimable.
 *
 * Source of truth (request/response shapes):
 *   packy-backend/src/routes/v1/admin/reward-expiry.ts
 *
 * `backendApi`'s base URL already includes `/v1`, so paths are `/admin/...`.
 * Errors surface as BackendApiError / BackendNetworkError — callers degrade
 * gracefully.
 */

/** Per-rakeback-type claim windows, in whole days after the period ends. */
export type RakebackExpiry = {
  daily_days: number;
  weekly_days: number;
  monthly_days: number;
};

/** The full expiry config returned by GET. All values in whole days; 0 = never expires. */
export type RewardExpiry = {
  rakeback: RakebackExpiry;
  race_days: number;
  leaderboard_days: number;
  balance_days: number;
};

/**
 * Partial-update payload for the PUT. At least one value must be present —
 * the backend rejects an empty body. Each value is an int in days,
 * 0..3650.
 */
export type UpdateRewardExpiryInput = {
  rakeback?: Partial<RakebackExpiry>;
  race_days?: number;
  leaderboard_days?: number;
  balance_days?: number;
};

type Success<T> = { success: boolean; data: T };

export const getRewardExpiry = () =>
  backendApi
    .get<Success<RewardExpiry>>("/admin/reward-expiry")
    .then((r) => r.data);

export const updateRewardExpiry = (input: UpdateRewardExpiryInput) =>
  backendApi
    .put<Success<RewardExpiry>>("/admin/reward-expiry", input)
    .then((r) => r.data);
