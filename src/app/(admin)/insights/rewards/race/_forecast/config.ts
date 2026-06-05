/**
 * config.ts — the race-prize {@link ForecastConfig}.
 *
 * Binds race's pure engine (`simulate`), its scenario library, its position-tier
 * segments, its tunable levers, and its house-POV accents into the single
 * serializable-plus-`simulate` object the shared UI island (`_forecast-ui`) and
 * the unified hub (`insights/forecast`) consume. Mirrors the deposit-bonus
 * reference (`deposit-bonus/_forecast/config.ts`) verbatim in SHAPE — only the
 * race-specific levers / defaults / labels differ.
 *
 * ── Serialization (Next 15 RSC boundary) ────────────────────────────────────
 * Everything here EXCEPT the function members (`simulate`, `defaults`,
 * `pacingFrontload`, `capLabel`, `capComplexity`) is plain serializable data.
 * The hub's server component passes the SERIALIZABLE projection
 * (`toSerializableConfig(...)`) + the real baseline into the client island; the
 * island imports `RACE_FORECAST_CONFIG` directly to obtain `simulate` (a pure
 * module fn) — it is NEVER passed as a server→client prop.
 */

import type { ForecastConfig, LeverConfig } from "../../../_forecast-engine";

import {
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
  SEGMENTS,
} from "./constants";
import { policyFrontload, simulate } from "./engine";
import { operationalComplexity, policyLogicLabel } from "../_components/forecast-format";
import { BASELINE_SCENARIO_ID, RACE_WHATIF_SET, SCENARIO_LIBRARY } from "./scenarios";
import type { Assumptions, ScenarioConfig } from "./types";

/**
 * The tunable sliders, in display order. `groupBreak` inserts a divider before
 * the lever (separating the volume / structural block from the behavioural
 * block). The generic controls render a shadcn Slider + numeric Input per lever
 * and map the `icon` key + `format` enum to the house glyph / formatter.
 */
const RACE_LEVERS: LeverConfig[] = [
  // ── Volume / structural levers ──
  {
    key: "prizePoolMultiplier",
    label: "Prize-pool multiplier",
    hint: "Global pool size vs today (1× = current), stacked on top of the selected scenario. Scales total prize spend and the per-winner prize.",
    icon: "coins",
    min: 0,
    max: 3,
    step: 0.05,
    format: "multiplier",
  },
  {
    key: "tierSteepness",
    label: "Tier steepness",
    hint: "How top-heavy the prize curve is (1× = current). >1 concentrates spend on the champion + podium; <1 flattens toward the tail. Pool-neutral — only moves WHERE the dollars land.",
    icon: "trending-down",
    min: 0.2,
    max: 2.5,
    step: 0.05,
    format: "multiplier",
  },
  {
    key: "raceCadenceMultiplier",
    label: "Race cadence",
    hint: "How often races run vs today (1× = current frequency). Scales the modeled race count → total spend. Faster cadence raises grind friction.",
    icon: "calendar-range",
    min: 0,
    max: 3,
    step: 0.05,
    format: "multiplier",
  },
  {
    key: "depositsPerUserPerWindow",
    label: "Entries / winner / race",
    hint: "Baseline qualifying participations per winning user within one race window. Context for the engagement model.",
    icon: "repeat",
    min: 0,
    max: 5,
    step: 0.1,
    format: "number",
    decimals: 1,
  },
  {
    key: "claimProbability",
    label: "Win probability",
    hint: "P(places for a prize | entered). Defaults to the REAL measured ratio (winners ÷ entrants) for the selected period; tunable for what-if. Scales the real winner volume relative to that default.",
    icon: "percent",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
  {
    key: "avgBonusUsd",
    label: "Avg prize / winner (USD)",
    hint: "Baseline average prize per winner. The engine scales this by the effective pool factor and splits it across the tier curve.",
    icon: "coins",
    min: 0,
    max: 500,
    step: 1,
    format: "currency",
  },
  // ── Behavioural levers ──
  {
    key: "deadweightShare",
    label: "Dead-weight share",
    hint: "Share of prize $ paid to winners who never wager it back (one-off / churned winners). The race analog of leakage — a tighter / steeper pool reduces it. DEMO assumption.",
    icon: "shield-alert",
    min: 0,
    max: 0.6,
    step: 0.01,
    format: "percent",
    accent: "amber",
    groupBreak: true,
  },
  {
    key: "leakageCaptureElasticity",
    label: "Leakage-capture elasticity",
    hint: "How strongly a tighter / steeper pool suppresses dead-weight leakage (1 = fully elastic). Higher → restructuring kills more wasted spend.",
    icon: "shield-alert",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
    accent: "amber",
  },
  {
    key: "retentionUplift",
    label: "Retention uplift",
    hint: "Incremental retained downstream wager revenue per $1 of prize to engaged winners. Higher → prizes pay back more downstream.",
    icon: "hand-coins",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
    accent: "emerald",
  },
  {
    key: "cannibalizationRate",
    label: "Cannibalization rate",
    hint: "Share of prize paid to players who'd have wagered anyway. Rises further above a 1× pool (over-generous).",
    icon: "magnet",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
  {
    key: "engagementSensitivity",
    label: "Engagement sensitivity",
    hint: "Participation lost per unit of pool shrink. Higher → tighter pools sacrifice more competitive engagement → net savings < gross.",
    icon: "gauge",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
];

/**
 * Seed the levers from the REAL baseline. The DATA ANCHORS — winner volume
 * (`baselineClaimants` over `baselinePeriodDays`), win probability and avg prize
 * — default to the measured production figures. The STRUCTURAL multipliers
 * default to neutral (1×, so the initial state reproduces the baseline) and the
 * BEHAVIOURAL levers seed from their named coefficient defaults; all stay tunable
 * for what-if.
 *
 * Win probability defaults to the real measured ratio when available, falling
 * back to the named seed only when the real ratio is null (no entrants). The same
 * real ratio is stored as `baselineClaimProbability` so the engine treats the
 * default lever as neutral (volume == the real winner count).
 *
 * The segment mix defaults to the real per-tier WINNER-COUNT share when the
 * server supplies it via the baseline note path; absent that it falls back to the
 * demo mix. (The server tab passes the measured mix through `realBaseline` →
 * `defaults` cannot read it directly, so the demo mix is the seed and the server
 * overrides the position distribution by re-seeding the mix lever — see the
 * forecast tab.)
 */
const raceDefaults: ForecastConfig<Assumptions, ScenarioConfig>["defaults"] = (baseline) => {
  const realClaimProb = baseline.claimProbability ?? DEFAULT_CLAIM_PROBABILITY;
  return {
    baselineClaimants: baseline.uniqueClaimants,
    baselinePeriodDays: Math.max(1, baseline.periodDays),
    baselineClaimProbability: realClaimProb,
    segmentMix: { ...DEFAULT_SEGMENT_MIX },
    prizePoolMultiplier: DEFAULT_PRIZE_POOL_MULTIPLIER,
    tierSteepness: DEFAULT_TIER_STEEPNESS,
    raceCadenceMultiplier: DEFAULT_RACE_CADENCE_MULTIPLIER,
    depositsPerUserPerWindow: DEFAULT_DEPOSITS_PER_USER_PER_WINDOW,
    claimProbability: realClaimProb,
    avgBonusUsd: baseline.avgBonusUsd,
    deadweightShare: DEFAULT_DEADWEIGHT_SHARE,
    leakageCaptureElasticity: DEFAULT_LEAKAGE_CAPTURE_ELASTICITY,
    retentionUplift: DEFAULT_RETENTION_UPLIFT,
    cannibalizationRate: DEFAULT_CANNIBALIZATION_RATE,
    engagementSensitivity: DEFAULT_ENGAGEMENT_SENSITIVITY,
    windowDays: DEFAULT_WINDOW_DAYS,
  };
};

/** The race-prize forecast config — the per-reward contract for the hub + UI. */
export const RACE_FORECAST_CONFIG: ForecastConfig<Assumptions, ScenarioConfig> = {
  rewardType: "race",
  label: "Race prizes",
  scenarios: SCENARIO_LIBRARY,
  baselineScenarioId: BASELINE_SCENARIO_ID,
  whatifSet: RACE_WHATIF_SET,
  segments: SEGMENTS.map((s) => ({ id: s.id, label: s.label, accent: s.accent })),
  defaults: raceDefaults,
  levers: RACE_LEVERS,
  segmentMixLever: { key: "segmentMix", label: "Position-tier mix" },
  colors: { hero: "rose", cost: "rose", leakage: "amber", retained: "emerald" },
  simulate,
  pacingFrontload: (sc) => policyFrontload(sc.policy, 1),
  capLabel: (sc) => policyLogicLabel(sc.policy),
  capComplexity: (sc) => operationalComplexity(sc.policy),
};

/**
 * A short, human "real baseline" sub-label for the active period, e.g.
 * "Real pool · current curve". Used in the KPI strip. Kept here (not in the
 * generic UI) because the baseline-policy string is reward-specific.
 */
export const RACE_BASELINE_NOTE = "Real pool · current curve";
