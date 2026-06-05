/**
 * Named assumptions for the MOTHA GIVEAWAYS forecast engine.
 *
 * RULE (mirrors the deposit-bonus reference + `edge-calc/math.ts`): there are
 * NO magic numbers downstream. Every coefficient the engine multiplies by lives
 * here as a `SCREAMING_SNAKE_CASE` export with a one-line rationale, so an admin
 * can read exactly what the model assumes and tune one knob in one place.
 *
 * The DEMO-vs-real split:
 *
 *   REAL (fetched server-side, see `getMothaGiveawayOverview`):
 *     • total giveaway cost, per-channel split, active-day count, avg / max
 *       giveaway → drives `ForecastBaseline` + the seeded channel mix.
 *
 *   DEMO / assumption (sliders seeded from the DEFAULT_* below):
 *     • engagement uplift, waste share, waste-capture elasticity, goodwill
 *       sensitivity, per-channel + overall spend multipliers (default 1 =
 *       "keep current spend"), giveaways-per-active-day.
 *
 * Changing a value here only affects NEW simulations — nothing is persisted.
 */

import type { MothaChannel } from "./types";

// ─── Accent colors (house UI palette, House-POV) ────────────────────────────

/** Tile accent keys understood by `modern-panels.tsx` (`TILE_COLORS`). */
export type AccentColor =
  | "blue"
  | "emerald"
  | "rose"
  | "cyan"
  | "amber"
  | "purple"
  | "orange"
  | "pink";

/**
 * The three giveaway channels, their display labels and a stable accent color.
 * Order is the canonical display order. House-POV: giveaways are house outflow,
 * so the channels lean to warm/cool outflow tints (no emerald — emerald is for
 * house GAINS like retained engagement / savings).
 */
export const CHANNELS: { id: MothaChannel; label: string; accent: AccentColor }[] = [
  { id: "tips", label: "Creator tips", accent: "rose" },
  { id: "rain", label: "Rain tips", accent: "cyan" },
  { id: "sponsorship", label: "Sponsored battles", accent: "purple" },
];

/** Stable id list (handy for iteration / normalization). */
export const CHANNEL_IDS: MothaChannel[] = CHANNELS.map((c) => c.id);

// ─── Baseline reference (Scenario A — current spend) ────────────────────────

/**
 * The baseline scenario keeps every channel multiplier at this value (1 = the
 * current, measured giveaway spend — the reference every trim is compared to).
 */
export const BASELINE_MULTIPLIER = 1;

// ─── Default assumptions (UI slider seeds — DEMO) ───────────────────────────

/**
 * DEMO seed — downstream engagement value retained per $1 of giveaway. A
 * giveaway is not pure burn: tips / rain / sponsored battles drive community
 * activity + wager back. 0.18 ⇒ each $1 given away returns ~$0.18 of modeled
 * downstream value (House-POV emerald offset to the cost). Tunable for what-if.
 */
export const DEFAULT_ENGAGEMENT_UPLIFT = 0.18;

/**
 * DEMO seed — share of giveaway $ landing on low-engagement / one-off
 * recipients (effectively wasted). Trimming a channel removes this waste first.
 */
export const DEFAULT_WASTE_SHARE = 0.22;

/** Coefficient — wasteful spend removed per unit of channel trimming (0-1). */
export const DEFAULT_WASTE_CAPTURE_ELASTICITY = 0.6;

/**
 * Coefficient — community-goodwill value lost per unit of TOTAL spend cut
 * (0-1). Tempers the NET savings of a trim (you save the cash but lose some
 * goodwill / future engagement). Higher → cuts hurt the community more.
 */
export const DEFAULT_GOODWILL_SENSITIVITY = 0.25;

/**
 * DEMO seed — giveaway events per active day. Used as the deposit-frequency
 * analogue (`depositsPerUserPerWindow`) the generic `BaseAssumptions` requires.
 * Defaults to the REAL events-per-active-day where the baseline provides it.
 */
export const DEFAULT_GIVEAWAYS_PER_ACTIVE_DAY = 3;

/** Fallback avg giveaway (USD) — the live tab defaults this to the real `avgBonusUsd`. */
export const DEFAULT_AVG_GIVEAWAY_USD = 25;

/** Default forecast horizon (days). */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * Fallback "claim probability" seed. For this reward the volume anchor is
 * distinct active days, not a claim funnel — there is no real P(claim) to
 * measure (the baseline reports `claimProbability: null`). This constant is the
 * neutral default so the generic claim-probability lever still has an effect
 * (it scales the active-day volume) without distorting the baseline.
 */
export const DEFAULT_CLAIM_PROBABILITY = 1;

// ─── Spend-reduction mechanics coefficients ─────────────────────────────────

/**
 * Friction (0-100) here measures COMMUNITY IMPACT of a trim — how much a
 * giveaway cut is felt by the community (the analogue of UX friction). It is
 * the total spend reduction (0-1, vs baseline) scaled to 0-100. A scenario that
 * keeps spend unchanged reads ~0; one that zeroes every channel reads ~100.
 */
export const COMMUNITY_FRICTION_MAX = 100;

/** ±band on projected cost: ±15% (confidence interval, not a guarantee). */
export const CONFIDENCE_BAND_SPREAD = 0.15;

/**
 * Daily-pacing front-load. Giveaways pace fairly evenly day-to-day (a founder's
 * giveaway cadence is not front-loaded the way a fixed cap clusters claims), so
 * the daily series is flat. 1.0 = flat.
 */
export const GIVEAWAY_FRONTLOAD = 1.0;

// ─── Numerical guards ───────────────────────────────────────────────────────

/** Smallest denominator we treat as non-zero before short-circuiting to 0. */
export const EPSILON = 1e-9;
