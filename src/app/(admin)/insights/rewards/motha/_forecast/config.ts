/**
 * config.ts — the MOTHA GIVEAWAYS {@link ForecastConfig}.
 *
 * Binds this reward's pure engine (`simulate`), its scenario library, its
 * channels (the segmentation), its tunable levers, and its house-POV accents
 * into the single serializable-plus-`simulate` object the shared UI island
 * (`_forecast-ui`) and the unified hub (`insights/forecast`) consume.
 *
 * Shape copied from the deposit-bonus reference (`rewards/deposit-bonus/
 * _forecast/config.ts`); only the channel-trim math differs.
 *
 * ── Serialization (Next 15 RSC boundary) ────────────────────────────────────
 * Everything EXCEPT the function members (`simulate`, `defaults`,
 * `pacingFrontload`, `capLabel`, `capComplexity`) is plain serializable data.
 * The hub's server component passes the SERIALIZABLE projection
 * (`toSerializableConfig(...)`) + the real baseline into the client island; the
 * island imports `MOTHA_FORECAST_CONFIG` directly to obtain `simulate` (a pure
 * module fn) — it is NEVER passed as a server→client prop.
 *
 * ── Real channel split ──────────────────────────────────────────────────────
 * The generic `ForecastBaseline` carries only the TOTAL cost (the anchor). This
 * reward also needs the REAL per-channel SPLIT so a trim hits each channel by
 * its true share. The server tab attaches `byChannel` to the baseline object it
 * passes down (extra serializable fields are safe across the RSC boundary), and
 * `defaults` reads it via the {@link MothaForecastBaseline} cast. When absent
 * (e.g. a malformed shared link), it falls back to an even split.
 */

import type { ForecastBaseline, ForecastConfig, LeverConfig } from "../../../_forecast-engine";

import {
  CHANNELS,
  DEFAULT_AVG_GIVEAWAY_USD,
  DEFAULT_CLAIM_PROBABILITY,
  DEFAULT_ENGAGEMENT_UPLIFT,
  DEFAULT_GIVEAWAYS_PER_ACTIVE_DAY,
  DEFAULT_GOODWILL_SENSITIVITY,
  DEFAULT_WASTE_CAPTURE_ELASTICITY,
  DEFAULT_WASTE_SHARE,
  DEFAULT_WINDOW_DAYS,
} from "./constants";
import { giveawayFrontload, simulate } from "./engine";
import { channelLogicLabel, operationalComplexity } from "../_components/forecast-format";
import { BASELINE_SCENARIO_ID, MOTHA_WHATIF_SET, SCENARIO_LIBRARY } from "./scenarios";
import type { Assumptions, MothaChannel, ScenarioConfig } from "./types";

/**
 * The real baseline as this reward consumes it: the generic {@link ForecastBaseline}
 * PLUS the real per-channel split + events-per-active-day the server tab measures.
 * The extra fields are plain serializable numbers, safe across the RSC boundary.
 */
export type MothaForecastBaseline = ForecastBaseline & {
  /** Real per-channel giveaway $ totals in the window (House-POV outflow). */
  byChannel?: Record<MothaChannel, number>;
  /** Real giveaway events per active day (the deposit-frequency analogue). */
  giveawaysPerActiveDay?: number;
};

/**
 * The tunable sliders, in display order. `groupBreak` inserts a divider before
 * the lever (separating the per-channel spend block from the behavioural
 * block). The generic controls render a shadcn Slider + numeric Input per lever
 * and map the `icon` key + `format` enum to the house glyph / formatter.
 *
 * The three per-channel "keep %" multipliers (tips / rain / sponsorship) are
 * flat percent sliders — each INDEPENDENT (1 = keep current spend, 0 = cut),
 * NOT an auto-normalized mix. They combine multiplicatively with the active
 * scenario's per-channel multiplier and the overall multiplier in the engine.
 */
const MOTHA_LEVERS: LeverConfig[] = [
  // ── Per-channel spend levers (independent keep %) ──
  {
    key: "tipsKeep",
    label: "Creator tips (keep %)",
    hint: "Fraction of the CURRENT creator-tip spend to keep. 100% = unchanged, 0% = stop tips entirely. Independent of the other channels.",
    icon: "hand-coins",
    min: 0,
    max: 1.5,
    step: 0.05,
    format: "percent",
  },
  {
    key: "rainKeep",
    label: "Rain tips (keep %)",
    hint: "Fraction of the CURRENT rain-pool tip spend to keep. 100% = unchanged, 0% = stop rain tips entirely.",
    icon: "hand-coins",
    min: 0,
    max: 1.5,
    step: 0.05,
    format: "percent",
  },
  {
    key: "sponsorshipKeep",
    label: "Sponsored battles (keep %)",
    hint: "Fraction of the CURRENT sponsored-battle funding to keep. 100% = unchanged, 0% = stop sponsoring battles entirely.",
    icon: "hand-coins",
    min: 0,
    max: 1.5,
    step: 0.05,
    format: "percent",
  },
  {
    key: "overallMultiplier",
    label: "Overall spend multiplier",
    hint: "Scales ALL three channels together on top of the per-channel keep % above. 100% = keep current spend; 50% = halve the whole giveaway budget.",
    icon: "gauge",
    min: 0,
    max: 1.5,
    step: 0.05,
    format: "percent",
    groupBreak: true,
  },
  {
    // Maps to the generic `depositsPerUserPerWindow` field (the volume/frequency
    // analogue) — relabelled for this reward as giveaways per active day.
    key: "depositsPerUserPerWindow",
    label: "Giveaways / active day",
    hint: "Baseline giveaway events per active day. Defaults to the REAL measured rate for the period; tunable for what-if. Scales the per-channel volume figures.",
    icon: "repeat",
    min: 0,
    max: 50,
    step: 1,
    format: "number",
    decimals: 0,
  },
  {
    // Maps to the generic `avgBonusUsd` field — relabelled as avg giveaway.
    key: "avgBonusUsd",
    label: "Avg giveaway (USD)",
    hint: "Baseline average giveaway across all channels. Defaults to the real measured average for the period.",
    icon: "coins",
    min: 0,
    max: 500,
    step: 1,
    format: "currency",
  },
  // ── Behavioural levers ──
  {
    key: "engagementUplift",
    label: "Engagement uplift",
    hint: "Downstream engagement value retained per $1 of giveaway (the community activity / wager a giveaway drives back). Higher → giveaways pay back more.",
    icon: "hand-coins",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
    accent: "emerald",
    groupBreak: true,
  },
  {
    key: "wasteShare",
    label: "Waste share",
    hint: "Share of giveaway $ landing on low-engagement / one-off recipients (effectively wasted). Trimming a channel removes this waste first. DEMO assumption.",
    icon: "shield-alert",
    min: 0,
    max: 0.6,
    step: 0.01,
    format: "percent",
    accent: "amber",
  },
  {
    key: "wasteCaptureElasticity",
    label: "Waste-capture elasticity",
    hint: "How strongly trimming a channel removes its wasteful share (1 = fully elastic). Higher → cuts shed more of the wasted spend.",
    icon: "shield-alert",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
    accent: "amber",
  },
  {
    key: "goodwillSensitivity",
    label: "Goodwill sensitivity",
    hint: "Community-goodwill value lost per unit of total spend cut. Higher → trims hurt the community more → net savings < gross.",
    icon: "trending-down",
    min: 0,
    max: 1,
    step: 0.01,
    format: "percent",
  },
];

/**
 * Seed the levers from the REAL baseline. The DATA ANCHORS — total cost
 * (via the anchor), the per-channel SPLIT, avg giveaway and events-per-active-
 * day — default to the measured production figures. The BEHAVIOURAL levers seed
 * from their named coefficient defaults and stay tunable for what-if.
 *
 * `baselineChannelSplit` is derived from the real `byChannel` totals (when the
 * server tab provides them) normalized to fractions; otherwise an even split.
 * The three per-channel keep-% sliders all start at 1 ("keep current spend") —
 * the real SPLIT lives in `baselineChannelSplit`, the sliders only TRIM it.
 */
const mothaDefaults: ForecastConfig<Assumptions, ScenarioConfig>["defaults"] = (baseline) => {
  const b = baseline as MothaForecastBaseline;
  const ch = b.byChannel;
  const split: Record<MothaChannel, number> = ch
    ? { tips: Math.max(0, ch.tips), rain: Math.max(0, ch.rain), sponsorship: Math.max(0, ch.sponsorship) }
    : { tips: 1, rain: 1, sponsorship: 1 };

  const realClaimProb = baseline.claimProbability ?? DEFAULT_CLAIM_PROBABILITY;
  const giveawaysPerActiveDay =
    b.giveawaysPerActiveDay && b.giveawaysPerActiveDay > 0
      ? b.giveawaysPerActiveDay
      : DEFAULT_GIVEAWAYS_PER_ACTIVE_DAY;

  return {
    // ── generic BaseAssumptions ──
    baselineClaimants: baseline.uniqueClaimants,
    baselinePeriodDays: Math.max(1, baseline.periodDays),
    baselineClaimProbability: realClaimProb,
    depositsPerUserPerWindow: giveawaysPerActiveDay,
    claimProbability: realClaimProb,
    avgBonusUsd: baseline.avgBonusUsd > 0 ? baseline.avgBonusUsd : DEFAULT_AVG_GIVEAWAY_USD,
    windowDays: DEFAULT_WINDOW_DAYS,
    // ── motha-specific ──
    baselineChannelSplit: split,
    tipsKeep: 1,
    rainKeep: 1,
    sponsorshipKeep: 1,
    overallMultiplier: 1,
    engagementUplift: DEFAULT_ENGAGEMENT_UPLIFT,
    wasteShare: DEFAULT_WASTE_SHARE,
    wasteCaptureElasticity: DEFAULT_WASTE_CAPTURE_ELASTICITY,
    goodwillSensitivity: DEFAULT_GOODWILL_SENSITIVITY,
  };
};

/** The motha-giveaways forecast config — implements the per-reward contract. */
export const MOTHA_FORECAST_CONFIG: ForecastConfig<Assumptions, ScenarioConfig> = {
  rewardType: "motha",
  label: "Motha giveaways",
  scenarios: SCENARIO_LIBRARY,
  baselineScenarioId: BASELINE_SCENARIO_ID,
  whatifSet: MOTHA_WHATIF_SET,
  segments: CHANNELS.map((c) => ({ id: c.id, label: c.label, accent: c.accent })),
  defaults: mothaDefaults,
  levers: MOTHA_LEVERS,
  // No `segmentMixLever`: the per-channel spend is driven by three INDEPENDENT
  // keep-% sliders in `levers` (not an auto-normalized mix). The channels still
  // serve as the breakdown segmentation via `segments` above.
  colors: { hero: "rose", cost: "rose", leakage: "amber", retained: "emerald" },
  simulate,
  pacingFrontload: giveawayFrontload,
  capLabel: (sc) => channelLogicLabel(sc),
  capComplexity: (sc) => operationalComplexity(sc),
};

/**
 * A short, human "real baseline" sub-label for the active period, e.g.
 * "Tips + Rain + Sponsored". Used in the KPI strip. Kept here (not in the
 * generic UI) because the baseline-policy string is reward-specific.
 */
export const MOTHA_BASELINE_NOTE = "Tips · Rain · Sponsored battles";
