/**
 * config.ts — the RAFFLE {@link ForecastConfig}.
 *
 * Binds the raffle pure engine (`simulate`), its scenario library, its
 * entry-volume segments, its tunable levers, and its house-POV accents into the
 * single serializable-plus-`simulate` object the shared UI island
 * (`_forecast-ui`) and the unified hub (`insights/forecast`) consume. Mirrors
 * the deposit-bonus reference `config.ts` SHAPE exactly (only the policy-
 * specific metadata differs).
 *
 * ── Serialization (Next 15 RSC boundary) ────────────────────────────────────
 * Everything here EXCEPT the function members (`simulate`, `defaults`,
 * `pacingFrontload`, `capLabel`, `capComplexity`) is plain serializable data.
 * The hub's server component passes the SERIALIZABLE projection
 * (`toSerializableConfig(...)`) + the real baseline into the client island; the
 * island imports `RAFFLE_FORECAST_CONFIG` directly to obtain `simulate` (a pure
 * module fn) — it is NEVER passed as a server→client prop.
 */

import type { ForecastConfig, LeverConfig } from "../../../_forecast-engine";

import {
  DEFAULT_CANNIBALIZATION_RATE,
  DEFAULT_CLAIM_PROBABILITY,
  DEFAULT_ENTRIES_PER_WINNER_PER_WINDOW,
  DEFAULT_FARMING_CAPTURE_ELASTICITY,
  DEFAULT_FARMING_SHARE,
  DEFAULT_PARTICIPATION_SENSITIVITY,
  DEFAULT_RETENTION_UPLIFT,
  DEFAULT_BREAKAGE_RATE,
  DEFAULT_SEGMENT_MIX,
  DEFAULT_WINDOW_DAYS,
  SEGMENTS,
} from "./constants";
import {
  frequencyMult,
  policyFrontload,
  prizePoolMult,
  simulate,
  ticketRateMult,
} from "./engine";
import {
  BASELINE_SCENARIO_ID,
  RAFFLE_WHATIF_SET,
  SCENARIO_LIBRARY,
} from "./scenarios";
import type { Assumptions, RafflePolicy, ScenarioConfig } from "./types";

// ─── Policy-logic label + complexity (raffle-local, pure) ───────────────────

/** Format a multiplier as a compact "1.25×" / "0.5×" string. */
function mult(value: number): string {
  return `${Number.isInteger(value) ? value : Number(value.toFixed(2))}×`;
}

/**
 * A short human "policy logic" label for the comparison table's policy column,
 * e.g. "pool 1.25×" or "pool 1.3× · freq 1.5× · rate 1.25×". Pure string
 * builder over the policy axes that DEVIATE from baseline (1.0).
 */
export function policyLogicLabel(scenario: ScenarioConfig): string {
  const p = scenario.policy;
  if (p.kind === "baseline") return "all axes 1×";
  const parts: string[] = [];
  const pool = prizePoolMult(p);
  const freq = frequencyMult(p);
  const rate = ticketRateMult(p);
  if (pool !== 1) parts.push(`pool ${mult(pool)}`);
  if (freq !== 1) parts.push(`freq ${mult(freq)}`);
  if (rate !== 1) parts.push(`rate ${mult(rate)}`);
  return parts.length > 0 ? parts.join(" · ") : "all axes 1×";
}

/**
 * Operational-complexity rank (1 simplest … 3 most moving parts): a single-axis
 * policy is 1, a combo touching two axes is 2, a combo touching all three is 3.
 */
export function operationalComplexity(scenario: ScenarioConfig): 1 | 2 | 3 {
  const p: RafflePolicy = scenario.policy;
  if (p.kind === "baseline") return 1;
  if (p.kind !== "combo") return 1;
  let axes = 0;
  if (prizePoolMult(p) !== 1) axes += 1;
  if (frequencyMult(p) !== 1) axes += 1;
  if (ticketRateMult(p) !== 1) axes += 1;
  return axes >= 3 ? 3 : axes === 2 ? 2 : 1;
}

// ─── Levers ─────────────────────────────────────────────────────────────────

/**
 * The tunable sliders, in display order. `groupBreak` inserts a divider before
 * the lever (separating the volume block from the behavioural block). The
 * generic controls render a shadcn Slider + numeric Input per lever and map the
 * `icon` key + `format` enum to the house glyph / formatter.
 */
const RAFFLE_LEVERS: LeverConfig[] = [
  // ── Volume levers ──
  {
    key: "depositsPerUserPerWindow",
    label: "Entries / winner / window",
    hint: "Baseline entry frequency per winning user within one window — contextual ticket-rate signal. Raffle prize cost is driven by pool × frequency, not by a per-claim cap, so this is informational.",
    icon: "repeat",
    min: 0,
    max: 10,
    step: 0.1,
    format: "number",
    decimals: 1,
  },
  {
    key: "claimProbability",
    label: "Win probability",
    hint: "P(wins | entered). Defaults to the REAL measured ratio (winners ÷ participants) for the selected period; tunable for what-if. Scales the real winner volume relative to that default.",
    icon: "percent",
    min: 0,
    max: 1,
    step: 0.005,
    format: "percent",
  },
  {
    key: "avgBonusUsd",
    label: "Avg prize / winner (USD)",
    hint: "Baseline average prize value per winner (reconstructed from pack/card prices). Scaled by the prize-pool multiplier of each scenario.",
    icon: "coins",
    min: 0,
    max: 500,
    step: 1,
    format: "currency",
  },
  // ── Behavioural levers ──
  {
    key: "farmingShare",
    label: "Farming share",
    hint: "Share of prize value captured by min-ticket / EV-farming entrants at the baseline ticket rate. DEMO assumption — a tunable scenario input, not a fraud prediction.",
    icon: "shield-alert",
    min: 0,
    max: 0.6,
    step: 0.01,
    format: "percent",
    accent: "amber",
    groupBreak: true,
  },
  {
    key: "farmingCaptureElasticity",
    label: "Farming-capture elasticity",
    hint: "How strongly a tighter ticket rate suppresses farming-captured value (1 = fully elastic). Higher → tightening the rate kills more leakage.",
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
    hint: "Incremental retained downstream revenue per $1 of prize to genuine entrants. Higher → raffle prizes pay back more in subsequent play.",
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
    hint: "Share of won prize value never re-engaged (sits in inventory, never re-wagered). Shrinks the retention base — the prize is still a cost.",
    icon: "percent",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
  {
    key: "cannibalizationRate",
    label: "Cannibalization rate",
    hint: "Share of prize value paid to users who'd have wagered anyway. Rises further above a 1.4× prize pool (over-generous).",
    icon: "magnet",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
  {
    key: "participationSensitivity",
    label: "Participation sensitivity",
    hint: "Genuine participation lost per unit of ticket-rate tightening. Higher → a harder rate sacrifices more genuine entrants → net savings < gross.",
    icon: "gauge",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
];

// ─── Defaults (seed from the REAL baseline) ─────────────────────────────────

/**
 * Seed the levers from the REAL baseline. The DATA ANCHORS — winner volume
 * (`baselineClaimants` over `baselinePeriodDays`), win probability and avg
 * prize — default to the measured production figures. The BEHAVIOURAL levers
 * seed from their named coefficient defaults and stay tunable for what-if.
 *
 * Win probability defaults to the real measured ratio (winners ÷ participants)
 * when available, falling back to the named seed only when the real ratio is
 * null. The same real ratio is stored as `baselineClaimProbability` so the
 * engine treats the default lever as neutral (volume == the real winner count).
 */
const raffleDefaults: ForecastConfig<Assumptions, ScenarioConfig>["defaults"] = (baseline) => {
  const realClaimProb = baseline.claimProbability ?? DEFAULT_CLAIM_PROBABILITY;
  return {
    baselineClaimants: baseline.uniqueClaimants,
    baselinePeriodDays: Math.max(1, baseline.periodDays),
    baselineClaimProbability: realClaimProb,
    segmentMix: { ...DEFAULT_SEGMENT_MIX },
    depositsPerUserPerWindow: DEFAULT_ENTRIES_PER_WINNER_PER_WINDOW,
    claimProbability: realClaimProb,
    avgBonusUsd: baseline.avgBonusUsd,
    farmingShare: DEFAULT_FARMING_SHARE,
    farmingCaptureElasticity: DEFAULT_FARMING_CAPTURE_ELASTICITY,
    retentionUplift: DEFAULT_RETENTION_UPLIFT,
    breakageRate: DEFAULT_BREAKAGE_RATE,
    cannibalizationRate: DEFAULT_CANNIBALIZATION_RATE,
    participationSensitivity: DEFAULT_PARTICIPATION_SENSITIVITY,
    windowDays: DEFAULT_WINDOW_DAYS,
  };
};

/** The raffle forecast config — same per-reward contract as the reference. */
export const RAFFLE_FORECAST_CONFIG: ForecastConfig<Assumptions, ScenarioConfig> = {
  rewardType: "raffle",
  label: "Raffle prizes",
  scenarios: SCENARIO_LIBRARY,
  baselineScenarioId: BASELINE_SCENARIO_ID,
  whatifSet: RAFFLE_WHATIF_SET,
  segments: SEGMENTS.map((s) => ({ id: s.id, label: s.label, accent: s.accent })),
  defaults: raffleDefaults,
  levers: RAFFLE_LEVERS,
  segmentMixLever: { key: "segmentMix", label: "Winner segment mix" },
  colors: { hero: "amber", cost: "rose", leakage: "amber", retained: "emerald" },
  simulate,
  pacingFrontload: (sc) => policyFrontload(sc.policy),
  capLabel: (sc) => policyLogicLabel(sc),
  capComplexity: (sc) => operationalComplexity(sc),
};

/**
 * A short, human "real baseline" sub-label for the active period, e.g.
 * "raffle prizes baseline". Used in the KPI strip. Kept here (not in the generic
 * UI) because the baseline-policy string is reward-specific.
 */
export const RAFFLE_BASELINE_NOTE = "pool × freq × rate";
