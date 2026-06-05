/**
 * types.ts — serializable models for the MOTHA GIVEAWAYS forecast.
 *
 * Mirrors the deposit-bonus reference's split: the REWARD-AGNOSTIC result /
 * baseline / recommendation shapes are re-exported from the shared engine kit
 * (`insights/_forecast-engine`); only the MOTHA-SPECIFIC shapes live here.
 *
 * Everything here is a PLAIN data shape — no functions, no Decimal, no Date —
 * so it round-trips through `JSON.parse(JSON.stringify(x))` unchanged (Next 15
 * RSC-prop rule) and a scenario can be saved / shared / exported as JSON.
 *
 * ── What this forecast models ───────────────────────────────────────────────
 * "Motha giveaways" is the OUTFLOW of the founder's `motha` account across its
 * three funding channels — it is a SPEND-REDUCTION forecast, not a cap policy.
 * A scenario therefore carries a per-channel SPEND MULTIPLIER (the fraction of
 * each channel's baseline giveaway that REMAINS after a trim). The three
 * channels ARE the segmentation:
 *   • tips        — `creator_tip` funded by motha
 *   • rain        — `rain_tips` funded by motha
 *   • sponsorship — `battle_sponsorship` funded by motha
 */

// ─── Re-exported generic shapes (the shared foundation) ─────────────────────

export type {
  DailyPoint,
  ForecastBaseline,
  PerSegment,
  Recommendation,
  RecommendationBadge,
  SimulationResult,
} from "../../../_forecast-engine";

import type { BaseAssumptions, BaseScenarioConfig } from "../../../_forecast-engine";

// ─── Channels (the segmentation) ─────────────────────────────────────────────

/**
 * The three giveaway channels the `motha` account funds. Stable string ids so a
 * saved scenario / `Record` keyed by channel stays JSON-serializable. These are
 * BOTH the forecast's segments AND the axes a scenario / lever trims.
 */
export type MothaChannel = "tips" | "rain" | "sponsorship";

/** Stable channel id list (handy for iteration / normalization). */
export const MOTHA_CHANNELS: MothaChannel[] = ["tips", "rain", "sponsorship"];

// ─── Scenario config ─────────────────────────────────────────────────────────

/**
 * A complete, shareable scenario definition. Extends the generic
 * {@link BaseScenarioConfig} (id / label / description / schemaVersion) with a
 * per-channel SPEND MULTIPLIER — the fraction of each channel's baseline
 * giveaway that REMAINS under this scenario (1 = unchanged, 0 = fully cut,
 * 0.6 = trimmed 40%). The baseline scenario keeps every multiplier at 1.
 */
export type ScenarioConfig = BaseScenarioConfig & {
  /** Fraction (0-1+) of each channel's baseline spend retained under this scenario. */
  channelMultiplier: Record<MothaChannel, number>;
};

// ─── Assumptions (the tunable levers) ────────────────────────────────────────

/**
 * Every behavioural / volume assumption the engine multiplies by. Extends the
 * generic {@link BaseAssumptions} (the reward-agnostic volume + claim levers the
 * shared orchestration reads) with the MOTHA-SPECIFIC levers.
 *
 * The headline tunable axes are the PER-CHANNEL spend multipliers (tips / rain
 * / sponsorship) plus an OVERALL multiplier applied on top of all three — these
 * let an admin model "cut rain 30%, sponsorship 50%, then trim everything 10%
 * more". The behavioural levers describe how much downstream engagement a
 * giveaway dollar buys back and how concentrated / wasteful the spend is.
 *
 * Rates / multipliers — never raw money except `avgBonusUsd`. The engine
 * normalizes / clamps defensively, but callers should keep fractions sane.
 */
export type Assumptions = BaseAssumptions & {
  /**
   * REAL baseline SPLIT of total giveaway spend across the three channels
   * (fractions summing to 1), seeded from `ForecastBaseline.byChannel` so the
   * engine knows how much of the measured total each channel represents. The
   * engine normalizes defensively; falls back to an even split if degenerate.
   */
  baselineChannelSplit: Record<MothaChannel, number>;
  /**
   * Live per-channel spend "keep %" multipliers (slider-driven; combine
   * multiplicatively with the scenario's `channelMultiplier` + the overall
   * multiplier). 1 = keep current spend, 0 = cut, 1.2 = +20%. Flat numeric
   * fields (one per channel) so each renders as its own independent percent
   * slider — NOT an auto-normalized mix.
   */
  tipsKeep: number;
  rainKeep: number;
  sponsorshipKeep: number;
  /** Overall multiplier applied to ALL channels on top of the per-channel ones, 0-1+. */
  overallMultiplier: number;
  /**
   * Incremental retained engagement value per $1 of giveaway (downstream
   * goodwill / wager the giveaway drives back). House-POV offset to the cost.
   */
  engagementUplift: number;
  /**
   * Share of giveaway $ that lands on low-engagement / one-off recipients —
   * effectively wasted spend ("leakage"). Trimming a channel removes this
   * waste first (capture elasticity below).
   */
  wasteShare: number;
  /** How strongly trimming a channel removes its wasteful share, 0-1 (1 = fully elastic). */
  wasteCaptureElasticity: number;
  /** Community-goodwill value lost per unit of TOTAL spend cut, 0-1. Tempers net savings. */
  goodwillSensitivity: number;
};
