/**
 * Public surface of the RACE-PRIZE forecast engine.
 *
 * Framework-agnostic (no React, no DB, no server-only). The UI island imports
 * from here; the engine internals stay private behind this barrel. Mirrors the
 * deposit-bonus reference co-located-module idiom.
 */

// Types & models
export type {
  Assumptions,
  DailyPoint,
  ForecastBaseline,
  PerSegment,
  RacePolicy,
  RacePolicyKind,
  Recommendation,
  RecommendationBadge,
  ScenarioConfig,
  SegmentId,
  SimulationResult,
} from "./types";

// Constants (named assumptions — every coefficient the engine uses)
export type { AccentColor } from "./constants";
export {
  BASELINE_TIER_SHARE,
  BASELINE_TOP_SHARE,
  CONFIDENCE_BAND_SPREAD,
  DEFAULT_AVG_BONUS_USD,
  DEFAULT_CANNIBALIZATION_RATE,
  DEFAULT_CLAIM_PROBABILITY,
  DEFAULT_DEADWEIGHT_SHARE,
  DEFAULT_DEPOSITS_PER_USER_PER_WINDOW,
  DEFAULT_ENGAGEMENT_SENSITIVITY,
  DEFAULT_LEAKAGE_CAPTURE_ELASTICITY,
  DEFAULT_PRIZE_POOL_MULTIPLIER,
  DEFAULT_RACE_CADENCE_MULTIPLIER,
  DEFAULT_RETENTION_UPLIFT,
  DEFAULT_SEGMENT_MIX,
  DEFAULT_TIER_STEEPNESS,
  DEFAULT_WINDOW_DAYS,
  FRICTION_W_CADENCE,
  FRICTION_W_POOL_SHRINK,
  FRICTION_W_STEEPNESS,
  OVERGENEROUS_CANNIBALIZATION_SLOPE,
  OVERGENEROUS_POOL_THRESHOLD,
  SEGMENT_IDS,
  SEGMENTS,
  TIER_LEAK_WEIGHT,
  TIER_RANK_WEIGHT,
} from "./constants";

// Engine (the simulator + exported pure helpers)
export {
  buildDailySeries,
  cannibalizationAtPool,
  clamp,
  clamp01,
  effectiveTopShare,
  engagementLossFromTightening,
  finite,
  frictionScore,
  leakageCaptureUnderTighterPolicy,
  normalizeSegmentMix,
  policyCadenceMult,
  policyFrontload,
  policyPoolFactor,
  policySteepness,
  policyTotalSpendFactor,
  safeDiv,
  scaleResultMoney,
  simulate,
  simulateSet,
  tierShareAtSteepness,
  tightnessVsBaseline,
} from "./engine";

// Per-reward forecast config (the contract the shared UI + hub consume)
export { RACE_BASELINE_NOTE, RACE_FORECAST_CONFIG } from "./config";

// Recommendations (re-exported from the shared kit for convenience)
export { describeTradeoff, recommend } from "../../../_forecast-engine";

// Scenario library
export {
  BASELINE_SCENARIO_ID,
  RACE_WHATIF_SET,
  SCENARIO_A_BASELINE,
  SCENARIO_B_POOL_40,
  SCENARIO_B_POOL_60,
  SCENARIO_B_POOL_75,
  SCENARIO_B_POOL_125,
  SCENARIO_B_POOL_150,
  SCENARIO_C_FLAT_05,
  SCENARIO_C_FLAT_07,
  SCENARIO_C_STEEP_14,
  SCENARIO_C_STEEP_18,
  SCENARIO_D_CADENCE_025,
  SCENARIO_D_CADENCE_050,
  SCENARIO_D_CADENCE_150,
  SCENARIO_D_CADENCE_200,
  SCENARIO_E_REDUCE_10,
  SCENARIO_E_REDUCE_25,
  SCENARIO_E_REDUCE_40,
  SCENARIO_LIBRARY,
} from "./scenarios";
