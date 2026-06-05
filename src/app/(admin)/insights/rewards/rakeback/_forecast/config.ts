/**
 * config.ts — the rakeback {@link ForecastConfig}.
 *
 * Binds rakeback's pure engine (`simulate`), its scenario library, its wager-
 * tier segments, its tunable levers, and its house-POV accents into the single
 * serializable-plus-`simulate` object the shared UI island (`_forecast-ui`) and
 * the unified hub (`insights/forecast`) consume. Copies the SHAPE of the
 * deposit-bonus reference config (not its cap-specific math).
 *
 * ── Serialization (Next 15 RSC boundary) ────────────────────────────────────
 * Everything here EXCEPT the function members (`simulate`, `defaults`,
 * `pacingFrontload`, `capLabel`, `capComplexity`) is plain serializable data.
 * The hub's server component passes the SERIALIZABLE projection
 * (`toSerializableConfig(...)`) + the real baseline into the client island; the
 * island imports `RAKEBACK_FORECAST_CONFIG` directly to obtain `simulate`
 * (a pure module fn) — it is NEVER passed as a server→client prop.
 */

import type { ForecastConfig, LeverConfig } from "../../../_forecast-engine";

import {
  BASELINE_CADENCE,
  BASELINE_RATE_FALLBACK,
  DEFAULT_CLAIM_PROBABILITY,
  DEFAULT_BREAKAGE_RATE,
  DEFAULT_DEPOSITS_PER_USER_PER_WINDOW,
  DEFAULT_FARM_CAPTURE_ELASTICITY,
  DEFAULT_FARMED_WAGER_SHARE,
  DEFAULT_PRE_CLAIM_ADOPTION,
  DEFAULT_PRE_CLAIM_DISCOUNT,
  DEFAULT_RATE_CONVERSION_SENSITIVITY,
  DEFAULT_RETENTION_UPLIFT,
  DEFAULT_SEGMENT_MIX,
  DEFAULT_WAGER_ELASTICITY,
  DEFAULT_WINDOW_DAYS,
  SEGMENTS,
} from "./constants";
import { policyFrontload, simulate } from "./engine";
import { operationalComplexity, rateLogicLabel } from "../_components/forecast-format";
import { buildRakebackScenarios } from "./live-policy";
import { BASELINE_SCENARIO_ID, RATE_WHATIF_SET, SCENARIO_LIBRARY } from "./scenarios";
import type { Assumptions, ScenarioConfig } from "./types";

/**
 * The tunable sliders, in display order. `groupBreak` inserts a divider before
 * the lever (separating the volume / rate block from the behavioural block).
 * The generic controls render a shadcn Slider + numeric Input per lever and map
 * the `icon` key + `format` enum to the house glyph / formatter.
 *
 * Note: the headline RATE itself is not a free slider here — it is set by the
 * chosen scenario's policy (flat / tiered / taper). The levers tune the
 * BEHAVIOURAL response (breakage, farming, retention, elasticity) and the
 * volume anchors (claim probability, qualifying frequency), plus the wager mix.
 */
const RAKEBACK_LEVERS: LeverConfig[] = [
  // ── Volume levers ──
  {
    key: "depositsPerUserPerWindow",
    label: "Qualifying events / user / window",
    hint: "Baseline qualifying-play frequency per claiming user within one cadence window. Context for the per-claimant volume split.",
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
    hint: "P(claims rakeback | qualified). Defaults to the REAL measured ratio when available, else a tunable seed. Scales the real claimant volume relative to that default.",
    icon: "percent",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
  // ── Behavioural levers ──
  {
    key: "breakageRate",
    label: "Breakage rate",
    hint: "Share of accrued rakeback never claimed (expired / abandoned). Cadence + expiry policies scale this up. Lowers REALIZED cost — the accrual is forfeited, never paid.",
    icon: "percent",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
    groupBreak: true,
  },
  {
    key: "farmedWagerShare",
    label: "Farmed-wager share",
    hint: "Share of rebated wager farmed purely to harvest rakeback (churned out, no real play). DEMO assumption — a tunable scenario input, not a fraud prediction. Rises above a 10%-of-wager rate.",
    icon: "shield-alert",
    min: 0,
    max: 0.5,
    step: 0.01,
    format: "percent",
    accent: "amber",
  },
  {
    key: "farmCaptureElasticity",
    label: "Farm-capture elasticity",
    hint: "How strongly a LOWER rate suppresses farmed-wager leakage (1 = fully elastic). Higher → trimming the rate kills more leakage.",
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
    hint: "Incremental retained downstream GGR per $1 of rakeback paid to genuine players. Higher → rakeback pays back more downstream.",
    icon: "hand-coins",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
    accent: "emerald",
  },
  {
    key: "rateConversionSensitivity",
    label: "Rate-conversion sensitivity",
    hint: "Genuine downstream play lost per unit of rate cut. Higher → trimming the rate sacrifices more real play → net savings < gross.",
    icon: "gauge",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
  {
    key: "wagerElasticity",
    label: "Wager elasticity",
    hint: "How much total wager responds to the rate: a higher rate lifts wager, a cut trims it. 0 = wager is fixed; higher = more responsive.",
    icon: "trending-down",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
  // ── Instant pre-claim levers (the 65% cash-out model) ──
  // These only bite on scenarios that opt into pre-claim (the "Pre-claim @ 65%"
  // scenario); they set the MAGNITUDE of that model. Honesty: pre-claim is
  // modeled to ELIMINATE breakage on the pre-claimed portion (the user takes it
  // all now) in exchange for the discount — a saving only while the discount
  // sits below the normal breakage-adjusted payout.
  {
    key: "preClaimDiscount",
    label: "Pre-claim discount",
    hint: "Fraction of accrued rakeback paid on an INSTANT pre-claim (cash out everything now). 65% ⇒ $1 accrued pays $0.65 immediately. Assumes the pre-claimed portion eliminates breakage (the user takes it all) — a saving only when this sits below the normal (1 − breakage) payout. Only applies to the Pre-claim scenario.",
    icon: "hand-coins",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
    accent: "emerald",
    groupBreak: true,
  },
  {
    key: "preClaimAdoption",
    label: "Pre-claim adoption",
    hint: "Share of claimants who TAKE the instant pre-claim option. The rest claim normally (subject to breakage). 0 = nobody pre-claims (lever inert); higher = more accrual cashed out early at the discount. Only applies to the Pre-claim scenario.",
    icon: "percent",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
    accent: "emerald",
  },
];

/**
 * Seed the levers from the REAL baseline. The DATA ANCHORS — claimant volume
 * (`baselineClaimants` over `baselinePeriodDays`), claim probability, avg
 * rakeback per claim, the blended rate and total wager — default to the
 * measured production figures (the server tab fills `baselineBlendedRate` /
 * `baselineWager` onto the baseline before calling this). The BEHAVIOURAL
 * levers seed from their named coefficient defaults and stay tunable.
 *
 * Claim probability defaults to the real measured ratio when available, falling
 * back to the named seed only when the real ratio is null (rakeback's overview
 * has no clean qualifier denominator, so the seed is the common case). The same
 * value is stored as `baselineClaimProbability` so the engine treats the
 * default lever as neutral (volume == the real claimant count).
 */
const rakebackDefaults: ForecastConfig<Assumptions, ScenarioConfig>["defaults"] = (baseline) => {
  const realClaimProb = baseline.claimProbability ?? DEFAULT_CLAIM_PROBABILITY;
  // The real blended rate / total wager ride in on the baseline via the two
  // optional extension fields the server tab sets (see `mapRakebackBaseline`).
  // Fall back to the named rate / a wager derived from cost÷rate when absent.
  const ext = baseline as typeof baseline & {
    blendedRate?: number;
    totalWager?: number;
  };
  const blendedRate =
    typeof ext.blendedRate === "number" && ext.blendedRate > 0
      ? ext.blendedRate
      : BASELINE_RATE_FALLBACK;
  const totalWager =
    typeof ext.totalWager === "number" && ext.totalWager > 0
      ? ext.totalWager
      : blendedRate > 0
        ? baseline.totalCost / blendedRate
        : 0;
  return {
    baselineClaimants: baseline.uniqueClaimants,
    baselinePeriodDays: Math.max(1, baseline.periodDays),
    baselineClaimProbability: realClaimProb,
    segmentMix: { ...DEFAULT_SEGMENT_MIX },
    baselineBlendedRate: blendedRate,
    baselineWager: totalWager,
    depositsPerUserPerWindow: DEFAULT_DEPOSITS_PER_USER_PER_WINDOW,
    claimProbability: realClaimProb,
    avgBonusUsd: baseline.avgBonusUsd,
    breakageRate: DEFAULT_BREAKAGE_RATE,
    farmedWagerShare: DEFAULT_FARMED_WAGER_SHARE,
    farmCaptureElasticity: DEFAULT_FARM_CAPTURE_ELASTICITY,
    retentionUplift: DEFAULT_RETENTION_UPLIFT,
    rateConversionSensitivity: DEFAULT_RATE_CONVERSION_SENSITIVITY,
    wagerElasticity: DEFAULT_WAGER_ELASTICITY,
    windowDays: DEFAULT_WINDOW_DAYS,
    preClaimDiscount: DEFAULT_PRE_CLAIM_DISCOUNT,
    preClaimAdoption: DEFAULT_PRE_CLAIM_ADOPTION,
  };
};

/** The rakeback forecast config — the per-reward contract for `rakeback`. */
export const RAKEBACK_FORECAST_CONFIG: ForecastConfig<Assumptions, ScenarioConfig> = {
  rewardType: "rakeback",
  label: "Rakeback",
  scenarios: SCENARIO_LIBRARY,
  baselineScenarioId: BASELINE_SCENARIO_ID,
  whatifSet: RATE_WHATIF_SET,
  // LIVE policy: when the server tab threads the real `rakeback_config` cadences
  // onto the baseline, derive the baseline + what-ifs from the REAL per-cadence
  // rates (e.g. daily 0.25% / weekly 0.1% / monthly 0.05%), not the static flat
  // placeholders. Falls back to the static library when no real config rode in.
  buildScenarios: buildRakebackScenarios,
  segments: SEGMENTS.map((s) => ({ id: s.id, label: s.label, accent: s.accent })),
  defaults: rakebackDefaults,
  levers: RAKEBACK_LEVERS,
  segmentMixLever: { key: "segmentMix", label: "Wager mix" },
  colors: { hero: "rose", cost: "rose", leakage: "amber", retained: "emerald" },
  simulate,
  pacingFrontload: (sc) => policyFrontload(sc.policy),
  capLabel: (sc) => rateLogicLabel(sc.policy),
  capComplexity: (sc) => operationalComplexity(sc.policy),
};

/**
 * A short, human "real baseline" sub-label for the active period, e.g.
 * "5%/daily baseline". Used in the KPI strip. Kept here (not in the generic UI)
 * because the baseline-policy string is reward-specific. The live page may
 * override the rate figure with the real measured blended rate.
 */
export const RAKEBACK_BASELINE_NOTE = `${(BASELINE_RATE_FALLBACK * 100).toFixed(0)}%/${BASELINE_CADENCE}`;
