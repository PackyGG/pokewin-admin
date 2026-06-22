import "server-only";

import { backendApi } from "./client";

/**
 * Shard economy config admin API (the earn RATE).
 *
 * `usd_per_shard` is how many USD of shard-weighted wager a user must
 * accumulate to earn ONE shard — the legacy "$10 per ticket" rate, now
 * configurable. Lower = shards earned faster. This is the headline knob for
 * "how many shards do you get when you wager"; the per-game and per-source
 * weights (shard-wager-weights / source-wager-weights) shape how much of a
 * given wager counts toward that progress before this rate is applied.
 *
 * Changes apply to wagers from now on — shards already earned and the
 * per-user carry/remainder (balances.shard_wager_progress) are never
 * re-touched.
 *
 * Source of truth (request/response shapes):
 *   packy-backend/src/routes/v1/admin/shard-config.ts
 *
 * `backendApi`'s base URL already includes `/v1`, so paths are
 * `/admin/...`. Errors surface as BackendApiError / BackendNetworkError —
 * callers degrade gracefully.
 */

/**
 * Earning basis for shards.
 *   "wager"     — shards earned at bet time on weighted wager (legacy default).
 *   "wagerloss" — shards earned at settlement on net loss max(0, wager - payout).
 * Always present on GET responses; optional on PUT.
 */
export type ShardEarningMode = "wager" | "wagerloss";

/** Shard economy config. `usd_per_shard` is USD of weighted wager per shard. */
export type ShardConfig = {
  /** USD of shard-weighted wager required to earn one shard (default 10). */
  usd_per_shard: number;
  /** Whether shards accrue on wager (at bet) or wager-loss (at settlement). */
  shard_earning_mode: ShardEarningMode;
};

/**
 * PUT payload — the backend requires usd_per_shard (positive, max 100000).
 * `shard_earning_mode` is optional (omitted = unchanged).
 */
export type UpdateShardConfigInput = {
  usd_per_shard: number;
  shard_earning_mode?: ShardEarningMode;
};

type Success<T> = { success: boolean; data: T };

export const getShardConfig = () =>
  backendApi
    .get<Success<ShardConfig>>("/admin/shard-config")
    .then((r) => r.data);

export const updateShardConfig = (input: UpdateShardConfigInput) =>
  backendApi
    .put<Success<ShardConfig>>("/admin/shard-config", input)
    .then((r) => r.data);
