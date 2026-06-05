/**
 * config.ts — the deposit-bonus {@link ForecastConfig}.
 *
 * This is the REFERENCE implementation of the per-reward forecast contract: it
 * binds deposit-bonus's pure engine (`simulate`), its scenario library, its
 * segments, its tunable levers, and its house-POV accents into the single
 * serializable-plus-`simulate` object the shared UI island (`_forecast-ui`) and
 * the unified hub (`insights/forecast`) consume.
 *
 * Every reward forecast provides a module exactly like this. The fan-out wave
 * copies this file's SHAPE (not its cap-specific math) for each new reward.
 *
 * ── Serialization (Next 15 RSC boundary) ────────────────────────────────────
 * Everything here EXCEPT the function members (`simulate`, `defaults`,
 * `pacingFrontload`, `capLabel`, `capComplexity`) is plain serializable data.
 * The hub's server component passes the SERIALIZABLE projection
 * (`toSerializableConfig(...)`) + the real baseline into the client island; the
 * island imports `DEPOSIT_BONUS_FORECAST_CONFIG` directly to obtain `simulate`
 * (a pure module fn) — it is NEVER passed as a server→client prop.
 */

import type { ForecastConfig, LeverConfig } from "../../../_forecast-engine";

import {
  BASELINE_CAP_USD,
  BASELINE_WINDOW_HOURS,
  DEFAULT_ABUSE_CAPTURE_ELASTICITY,
  DEFAULT_ABUSE_SHARE,
  DEFAULT_BREAKAGE_RATE,
  DEFAULT_CANNIBALIZATION_RATE,
  DEFAULT_CLAIM_PROBABILITY,
  DEFAULT_DEPOSITS_PER_USER_PER_WINDOW,
  DEFAULT_LEGIT_CONVERSION_SENSITIVITY,
  DEFAULT_RETENTION_UPLIFT,
  DEFAULT_SEGMENT_MIX,
  DEFAULT_WINDOW_DAYS,
  SEGMENTS,
} from "./constants";
import { capFrontload, simulate } from "./engine";
import { capLogicLabel, operationalComplexity } from "../_components/forecast-format";
import {
  BASELINE_SCENARIO_ID,
  SCENARIO_LIBRARY,
  SPLIT_CAP_WHATIF_SET,
} from "./scenarios";
import type { Assumptions, ScenarioConfig } from "./types";

/**
 * The tunable sliders, in display order. `groupBreak` inserts a divider before
 * the lever (separating the volume block from the behavioural block). The
 * generic controls render a shadcn Slider + numeric Input per lever and map the
 * `icon` key + `format` enum to the house glyph / formatter.
 */
const DEPOSIT_BONUS_LEVERS: LeverConfig[] = [
  // ── Volume levers ──
  {
    key: "depositsPerUserPerWindow",
    label: "Deposits / user / window",
    hint: "Baseline deposit frequency per claiming user within one cap window. Drives the effective per-day ceiling each cap policy imposes.",
    icon: "repeat",
    min: 0,
    max: 5,
    step: 0.1,
    format: "number",
    decimals: 1,
  },
  {
    key: "claimProbability",
    label: "Claim probability",
    hint: "P(claims a bonus | deposited). Defaults to the REAL measured ratio (claimants ÷ depositors) for the selected period; tunable for what-if. Scales the real claimant volume relative to that default.",
    icon: "percent",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
  {
    key: "avgBonusUsd",
    label: "Avg bonus (USD)",
    hint: "Baseline average bonus before the cap clamp. The engine clamps this to each segment's effective cap.",
    icon: "coins",
    min: 0,
    max: 250,
    step: 1,
    format: "currency",
  },
  // ── Behavioural levers ──
  {
    key: "abuseShare",
    label: "Abuse share",
    hint: "Share of claimants behaving abusively AT the baseline cap. DEMO assumption — this is a tunable scenario input, not a fraud prediction.",
    icon: "shield-alert",
    min: 0,
    max: 0.5,
    step: 0.01,
    format: "percent",
    accent: "amber",
    groupBreak: true,
  },
  {
    key: "abuseCaptureElasticity",
    label: "Abuse-capture elasticity",
    hint: "How strongly stricter caps suppress abuse (1 = fully elastic). Higher → tightening kills more leakage.",
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
    hint: "Incremental retained revenue per $1 of legit bonus. Higher → bonuses pay back more downstream.",
    icon: "hand-coins",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
    accent: "emerald",
  },
  {
    key: "breakageRate",
    label: "Breakage rate",
    hint: "Share of awarded bonus never wagered (expired / unused). Shrinks the retention base — the bonus is still a cost.",
    icon: "percent",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
  {
    key: "cannibalizationRate",
    label: "Cannibalization rate",
    hint: "Share of bonus paid to users who'd have deposited anyway. Rises further above a $150 cap (over-generous).",
    icon: "magnet",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
  {
    key: "legitConversionSensitivity",
    label: "Legit conversion sensitivity",
    hint: "Legit conversion lost per unit of cap tightening. Higher → stricter caps sacrifice more genuine signups → net savings < gross.",
    icon: "gauge",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
];

/**
 * Seed the levers from the REAL baseline. The DATA ANCHORS — claimant volume
 * (`baselineClaimants` over `baselinePeriodDays`), claim probability and avg
 * bonus — default to the measured production figures. The BEHAVIOURAL levers
 * seed from their named coefficient defaults and stay tunable for what-if.
 *
 * Claim probability defaults to the real measured ratio when available, falling
 * back to the named seed only when the real ratio is null (no depositors). The
 * same real ratio is stored as `baselineClaimProbability` so the engine treats
 * the default lever as neutral (volume == the real claimant count).
 */
const depositBonusDefaults: ForecastConfig<Assumptions, ScenarioConfig>["defaults"] = (
  baseline,
) => {
  const realClaimProb = baseline.claimProbability ?? DEFAULT_CLAIM_PROBABILITY;
  return {
    baselineClaimants: baseline.uniqueClaimants,
    baselinePeriodDays: Math.max(1, baseline.periodDays),
    baselineClaimProbability: realClaimProb,
    segmentMix: { ...DEFAULT_SEGMENT_MIX },
    depositsPerUserPerWindow: DEFAULT_DEPOSITS_PER_USER_PER_WINDOW,
    claimProbability: realClaimProb,
    avgBonusUsd: baseline.avgBonusUsd,
    breakageRate: DEFAULT_BREAKAGE_RATE,
    abuseShare: DEFAULT_ABUSE_SHARE,
    abuseCaptureElasticity: DEFAULT_ABUSE_CAPTURE_ELASTICITY,
    retentionUplift: DEFAULT_RETENTION_UPLIFT,
    cannibalizationRate: DEFAULT_CANNIBALIZATION_RATE,
    legitConversionSensitivity: DEFAULT_LEGIT_CONVERSION_SENSITIVITY,
    windowDays: DEFAULT_WINDOW_DAYS,
  };
};

/** The deposit-bonus forecast config — the reference per-reward contract. */
export const DEPOSIT_BONUS_FORECAST_CONFIG: ForecastConfig<Assumptions, ScenarioConfig> = {
  rewardType: "deposit-bonus",
  label: "Deposit bonus",
  scenarios: SCENARIO_LIBRARY,
  baselineScenarioId: BASELINE_SCENARIO_ID,
  whatifSet: SPLIT_CAP_WHATIF_SET,
  segments: SEGMENTS.map((s) => ({ id: s.id, label: s.label, accent: s.accent })),
  defaults: depositBonusDefaults,
  levers: DEPOSIT_BONUS_LEVERS,
  segmentMixLever: { key: "segmentMix", label: "Segment mix" },
  colors: { hero: "rose", cost: "rose", leakage: "amber", retained: "emerald" },
  simulate,
  pacingFrontload: (sc) => capFrontload(sc.cap),
  capLabel: (sc) => capLogicLabel(sc.cap),
  capComplexity: (sc) => operationalComplexity(sc.cap),
};

/**
 * A short, human "real baseline" sub-label for the active period, e.g.
 * "$100/24h baseline". Used in the KPI strip. Kept here (not in the generic UI)
 * because the baseline-policy string is reward-specific.
 */
export const DEPOSIT_BONUS_BASELINE_NOTE = `$${BASELINE_CAP_USD}/${BASELINE_WINDOW_HOURS}h`;
