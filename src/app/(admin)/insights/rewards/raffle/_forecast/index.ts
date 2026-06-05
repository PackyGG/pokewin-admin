/**
 * Public surface of the RAFFLE forecast engine.
 *
 * Framework-agnostic (no React, no DB, no server-only). The UI island + the
 * server tab import from here; the engine internals stay behind this barrel.
 * Mirrors the deposit-bonus reference barrel.
 */

// Types & models
export type {
  Assumptions,
  DailyPoint,
  ForecastBaseline,
  PerSegment,
  PolicyKind,
  RafflePolicy,
  Recommendation,
  RecommendationBadge,
  ScenarioConfig,
  SegmentId,
  SimulationResult,
} from "./types";

// Constants (named assumptions)
export type { AccentColor } from "./constants";
export {
  BASELINE_FREQUENCY_MULT,
  BASELINE_PRIZE_POOL_MULT,
  BASELINE_TICKET_RATE_MULT,
  CONFIDENCE_BAND_SPREAD,
  DEFAULT_AVG_PRIZE_USD,
  DEFAULT_BREAKAGE_RATE,
  DEFAULT_CANNIBALIZATION_RATE,
  DEFAULT_CLAIM_PROBABILITY,
  DEFAULT_FARMING_CAPTURE_ELASTICITY,
  DEFAULT_FARMING_SHARE,
  DEFAULT_PARTICIPATION_SENSITIVITY,
  DEFAULT_RETENTION_UPLIFT,
  DEFAULT_SEGMENT_MIX,
  DEFAULT_WINDOW_DAYS,
  OVERGENEROUS_CANNIBALIZATION_SLOPE,
  OVERGENEROUS_POOL_MULT_THRESHOLD,
  SEGMENT_IDS,
  SEGMENTS,
} from "./constants";

// Engine (the simulator + exported pure helpers)
export {
  buildDailySeries,
  cannibalizationAtPool,
  clamp,
  clamp01,
  costFactor,
  farmingCaptureUnderTighterRate,
  frequencyMult,
  frictionScore,
  normalizeSegmentMix,
  participationLossFromTightening,
  policyFrontload,
  prizePoolMult,
  rateTightness,
  safeDiv,
  scaleResultMoney,
  simulate,
  simulateSet,
  ticketRateMult,
} from "./engine";

// Per-reward forecast config (the contract the shared UI + hub consume)
export {
  RAFFLE_BASELINE_NOTE,
  RAFFLE_FORECAST_CONFIG,
  operationalComplexity,
  policyLogicLabel,
} from "./config";

// Scenario library
export {
  BASELINE_SCENARIO_ID,
  RAFFLE_WHATIF_SET,
  SCENARIO_A_BASELINE,
  SCENARIO_B_POOL_050,
  SCENARIO_B_POOL_150,
  SCENARIO_C_FREQ_050,
  SCENARIO_C_FREQ_200,
  SCENARIO_D_RATE_050,
  SCENARIO_D_RATE_150,
  SCENARIO_E_BALANCED,
  SCENARIO_E_GROWTH,
  SCENARIO_E_LEAN,
  SCENARIO_LIBRARY,
} from "./scenarios";
