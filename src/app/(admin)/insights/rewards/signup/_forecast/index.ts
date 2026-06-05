/**
 * Public surface of the signup-bonus forecast engine.
 *
 * Framework-agnostic (no React, no DB, no server-only). The UI island imports
 * from here; the engine internals stay private behind this barrel. Mirrors the
 * deposit-bonus co-located-module idiom.
 */

// Types & models
export type {
  Assumptions,
  GrantKind,
  GrantRule,
  DailyPoint,
  ForecastBaseline,
  PerSegment,
  Recommendation,
  RecommendationBadge,
  ScenarioConfig,
  SegmentId,
  SimulationResult,
} from "./types";

// Constants (named assumptions — every coefficient the engine uses)
export type { AccentColor } from "./constants";
export {
  BASELINE_GRANT_USD,
  BASELINE_PER_USER_CAP_USD,
  CONFIDENCE_BAND_SPREAD,
  DEFAULT_ABUSE_SHARE,
  DEFAULT_AVG_BONUS_USD,
  DEFAULT_BREAKAGE_RATE,
  DEFAULT_CLAIM_PROBABILITY,
  DEFAULT_DEPOSIT_GATE_CAPTURE_ELASTICITY,
  DEFAULT_DEPOSITS_PER_USER_PER_WINDOW,
  DEFAULT_FTD_CONVERSION_RATE,
  DEFAULT_LEGIT_CONVERSION_SENSITIVITY,
  DEFAULT_RETENTION_UPLIFT,
  DEFAULT_SEGMENT_MIX,
  DEFAULT_WINDOW_DAYS,
  OVERGENEROUS_BREAKAGE_SLOPE,
  OVERGENEROUS_CAP_THRESHOLD_USD,
  SEGMENT_IDS,
  SEGMENTS,
} from "./constants";

// Engine (the simulator + exported pure helpers)
export {
  abuseCapture,
  breakageAtCap,
  buildDailySeries,
  clamp,
  clamp01,
  conversionLossFromGate,
  depositGatePassFraction,
  frictionScore,
  gateMinDepositUsd,
  grantForSegment,
  grantFrontload,
  hasDepositGate,
  isFtdSegment,
  nominalGrantUsd,
  normalizeSegmentMix,
  paidShareUnderGate,
  perUserCapUsd,
  retentionWeightForSegment,
  safeDiv,
  scaleResultMoney,
  segmentLevelUpShare,
  simulate,
  simulateSet,
} from "./engine";

// Presentational descriptors
export { grantComplexity, grantLogicLabel } from "./grant-format";

// Per-reward forecast config (the contract the shared UI + hub consume)
export { SIGNUP_BASELINE_NOTE, SIGNUP_FORECAST_CONFIG } from "./config";

// Recommendations
export { describeTradeoff, recommend } from "../../../_forecast-engine";

// Scenario library
export {
  BASELINE_SCENARIO_ID,
  GATED_WHATIF_SET,
  SCENARIO_A_BASELINE,
  SCENARIO_B_FLAT_10,
  SCENARIO_B_FLAT_7,
  SCENARIO_C_GATED_1,
  SCENARIO_C_GATED_5,
  SCENARIO_C_GATED_10,
  SCENARIO_C_GATED_20,
  SCENARIO_D_TIERED_LIGHT,
  SCENARIO_D_TIERED_RICH,
  SCENARIO_E_DYNAMIC,
  SCENARIO_E_DYNAMIC_GATED,
  SCENARIO_LIBRARY,
} from "./scenarios";
