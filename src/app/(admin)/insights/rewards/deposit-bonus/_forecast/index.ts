/**
 * Public surface of the deposit-bonus forecast engine.
 *
 * Framework-agnostic (no React, no DB, no server-only). The UI island imports
 * from here; the engine internals stay private behind this barrel. Mirrors the
 * edge-calc co-located-module idiom.
 */

// Types & models
export type {
  Assumptions,
  CapKind,
  CapRule,
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
  BASELINE_CAP_USD,
  BASELINE_WINDOW_HOURS,
  BASELINE_WINDOWS_PER_DAY,
  CONFIDENCE_BAND_SPREAD,
  DEFAULT_ABUSE_CAPTURE_ELASTICITY,
  DEFAULT_ABUSE_SHARE,
  DEFAULT_AVG_BONUS_USD,
  DEFAULT_BREAKAGE_RATE,
  DEFAULT_CANNIBALIZATION_RATE,
  DEFAULT_CLAIM_PROBABILITY,
  DEFAULT_DEPOSITS_PER_USER_PER_WINDOW,
  DEFAULT_LEGIT_CONVERSION_SENSITIVITY,
  DEFAULT_RETENTION_UPLIFT,
  DEFAULT_SEGMENT_MIX,
  DEFAULT_WINDOW_DAYS,
  FRICTION_W_CAP_LOWNESS,
  FRICTION_W_DECAY,
  FRICTION_W_WINDOW_TIGHTNESS,
  OVERGENEROUS_CANNIBALIZATION_SLOPE,
  OVERGENEROUS_CAP_THRESHOLD_USD,
  SEGMENT_IDS,
  SEGMENTS,
  SPLIT_CAP_BURST_DAMPING,
} from "./constants";

// Engine (the simulator + exported pure helpers)
export {
  abuseCaptureUnderStricterCap,
  buildDailySeries,
  cannibalizationAtCap,
  capFrontload,
  capWindowHours,
  clamp,
  clamp01,
  clampBonus,
  conversionLossFromTightening,
  effectiveCapForSegment,
  effectiveDailyCeilingForSegment,
  effectiveDailyCeilingUsd,
  frictionScore,
  nominalCapUsd,
  normalizeSegmentMix,
  payoutRetentionFromCeiling,
  safeDiv,
  scaleResultMoney,
  simulate,
  simulateSet,
  tightnessVsBaseline,
  windowsPerDay,
} from "./engine";

// Per-reward forecast config (the contract the shared UI + hub consume)
export {
  DEPOSIT_BONUS_BASELINE_NOTE,
  DEPOSIT_BONUS_FORECAST_CONFIG,
} from "./config";

// Recommendations
export { describeTradeoff, recommend } from "./recommend";

// Edge Plan 2.0 bridge (additive, owner spec #8) — runs THIS engine with the
// forecast page's assumptions builder for the time-based bonus block.
export {
  findSplitCapLibraryScenario,
  projectSplitCapVsBaseline,
} from "./edge-plan-projection";
export type { SplitCapEngineProjection } from "./edge-plan-projection";

// Scenario library
export {
  BASELINE_SCENARIO_ID,
  SCENARIO_A_BASELINE,
  SCENARIO_B_HOURLY_10,
  SCENARIO_B_HOURLY_5,
  SCENARIO_C_SIXH_15,
  SCENARIO_C_SIXH_20,
  SCENARIO_D_HYBRID,
  SCENARIO_E_50_12H,
  SCENARIO_E_75_24H,
  SCENARIO_E_DAILY_50,
  SCENARIO_E_PROGRESSIVE_DECAY,
  SCENARIO_E_WEEKLY_POOLED,
  SCENARIO_LIBRARY,
  SPLIT_CAP_WHATIF_SET,
} from "./scenarios";
