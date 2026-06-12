import "server-only";

import { backendApi } from "./client";

/**
 * Odds-based (bet-multiplier) wager-weight admin API.
 *
 * The game backend discounts low-multiplier bets as an anti-farming
 * measure: per destination (withdrawal requirement, rakeback, race
 * leaderboards, shard earning) an enable toggle plus an ordered tier list.
 * A bet with payout multiplier m counts at the FIRST tier (ascending max_x)
 * where m < max_x, else at 100%. Only upgrader bets have a player-chosen
 * multiplier — packs and battles are unaffected. Backend defaults: below
 * 1.25× → 20%, 1.25–1.50× → 50%, all destinations disabled.
 *
 * Source of truth (request/response shapes + validation):
 *   packy-backend/src/routes/v1/admin/multiplier-wager-weights.ts
 *
 * `backendApi`'s base URL already includes `/v1`, so paths are `/admin/...`.
 * Errors surface as BackendApiError / BackendNetworkError — callers degrade
 * gracefully (the /security card renders an "awaiting backend deploy" state
 * until the backend branch ships).
 */

// Runtime constants live in multiplier-wager-weights-shared.ts (no
// "server-only") so the client card can import them as values; re-exported
// here for server consumers (page + action).
export {
  MULTIPLIER_WEIGHT_DESTINATIONS,
  MAX_MULTIPLIER_TIERS,
  DEFAULT_MULTIPLIER_TIERS,
  type MultiplierWeightDestination,
  type MultiplierTier,
} from "./multiplier-wager-weights-shared";
import type {
  MultiplierWeightDestination,
  MultiplierTier,
} from "./multiplier-wager-weights-shared";

/** Per-destination config. tiers are sorted by strictly-ascending max_x. */
export type MultiplierWeightConfig = {
  enabled: boolean;
  tiers: MultiplierTier[];
};

/** Full GET shape — all 4 destinations always present. */
export type MultiplierWagerWeights = Record<
  MultiplierWeightDestination,
  MultiplierWeightConfig
>;

/**
 * Partial-update payload for the PUT. At least one value (enabled or tiers,
 * across any destination) must be present — the backend rejects an empty
 * body. `tiers`, when provided, REPLACES the stored list wholesale.
 * Validation (mirrored in the server action): 0–10 tiers; max_x finite > 1
 * and <= 100000; weight_bps int 0..10000; max_x strictly ascending. 400 on
 * violation; success responds with the full GET shape.
 */
export type UpdateMultiplierWagerWeightsInput = Partial<
  Record<
    MultiplierWeightDestination,
    { enabled?: boolean; tiers?: MultiplierTier[] }
  >
>;

type Success<T> = { success: boolean; data: T };

export const getMultiplierWagerWeights = () =>
  backendApi
    .get<Success<MultiplierWagerWeights>>("/admin/multiplier-wager-weights")
    .then((r) => r.data);

export const updateMultiplierWagerWeights = (
  input: UpdateMultiplierWagerWeightsInput,
) =>
  backendApi
    .put<Success<MultiplierWagerWeights>>(
      "/admin/multiplier-wager-weights",
      input,
    )
    .then((r) => r.data);
