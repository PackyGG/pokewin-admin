import "server-only";

import { backendApi } from "./client";

/**
 * Rakeback wager-weight admin API.
 *
 * The game backend lets packs / battles / upgrader / keno wagers count at
 * different rates toward RAKEBACK — i.e. how much of a game's bets feed the
 * rakeback wager base (which is then multiplied by the per-tier rakeback
 * percentage). All values are basis points (10000 bps = 1×; 8000 = a $100
 * bet contributes $80 of rakeback base; 0 = the game earns no rakeback at
 * all).
 *
 * Unlike the leaderboard / withdrawal weights (which freeze a weighted
 * amount on the wager row at bet time), the rakeback weight is applied LIVE
 * when claimable rakeback is computed — matching the rakeback percentage
 * itself, which is also live. Lowering a weight shrinks rakeback on
 * still-unclaimed periods but never re-touches already-settled claims.
 * total_wagered, levels, races and the withdrawal gate are unaffected.
 *
 * Source of truth (request/response shapes):
 *   packy-backend/src/routes/v1/admin/rakeback-wager-weights.ts
 *
 * `backendApi`'s base URL already includes `/v1`, so paths are
 * `/admin/...`. Errors surface as BackendApiError / BackendNetworkError —
 * callers degrade gracefully.
 */

/** Per-game rakeback wager weights, all in bps (10000 = 1×). */
export type RakebackWagerWeights = {
  /** How much pack wagers count toward rakeback, in bps (10000 = 1×). */
  packs_bps: number;
  /** How much battle wagers count toward rakeback, in bps (10000 = 1×). */
  battles_bps: number;
  /** How much upgrader wagers count toward rakeback, in bps (10000 = 1×). */
  upgrader_bps: number;
  /** How much keno wagers count toward rakeback, in bps (10000 = 1×). */
  keno_bps: number;
};

/**
 * Partial-update payload for the PUT. At least one field must be present —
 * the backend rejects an empty body. Each value is an int in bps,
 * 0..1_000_000.
 */
export type UpdateRakebackWagerWeightsInput = Partial<RakebackWagerWeights>;

type Success<T> = { success: boolean; data: T };

export const getRakebackWagerWeights = () =>
  backendApi
    .get<Success<RakebackWagerWeights>>("/admin/rakeback-wager-weights")
    .then((r) => r.data);

export const updateRakebackWagerWeights = (
  input: UpdateRakebackWagerWeightsInput,
) =>
  backendApi
    .put<Success<RakebackWagerWeights>>(
      "/admin/rakeback-wager-weights",
      input,
    )
    .then((r) => r.data);
