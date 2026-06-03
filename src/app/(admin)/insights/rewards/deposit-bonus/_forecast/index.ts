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
  DEFAULT_ELIGIBLE_USERS,
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
  capWindowHours,
  clamp,
  clamp01,
  clampBonus,
  conversionLossFromTightening,
  effectiveCapForSegment,
  frictionScore,
  nominalCapUsd,
  normalizeSegmentMix,
  safeDiv,
  simulate,
  simulateSet,
  tightnessVsBaseline,
  windowMultiplier,
  windowsInHorizon,
} from "./engine";

// Recommendations
export { describeTradeoff, recommend } from "./recommend";

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

// Demo data (clearly DEMO — see file header)
export {
  buildDemoBaseline,
  DEMO_BASELINE,
  DEMO_DAYS,
  DEMO_ELIGIBLE_POPULATION,
  DEMO_SEED,
  seeded,
} from "./demo-data";
export type { DemoBaseline, DemoDailyPoint, DemoSegmentCohort } from "./demo-data";
