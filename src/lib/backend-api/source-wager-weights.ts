import "server-only";

import { backendApi } from "./client";

/**
 * Funding-source wager-weight admin API.
 *
 * The game backend lets wager that was FUNDED BY a bonus source (race /
 * leaderboard prizes, rain + reward claims, rakeback, affiliate, tips) count
 * at a different rate toward the WITHDRAWAL requirement, RAKEBACK, RACE
 * LEADERBOARDS and SHARD earning than deposit-funded wager. All values are
 * basis points (10000 bps = 1× = counts the same as deposit-funded; 0 = that
 * source's wager doesn't count at all). Deposits and organic game winnings
 * are the implicit 100% baseline.
 *
 * Composes with the per-game weights. Withdrawal, leaderboard and shards are
 * frozen at wager time (changes affect future wagers only — race standings
 * never reshuffle retroactively and shards already earned are never
 * re-touched); rakeback is applied live at claim (lowering a rakeback weight
 * shrinks rakeback on still-unclaimed periods, never settled claims). The
 * leaderboard destination covers official races only — creator/affiliate
 * leaderboard volume uses the per-game weights alone.
 *
 * Source of truth (request/response shapes):
 *   packy-backend/src/routes/v1/admin/source-wager-weights.ts
 *
 * `backendApi`'s base URL already includes `/v1`, so paths are `/admin/...`.
 * Errors surface as BackendApiError / BackendNetworkError — callers degrade
 * gracefully.
 */

/** Per-source weights for one destination, all in bps (10000 = 1×). */
export type FundingSourceWeights = {
  /** Race / leaderboard prizes. */
  race_prize: number;
  /** Rain + reward/balance claims (+ sponsored-battle share). */
  bonus_other: number;
  /** Rakeback claims. */
  rakeback: number;
  /** Affiliate commission claims. */
  affiliate: number;
  /** Tips received. */
  tips: number;
};

/**
 * The full 4×5 matrix returned by GET. `leaderboard` and `shards` are
 * optional so the card degrades per-destination while a backend deploy that
 * only knows withdrawal + rakeback is still live.
 */
export type SourceWagerWeights = {
  withdrawal: FundingSourceWeights;
  rakeback: FundingSourceWeights;
  leaderboard?: FundingSourceWeights;
  shards?: FundingSourceWeights;
};

/**
 * Partial-update payload for the PUT. At least one value (across any
 * destination) must be present — the backend rejects an empty body. Each
 * value is an int in bps, 0..1_000_000.
 */
export type UpdateSourceWagerWeightsInput = {
  withdrawal?: Partial<FundingSourceWeights>;
  rakeback?: Partial<FundingSourceWeights>;
  leaderboard?: Partial<FundingSourceWeights>;
  shards?: Partial<FundingSourceWeights>;
};

type Success<T> = { success: boolean; data: T };

export const getSourceWagerWeights = () =>
  backendApi
    .get<Success<SourceWagerWeights>>("/admin/source-wager-weights")
    .then((r) => r.data);

export const updateSourceWagerWeights = (
  input: UpdateSourceWagerWeightsInput,
) =>
  backendApi
    .put<Success<SourceWagerWeights>>("/admin/source-wager-weights", input)
    .then((r) => r.data);
