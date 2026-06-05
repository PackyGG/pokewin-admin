/**
 * config.ts — the signup-bonus {@link ForecastConfig}.
 *
 * Binds the signup engine (`simulate`), its scenario library, its segments, its
 * tunable levers, and its house-POV accents into the single serializable-plus-
 * `simulate` object the shared UI island (`_forecast-ui`) and the unified hub
 * (`insights/forecast`) consume. Mirrors the deposit-bonus reference
 * (`rewards/deposit-bonus/_forecast/config.ts`) SHAPE exactly — only the
 * signup-specific levers / defaults / accents differ.
 *
 * ── Serialization (Next 15 RSC boundary) ────────────────────────────────────
 * Everything here EXCEPT the function members (`simulate`, `defaults`,
 * `pacingFrontload`, `capLabel`, `capComplexity`) is plain serializable data.
 * The hub's server component passes the SERIALIZABLE projection
 * (`toSerializableConfig(...)`) + the real baseline into the client island; the
 * island imports `SIGNUP_FORECAST_CONFIG` directly to obtain `simulate` (a pure
 * module fn) — it is NEVER passed as a server→client prop.
 */

import type { ForecastConfig, LeverConfig } from "../../../_forecast-engine";

import {
  BASELINE_GRANT_USD,
  DEFAULT_ABUSE_SHARE,
  DEFAULT_BREAKAGE_RATE,
  DEFAULT_CLAIM_PROBABILITY,
  DEFAULT_DEPOSIT_GATE_CAPTURE_ELASTICITY,
  DEFAULT_FTD_CONVERSION_RATE,
  DEFAULT_LEGIT_CONVERSION_SENSITIVITY,
  DEFAULT_RETENTION_UPLIFT,
  DEFAULT_SEGMENT_MIX,
  DEFAULT_WINDOW_DAYS,
  SEGMENTS,
} from "./constants";
import { grantFrontload, simulate } from "./engine";
import { grantComplexity, grantLogicLabel } from "./grant-format";
import { BASELINE_SCENARIO_ID, GATED_WHATIF_SET, SCENARIO_LIBRARY } from "./scenarios";
import type { Assumptions, ScenarioConfig } from "./types";

/**
 * The tunable sliders, in display order. `groupBreak` inserts a divider before
 * the lever (separating the volume block from the behavioural block). The
 * generic controls render a shadcn Slider + numeric Input per lever and map the
 * `icon` key + `format` enum to the house glyph / formatter.
 *
 * For signup the generic `depositsPerUserPerWindow` field is repurposed as the
 * FTD (first-time-deposit) conversion rate — the single most important
 * downstream-value driver and the thing a deposit gate prices against.
 */
const SIGNUP_LEVERS: LeverConfig[] = [
  // ── Volume / value levers ──
  {
    key: "claimProbability",
    label: "Claim rate",
    hint: "P(claims the welcome grant | signed up). Defaults to the REAL measured ratio (claimants ÷ signups) for the selected period; tunable for what-if. Scales the real claimant volume relative to that default.",
    icon: "percent",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
  {
    key: "depositsPerUserPerWindow",
    label: "FTD conversion rate",
    hint: "Share of signups that make a qualifying FIRST DEPOSIT. The key downstream-value driver: FTD cohorts retain; non-FTD claimants are mostly cost. A deposit gate prices the grant against this rate.",
    icon: "users",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
  {
    key: "avgBonusUsd",
    label: "Avg grant (USD)",
    hint: "Baseline average welcome grant. Defaults to the REAL measured average for the period; the engine scales each policy's per-segment grant against this real anchor.",
    icon: "coins",
    min: 0,
    max: 50,
    step: 0.5,
    format: "currency",
  },
  // ── Behavioural levers ──
  {
    key: "abuseShare",
    label: "Abuse share",
    hint: "Share of claimants behaving abusively at the UNGATED baseline grant (multi-account / bonus-only farming). DEMO assumption — a tunable scenario input, not a fraud prediction.",
    icon: "shield-alert",
    min: 0,
    max: 0.5,
    step: 0.01,
    format: "percent",
    accent: "amber",
    groupBreak: true,
  },
  {
    key: "depositGateCaptureElasticity",
    label: "Deposit-gate capture",
    hint: "How strongly a deposit gate suppresses abuse (1 = the gate captures all baseline abuse). Bonus-only farmers never deposit, so the gate is the dominant abuse-capture channel for a signup reward.",
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
    hint: "Incremental retained revenue per $1 of grant paid to a legit FTD user. Higher → grants pay back more downstream. Weighted per segment (FTD cohorts retain most).",
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
    hint: "Share of awarded grant never wagered (expired / unused). Shrinks the retention base — the grant is still a cost. Rises further above a roomy per-user lifetime cap.",
    icon: "percent",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
  {
    key: "legitConversionSensitivity",
    label: "Gate conversion loss",
    hint: "Genuine FTD conversion lost per unit of deposit-gate friction. Higher → a deposit gate deters more real new users → net savings < gross. Ungated policies lose nothing here.",
    icon: "gauge",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
];

/**
 * Seed the levers from the REAL baseline. The DATA ANCHORS — claimant volume
 * (`baselineClaimants` over `baselinePeriodDays`), claim rate and avg grant —
 * default to the measured production figures. The BEHAVIOURAL levers seed from
 * their named coefficient defaults and stay tunable for what-if.
 *
 * Claim rate defaults to the real measured ratio when available, falling back
 * to the named seed only when the real ratio is null (no signups). The same
 * real ratio is stored as `baselineClaimProbability` so the engine treats the
 * default lever as neutral (volume == the real claimant count). The FTD
 * conversion rate has no field on `ForecastBaseline` (the canonical signup
 * overview measures it separately), so it seeds from the named default and
 * stays tunable.
 */
const signupDefaults: ForecastConfig<Assumptions, ScenarioConfig>["defaults"] = (baseline) => {
  const realClaimRate = baseline.claimProbability ?? DEFAULT_CLAIM_PROBABILITY;
  return {
    baselineClaimants: baseline.uniqueClaimants,
    baselinePeriodDays: Math.max(1, baseline.periodDays),
    baselineClaimProbability: realClaimRate,
    segmentMix: { ...DEFAULT_SEGMENT_MIX },
    depositsPerUserPerWindow: DEFAULT_FTD_CONVERSION_RATE,
    claimProbability: realClaimRate,
    avgBonusUsd: baseline.avgBonusUsd,
    breakageRate: DEFAULT_BREAKAGE_RATE,
    abuseShare: DEFAULT_ABUSE_SHARE,
    depositGateCaptureElasticity: DEFAULT_DEPOSIT_GATE_CAPTURE_ELASTICITY,
    retentionUplift: DEFAULT_RETENTION_UPLIFT,
    legitConversionSensitivity: DEFAULT_LEGIT_CONVERSION_SENSITIVITY,
    windowDays: DEFAULT_WINDOW_DAYS,
  };
};

/** The signup-bonus forecast config — follows the deposit-bonus contract. */
export const SIGNUP_FORECAST_CONFIG: ForecastConfig<Assumptions, ScenarioConfig> = {
  rewardType: "signup",
  label: "Signup bonus",
  scenarios: SCENARIO_LIBRARY,
  baselineScenarioId: BASELINE_SCENARIO_ID,
  whatifSet: GATED_WHATIF_SET,
  segments: SEGMENTS.map((s) => ({ id: s.id, label: s.label, accent: s.accent })),
  defaults: signupDefaults,
  levers: SIGNUP_LEVERS,
  segmentMixLever: { key: "segmentMix", label: "Segment mix" },
  colors: { hero: "rose", cost: "rose", leakage: "amber", retained: "emerald" },
  simulate,
  pacingFrontload: (sc) => grantFrontload(sc.grant),
  capLabel: (sc) => grantLogicLabel(sc.grant),
  capComplexity: (sc) => grantComplexity(sc.grant),
};

/**
 * A short, human "real baseline" sub-label for the active period, e.g.
 * "$5 welcome grant". Used in the KPI strip. Kept here (not in the generic UI)
 * because the baseline-policy string is reward-specific.
 */
export const SIGNUP_BASELINE_NOTE = `$${BASELINE_GRANT_USD} welcome grant`;
