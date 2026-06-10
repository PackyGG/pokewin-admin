import "server-only";

import { backendApi } from "./client";

/**
 * Shard wager-weight admin API (per-game).
 *
 * The game backend lets packs / battles / upgrader wagers count at different
 * rates toward EARNING SHARDS (formerly "tickets"). All values are basis
 * points (10000 bps = 1× = wagers count 1:1 toward shards; 8000 = a $100 bet
 * counts as $80; 0 = the game earns no shards at all).
 *
 * Applied AT WAGER TIME on self-funded wagers only — creator-funded activity
 * earns no shards. Weight changes only affect wagers from that point on:
 * shards already earned and the per-user carry/remainder
 * (balances.shard_wager_progress) are never re-touched. Completely
 * independent from the withdrawal, leaderboard and rakeback weights; composes
 * with the per-funding-source `shards` weights (source-wager-weights).
 *
 * Source of truth (request/response shapes):
 *   packy-backend/src/routes/v1/admin/shard-wager-weights.ts
 *
 * `backendApi`'s base URL already includes `/v1`, so paths are
 * `/admin/...`. Errors surface as BackendApiError / BackendNetworkError —
 * callers degrade gracefully.
 */

/** Per-game shard wager weights, all in bps (10000 = 1×). */
export type ShardWagerWeights = {
  /** How much pack wagers count toward earning shards, in bps (10000 = 1×). */
  packs_bps: number;
  /** How much battle wagers count toward earning shards, in bps (10000 = 1×). */
  battles_bps: number;
  /** How much upgrader wagers count toward earning shards, in bps (10000 = 1×). */
  upgrader_bps: number;
};

/**
 * Partial-update payload for the PUT. At least one field must be present —
 * the backend rejects an empty body. Each value is an int in bps,
 * 0..1_000_000.
 */
export type UpdateShardWagerWeightsInput = Partial<ShardWagerWeights>;

type Success<T> = { success: boolean; data: T };

export const getShardWagerWeights = () =>
  backendApi
    .get<Success<ShardWagerWeights>>("/admin/shard-wager-weights")
    .then((r) => r.data);

export const updateShardWagerWeights = (
  input: UpdateShardWagerWeightsInput,
) =>
  backendApi
    .put<Success<ShardWagerWeights>>("/admin/shard-wager-weights", input)
    .then((r) => r.data);
