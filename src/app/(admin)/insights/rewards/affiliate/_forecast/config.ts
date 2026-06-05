/**
 * config.ts — the AFFILIATE {@link ForecastConfig}.
 *
 * Binds the affiliate pure engine (`simulate`), its commission-policy scenario
 * library, its tier segments, its tunable levers, and its house-POV accents into
 * the single serializable-plus-`simulate` object the shared UI island
 * (`_forecast-ui`) and the unified hub (`insights/forecast`) consume.
 *
 * Built by copying the deposit-bonus reference's SHAPE (not its cap-specific
 * math) per the fan-out recipe.
 *
 * ── Serialization (Next 15 RSC boundary) ────────────────────────────────────
 * Everything here EXCEPT the function members (`simulate`, `defaults`,
 * `pacingFrontload`, `capLabel`, `capComplexity`) is plain serializable data.
 * The hub's server component passes the SERIALIZABLE projection
 * (`toSerializableConfig(...)`) + the real baseline into the client island; the
 * island imports `AFFILIATE_FORECAST_CONFIG` directly to obtain `simulate` (a
 * pure module fn) — it is NEVER passed as a server→client prop.
 */

import type { ForecastConfig, LeverConfig } from "../../../_forecast-engine";

import {
  BASELINE_BLENDED_RATE,
  DEFAULT_ACQUISITION_SENSITIVITY,
  DEFAULT_CANNIBALIZATION_RATE,
  DEFAULT_CLAIM_PROBABILITY,
  DEFAULT_COMMISSION_RATE_MULT,
  DEFAULT_QUALIFICATION_ELASTICITY,
  DEFAULT_REFERRAL_QUALITY,
  DEFAULT_REFERRALS_PER_AFFILIATE,
  DEFAULT_RETENTION_UPLIFT,
  DEFAULT_TIER_MIX,
  DEFAULT_WINDOW_DAYS,
  TIERS,
} from "./constants";
import { policyFrontload, simulate } from "./engine";
import { operationalComplexity, policyLogicLabel } from "../_components/forecast-format";
import {
  AFFILIATE_WHATIF_SET,
  BASELINE_SCENARIO_ID,
  SCENARIO_LIBRARY,
} from "./scenarios";
import type { Assumptions, ScenarioConfig } from "./types";

/**
 * The tunable sliders, in display order. `groupBreak` inserts a divider before
 * the lever (separating the volume block from the behavioural block). The
 * generic controls render a shadcn Slider + numeric Input per lever and map the
 * `icon` key + `format` enum to the house glyph / formatter.
 */
const AFFILIATE_LEVERS: LeverConfig[] = [
  // ── Volume levers ──
  {
    key: "depositsPerUserPerWindow",
    label: "Referrals / affiliate / window",
    hint: "Baseline number of wagering referrals each active affiliate brings within one window. A volume context lever — scales each affiliate's commission base.",
    icon: "repeat",
    min: 0,
    max: 6,
    step: 0.1,
    format: "number",
    decimals: 1,
  },
  {
    key: "claimProbability",
    label: "Active rate",
    hint: "P(an affiliate accrues commission this window | qualified). Defaults to the REAL measured ratio (active ÷ qualified affiliates) for the selected period; tunable for what-if. Scales the real active-affiliate volume relative to that default.",
    icon: "percent",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
  {
    key: "avgBonusUsd",
    label: "Avg commission / affiliate (USD)",
    hint: "Baseline average commission per active affiliate over the window — the REAL measured figure. The engine scales this by each policy's rate relative to the current rate.",
    icon: "coins",
    min: 0,
    max: 1000,
    step: 5,
    format: "currency",
  },
  {
    key: "commissionRateMult",
    label: "Global rate multiplier",
    hint: "A master scaler applied on top of any scenario policy. 1 = configured rates as-is; below 1 trims every rate, above 1 enriches. Explore 'what if we shaved every rate by X%' independent of the scenario shape.",
    icon: "trending-down",
    min: 0,
    max: 2,
    step: 0.01,
    format: "multiplier",
  },
  // ── Behavioural levers ──
  {
    key: "referralQuality",
    label: "Referral quality",
    hint: "Share of attributed referral wager that is genuine / engaged rather than churned or self-referred. Higher → less commission leaks on junk traffic and more downstream GGR is retained.",
    icon: "shield-alert",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
    accent: "emerald",
    groupBreak: true,
  },
  {
    key: "qualificationElasticity",
    label: "Qualification elasticity",
    hint: "How strongly a higher qualification bar suppresses low-quality / dormant commission (1 = fully elastic). Higher → raising the bar kills more leakage.",
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
    hint: "Incremental retained house revenue per $1 of commission paid to a quality cohort. Higher → commission pays back more downstream.",
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
    hint: "Share of commission paid on referral traffic that would have signed up anyway (organic / brand). Rises further as the blended rate is enriched past the over-generous threshold.",
    icon: "magnet",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
  {
    key: "acquisitionSensitivity",
    label: "Acquisition sensitivity",
    hint: "Referred volume lost per unit of qualification tightening. Higher → raising the bar sacrifices more genuine acquisition → net savings < gross.",
    icon: "gauge",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
];

/**
 * Seed the levers from the REAL baseline. The DATA ANCHORS — active-affiliate
 * volume (`baselineClaimants` over `baselinePeriodDays`), active rate and avg
 * commission — default to the measured production figures. The BEHAVIOURAL levers
 * seed from their named coefficient defaults and stay tunable for what-if.
 *
 * Active rate defaults to the real measured ratio when available, falling back to
 * the named seed only when the real ratio is null. The same real ratio is stored
 * as `baselineClaimProbability` so the engine treats the default lever as neutral
 * (volume == the real active-affiliate count).
 */
const affiliateDefaults: ForecastConfig<Assumptions, ScenarioConfig>["defaults"] = (
  baseline,
) => {
  const realClaimProb = baseline.claimProbability ?? DEFAULT_CLAIM_PROBABILITY;
  return {
    baselineClaimants: baseline.uniqueClaimants,
    baselinePeriodDays: Math.max(1, baseline.periodDays),
    baselineClaimProbability: realClaimProb,
    tierMix: { ...DEFAULT_TIER_MIX },
    depositsPerUserPerWindow: DEFAULT_REFERRALS_PER_AFFILIATE,
    claimProbability: realClaimProb,
    avgBonusUsd: baseline.avgBonusUsd,
    commissionRateMult: DEFAULT_COMMISSION_RATE_MULT,
    referralQuality: DEFAULT_REFERRAL_QUALITY,
    qualificationElasticity: DEFAULT_QUALIFICATION_ELASTICITY,
    retentionUplift: DEFAULT_RETENTION_UPLIFT,
    cannibalizationRate: DEFAULT_CANNIBALIZATION_RATE,
    acquisitionSensitivity: DEFAULT_ACQUISITION_SENSITIVITY,
    windowDays: DEFAULT_WINDOW_DAYS,
  };
};

/** The affiliate forecast config — the per-reward contract for the hub + island. */
export const AFFILIATE_FORECAST_CONFIG: ForecastConfig<Assumptions, ScenarioConfig> = {
  rewardType: "affiliate",
  label: "Affiliate",
  scenarios: SCENARIO_LIBRARY,
  baselineScenarioId: BASELINE_SCENARIO_ID,
  whatifSet: AFFILIATE_WHATIF_SET,
  segments: TIERS.map((t) => ({ id: t.id, label: t.label, accent: t.accent })),
  defaults: affiliateDefaults,
  levers: AFFILIATE_LEVERS,
  segmentMixLever: { key: "tierMix", label: "Tier mix" },
  colors: { hero: "rose", cost: "rose", leakage: "amber", retained: "emerald" },
  simulate,
  pacingFrontload: (sc) => policyFrontload(sc.policy),
  capLabel: (sc) => policyLogicLabel(sc.policy),
  capComplexity: (sc) => operationalComplexity(sc.policy),
};

/**
 * A short, human "real baseline" sub-label for the active period, e.g.
 * "~5% blended baseline". Used in the KPI strip. Kept here (not in the generic
 * UI) because the baseline-policy string is reward-specific.
 */
export const AFFILIATE_BASELINE_NOTE = `~${(BASELINE_BLENDED_RATE * 100).toFixed(0)}% blended`;
