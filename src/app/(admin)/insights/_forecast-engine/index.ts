/**
 * Public surface of the SHARED, reward-agnostic forecast engine kit.
 *
 * Framework-agnostic (no React, no DB, no server-only). A reward's `simulate`
 * + the client island both import from here; the generic internals stay behind
 * this barrel.
 *
 * This kit provides the GENERIC orchestration + contract. The reward-SPECIFIC
 * cost / cap / leakage math lives in each reward's own `_forecast/` (its
 * `simulate`, scenarios, constants, and reward-specific types like CapRule /
 * SegmentId). See `rewards/deposit-bonus/_forecast/` for the reference.
 */

// ─── Generic types & the ForecastConfig contract ─────────────────────────────
export type {
  BaseAssumptions,
  BaseScenarioConfig,
  DailyPoint,
  ForecastBaseline,
  ForecastColors,
  ForecastConfig,
  LeverAccent,
  LeverConfig,
  LeverFormat,
  LeverIcon,
  PerSegment,
  Recommendation,
  RecommendationBadge,
  SegmentMeta,
  SegmentMixLeverConfig,
  SerializableForecastConfig,
  SimulationResult,
} from "./types";

// ─── Generic constants ────────────────────────────────────────────────────────
export type { AccentColor } from "./constants";
export {
  CONFIDENCE_BAND_SPREAD,
  EPSILON,
  FLAT_FRONTLOAD,
  HOURS_PER_DAY,
} from "./constants";

// ─── Generic orchestration (the simulator harness + helpers) ─────────────────
export type { SimulateSetOptions } from "./engine";
export {
  buildDailySeries,
  clamp,
  clamp01,
  finite,
  safeDiv,
  scaleResultMoney,
  simulateSet,
} from "./engine";

// ─── Recommendations (reward-agnostic) ────────────────────────────────────────
export { describeTradeoff, recommend } from "./recommend";

// ─── Config helper ─────────────────────────────────────────────────────────────

import type {
  BaseAssumptions,
  BaseScenarioConfig,
  ForecastConfig,
  SerializableForecastConfig,
} from "./types";

/**
 * Project a full {@link ForecastConfig} down to its SERIALIZABLE half — dropping
 * every function member (`simulate`, `defaults`, `pacingFrontload`, `capLabel`,
 * `capComplexity`). The result is safe to pass as a prop across the Next 15 RSC
 * (server→client) boundary; the client island obtains the function members by
 * importing the reward's config module directly.
 */
export function toSerializableConfig<
  A extends BaseAssumptions,
  S extends BaseScenarioConfig,
>(config: ForecastConfig<A, S>): SerializableForecastConfig {
  return {
    rewardType: config.rewardType,
    label: config.label,
    scenarios: config.scenarios,
    baselineScenarioId: config.baselineScenarioId,
    whatifSet: config.whatifSet,
    segments: config.segments,
    levers: config.levers,
    segmentMixLever: config.segmentMixLever,
    colors: config.colors,
  };
}
