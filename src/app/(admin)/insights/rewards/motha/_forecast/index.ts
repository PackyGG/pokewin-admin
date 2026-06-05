/**
 * Public surface of the MOTHA GIVEAWAYS forecast engine.
 *
 * Framework-agnostic (no React, no DB, no server-only). The UI island imports
 * from here; the engine internals stay private behind this barrel. Mirrors the
 * deposit-bonus reference's co-located-module idiom.
 */

// Types & models
export type {
  Assumptions,
  DailyPoint,
  ForecastBaseline,
  MothaChannel,
  PerSegment,
  Recommendation,
  RecommendationBadge,
  ScenarioConfig,
  SimulationResult,
} from "./types";
export { MOTHA_CHANNELS } from "./types";

// Constants (named assumptions — every coefficient the engine uses)
export type { AccentColor } from "./constants";
export {
  BASELINE_MULTIPLIER,
  CHANNEL_IDS,
  CHANNELS,
  CONFIDENCE_BAND_SPREAD,
  DEFAULT_AVG_GIVEAWAY_USD,
  DEFAULT_CLAIM_PROBABILITY,
  DEFAULT_ENGAGEMENT_UPLIFT,
  DEFAULT_GIVEAWAYS_PER_ACTIVE_DAY,
  DEFAULT_GOODWILL_SENSITIVITY,
  DEFAULT_WASTE_CAPTURE_ELASTICITY,
  DEFAULT_WASTE_SHARE,
  DEFAULT_WINDOW_DAYS,
} from "./constants";

// Engine (the simulator + exported pure helpers)
export {
  buildDailySeries,
  channelRetention,
  clamp,
  clamp01,
  communityFrictionScore,
  giveawayFrontload,
  liveChannelKeep,
  normalizeChannelSplit,
  safeDiv,
  scaleResultMoney,
  simulate,
  simulateSet,
  totalSpendReduction,
} from "./engine";

// Per-reward forecast config (the contract the shared UI + hub consume)
export {
  MOTHA_BASELINE_NOTE,
  MOTHA_FORECAST_CONFIG,
  type MothaForecastBaseline,
} from "./config";

// Recommendations (re-exported from the shared kit for symmetry)
export { describeTradeoff, recommend } from "../../../_forecast-engine";

// Scenario library
export {
  BASELINE_SCENARIO_ID,
  MOTHA_WHATIF_SET,
  SCENARIO_A_BASELINE,
  SCENARIO_LIBRARY,
} from "./scenarios";
