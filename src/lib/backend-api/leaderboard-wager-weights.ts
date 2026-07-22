import "server-only";

import { backendApi } from "./client";

/**
 * Leaderboard wager-weight admin API.
 *
 * The game backend lets packs / battles / upgrader / keno wagers count at
 * different rates toward LEADERBOARDS — official races (daily/weekly/
 * monthly) AND creator/affiliate leaderboards share ONE weight set. All
 * values are basis points (10000 bps = 1×; 8000 = a $100 bet counts as
 * $80; 0 = the game doesn't count toward leaderboards at all).
 *
 * Weights are applied AT WAGER TIME and frozen on the wager row, so a
 * change only affects bets placed after it — standings are never
 * reshuffled retroactively. Completely independent from the withdrawal
 * wager-requirement weights (wager_weight_*_bps): total_wagered, levels,
 * rakeback, affiliate commissions and the withdrawal gate are unaffected.
 *
 * Source of truth (request/response shapes):
 *   packy-backend/src/routes/v1/admin/leaderboard-wager-weights.ts
 *
 * `backendApi`'s base URL already includes `/v1`, so paths are
 * `/admin/...`. Errors surface as BackendApiError / BackendNetworkError —
 * callers degrade gracefully.
 */

/** Per-game leaderboard wager weights, all in bps (10000 = 1×). */
export type LeaderboardWagerWeights = {
  /** How much pack wagers count toward leaderboards, in bps (10000 = 1×). */
  packs_bps: number;
  /** How much battle wagers count toward leaderboards, in bps (10000 = 1×). */
  battles_bps: number;
  /** How much upgrader wagers count toward leaderboards, in bps (10000 = 1×). */
  upgrader_bps: number;
  /** How much keno wagers count toward leaderboards, in bps (10000 = 1×). */
  keno_bps: number;
};

/**
 * Partial-update payload for the PUT. At least one field must be present —
 * the backend rejects an empty body. Each value is an int in bps,
 * 0..1_000_000.
 */
export type UpdateLeaderboardWagerWeightsInput =
  Partial<LeaderboardWagerWeights>;

type Success<T> = { success: boolean; data: T };

export const getLeaderboardWagerWeights = () =>
  backendApi
    .get<Success<LeaderboardWagerWeights>>("/admin/leaderboard-wager-weights")
    .then((r) => r.data);

export const updateLeaderboardWagerWeights = (
  input: UpdateLeaderboardWagerWeightsInput,
) =>
  backendApi
    .put<Success<LeaderboardWagerWeights>>(
      "/admin/leaderboard-wager-weights",
      input,
    )
    .then((r) => r.data);
