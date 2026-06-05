/**
 * Public surface of the affiliate commission forecast engine.
 *
 * Framework-agnostic (no React, no DB, no server-only). The UI island imports
 * from here; the engine internals stay private behind this barrel. Mirrors the
 * deposit-bonus reference barrel.
 */

// Types & models
export type {
  Assumptions,
  DailyPoint,
  ForecastBaseline,
  PerSegment,
  RatePolicy,
  RatePolicyKind,
  Recommendation,
  RecommendationBadge,
  ScenarioConfig,
  SimulationResult,
  TierId,
} from "./types";

// Constants (named assumptions — every coefficient the engine uses)
export type { AccentColor } from "./constants";
export {
  BASELINE_BLENDED_RATE,
  BASELINE_TIER_RATE,
  CONFIDENCE_BAND_SPREAD,
  DEFAULT_ACQUISITION_SENSITIVITY,
  DEFAULT_AVG_COMMISSION_USD,
  DEFAULT_CANNIBALIZATION_RATE,
  DEFAULT_CLAIM_PROBABILITY,
  DEFAULT_COMMISSION_RATE_MULT,
  DEFAULT_QUALIFICATION_ELASTICITY,
  DEFAULT_REFERRAL_QUALITY,
  DEFAULT_REFERRALS_PER_AFFILIATE,
  DEFAULT_RETENTION_UPLIFT,
  DEFAULT_TIER_MIX,
  DEFAULT_WINDOW_DAYS,
  TIER_BASE_LEAKAGE,
  TIER_IDS,
  TIERS,
} from "./constants";

// Engine (the simulator + exported pure helpers)
export {
  acquisitionLossFromTightening,
  blendedRate,
  buildDailySeries,
  cannibalizationAtRate,
  clamp,
  clamp01,
  costRetentionFromRate,
  effectiveRateForTier,
  frictionScore,
  leakageCaptureUnderPolicy,
  normalizeTierMix,
  policyFrontload,
  qualificationTightness,
  qualityScreen,
  rateCutSeverity,
  safeDiv,
  scaleResultMoney,
  simulate,
  simulateSet,
  thresholdMultiplier,
} from "./engine";

// Per-reward forecast config (the contract the shared UI + hub consume)
export {
  AFFILIATE_BASELINE_NOTE,
  AFFILIATE_FORECAST_CONFIG,
} from "./config";

// Recommendations (reward-agnostic — re-exported from the shared kit)
export { describeTradeoff, recommend } from "../../../_forecast-engine";

// Scenario library
export {
  AFFILIATE_WHATIF_SET,
  BASELINE_SCENARIO_ID,
  SCENARIO_A_CURRENT,
  SCENARIO_B_TRIM_10,
  SCENARIO_B_TRIM_20,
  SCENARIO_B_TRIM_30,
  SCENARIO_B_TRIM_40,
  SCENARIO_C_PROTECT_FUNNEL,
  SCENARIO_C_SQUEEZE_WHALES,
  SCENARIO_C_TRIM_TAIL,
  SCENARIO_D_QUAL_1_5,
  SCENARIO_D_QUAL_2,
  SCENARIO_D_QUAL_2_TRIM,
  SCENARIO_D_QUAL_3,
  SCENARIO_E_HYBRID,
  SCENARIO_E_HYBRID_STRICT,
  SCENARIO_LIBRARY,
} from "./scenarios";
