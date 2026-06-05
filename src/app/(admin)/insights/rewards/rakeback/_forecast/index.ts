/**
 * Public surface of the RAKEBACK forecast engine.
 *
 * Framework-agnostic (no React, no DB, no server-only). The UI island imports
 * from here; the engine internals stay private behind this barrel. Mirrors the
 * deposit-bonus reference barrel.
 */

// Types & models
export type {
  Assumptions,
  ClaimCadence,
  DailyPoint,
  ForecastBaseline,
  PerSegment,
  RatePolicy,
  RatePolicyKind,
  Recommendation,
  RecommendationBadge,
  ScenarioConfig,
  SegmentId,
  SimulationResult,
} from "./types";

// Constants (named assumptions — every coefficient the engine uses)
export type { AccentColor } from "./constants";
export {
  BASELINE_CADENCE,
  BASELINE_RATE_FALLBACK,
  CADENCE_BREAKAGE_MULT,
  CONFIDENCE_BAND_SPREAD,
  DEFAULT_BREAKAGE_RATE,
  DEFAULT_CLAIM_PROBABILITY,
  DEFAULT_DEPOSITS_PER_USER_PER_WINDOW,
  DEFAULT_FARM_CAPTURE_ELASTICITY,
  DEFAULT_FARMED_WAGER_SHARE,
  DEFAULT_RATE_CONVERSION_SENSITIVITY,
  DEFAULT_RETENTION_UPLIFT,
  DEFAULT_SEGMENT_MIX,
  DEFAULT_WAGER_ELASTICITY,
  DEFAULT_WINDOW_DAYS,
  EXPIRY_BREAKAGE_MAX,
  FRICTION_W_CADENCE,
  FRICTION_W_EXPIRY,
  FRICTION_W_RATE_LOWNESS,
  MAX_TIER_RANK,
  OVERGENEROUS_FARM_SLOPE,
  OVERGENEROUS_RATE_THRESHOLD,
  SEGMENT_IDS,
  SEGMENT_TIER_RANK,
  SEGMENTS,
} from "./constants";

// Engine (the simulator + exported pure helpers)
export {
  blendedEffectiveRate,
  buildDailySeries,
  clamp,
  clamp01,
  conversionLossFromRateCut,
  effectiveBreakage,
  effectiveRateForSegment,
  expiryBreakageComponent,
  farmCaptureUnderLowerRate,
  farmedShareAtRate,
  finite,
  frictionScore,
  normalizeSegmentMix,
  policyCadence,
  policyFrontload,
  rateLoosenessVsBaseline,
  rateTightnessVsBaseline,
  safeDiv,
  scaleResultMoney,
  simulate,
  simulateSet,
  wagerMultiplier,
} from "./engine";

// Per-reward forecast config (the contract the shared UI + hub consume)
export { RAKEBACK_BASELINE_NOTE, RAKEBACK_FORECAST_CONFIG } from "./config";

// Live-policy derivation from the REAL rakeback_config (baseline + what-ifs).
export {
  buildRakebackScenarios,
  rakebackBaselineNote,
  realHeadlineRate,
  type RakebackBaselineExt,
  type RakebackCadenceConfig,
} from "./live-policy";

// Recommendations (re-exported from the shared kit for symmetry)
export { describeTradeoff, recommend } from "../../../_forecast-engine";

// Scenario library
export {
  BASELINE_SCENARIO_ID,
  RATE_WHATIF_SET,
  SCENARIO_A_BASELINE,
  SCENARIO_B_FLAT_3,
  SCENARIO_B_FLAT_4,
  SCENARIO_B_FLAT_6,
  SCENARIO_B_FLAT_7,
  SCENARIO_C_TIERED,
  SCENARIO_C_TIERED_GENEROUS,
  SCENARIO_C_TIERED_STRICT,
  SCENARIO_D_TAPER,
  SCENARIO_D_TAPER_STEEP,
  SCENARIO_E_EXPIRY_7,
  SCENARIO_E_EXPIRY_14,
  SCENARIO_E_MONTHLY,
  SCENARIO_E_TIERED_WEEKLY,
  SCENARIO_E_WEEKLY,
  SCENARIO_LIBRARY,
} from "./scenarios";
