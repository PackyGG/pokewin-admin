/**
 * Named assumptions for the RACE-PRIZE forecast engine.
 *
 * RULE (mirrors the deposit-bonus reference + `insights/edge-calc/math.ts`):
 * there are NO magic numbers downstream. Every coefficient the engine multiplies
 * by lives here as a `SCREAMING_SNAKE_CASE` export with a one-line rationale, so
 * an admin can read off exactly what the model assumes and tune one knob in one
 * place.
 *
 * Many of these are DEMO seeds (clearly tagged). They are starting values for
 * the UI sliders — illustrative, not measured. The DEMO-vs-real split is:
 *
 *   REAL (fetched server-side, see `types.ForecastBaseline`):
 *     • baseline total prize cost, distinct winners, avg prize per winner,
 *       empirical cap (largest single prize)   → getRaceInsightsOverview
 *     • position-tier mix (champion/podium/mid/tail share) → getRaceInsightsPositions
 *     • downstream GGR / ROI (forward window)   → getRaceInsightsROI
 *
 *   DEMO / assumption (sliders seeded from the DEFAULT_* below):
 *     • claim probability (winners ÷ entrants — real when available, seed otherwise),
 *       dead-weight share, leakage-capture elasticity, retention uplift,
 *       cannibalization, engagement sensitivity, structural multipliers.
 *
 * Changing a value here only affects NEW simulations — nothing is persisted.
 */

import type { SegmentId } from "./types";

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
 * The four modeled position tiers, their display labels and a stable accent
 * color. Order is the canonical display order (champion first, tail last).
 */
export const SEGMENTS: { id: SegmentId; label: string; accent: AccentColor }[] = [
  { id: "champion", label: "Champion · 1st", accent: "amber" },
  { id: "podium", label: "Podium · 2-3", accent: "purple" },
  { id: "mid", label: "Mid · 4-10", accent: "cyan" },
  { id: "tail", label: "Tail · 11+", accent: "blue" },
];

/** Stable id list (handy for iteration / normalization). */
export const SEGMENT_IDS: SegmentId[] = SEGMENTS.map((s) => s.id);

/**
 * The BASELINE share of the prize pool each position tier captures under the
 * current (real) tier curve, summing to 1. Used as the reference steepness curve
 * the `steepness` policy reshapes around, and as a fallback when the real
 * position mix is unavailable. Top-heavy by construction (a race pays the
 * champion far more than a tail finisher) — chosen to mirror a typical
 * `race_prize_tiers` curve; the LIVE page overrides the mix with the measured
 * per-tier volume share from `getRaceInsightsPositions`.
 */
export const BASELINE_TIER_SHARE: Record<SegmentId, number> = {
  champion: 0.32,
  podium: 0.28,
  mid: 0.26,
  tail: 0.14,
};

// ─── Default assumptions (UI slider seeds — DEMO) ───────────────────────────

/**
 * Fallback P(win | entered) seed. The live page DEFAULTS the slider to the REAL
 * measured ratio (`ForecastBaseline.claimProbability` = winners ÷ entrants) when
 * available; this constant is only the last-resort fallback when no real ratio
 * is available (e.g. the engine self-check harness, or a malformed shared link).
 * Tunable for what-if either way.
 */
export const DEFAULT_CLAIM_PROBABILITY = 0.35;
/** DEMO seed — prize $ paid to winners who never wager it back (dead-weight). */
export const DEFAULT_DEADWEIGHT_SHARE = 0.22;
/** Coefficient — dead-weight leakage suppressed per unit of pool tightening (0-1). */
export const DEFAULT_LEAKAGE_CAPTURE_ELASTICITY = 0.5;
/** Coefficient — retained downstream wager revenue per $1 of engaged prize. */
export const DEFAULT_RETENTION_UPLIFT = 0.18;
/** DEMO seed — share of prize paid to would-wager-anyway players. */
export const DEFAULT_CANNIBALIZATION_RATE = 0.28;
/** Coefficient — participation/engagement lost per unit of pool shrink (0-1). */
export const DEFAULT_ENGAGEMENT_SENSITIVITY = 0.3;
/** DEMO seed — entries (qualifying participations) per winning user per race window. */
export const DEFAULT_DEPOSITS_PER_USER_PER_WINDOW = 1.2;
/** Fallback avg prize per winner (USD) — live page defaults to the real `avgBonusUsd`. */
export const DEFAULT_AVG_BONUS_USD = 35;
/** Default forecast horizon (days). */
export const DEFAULT_WINDOW_DAYS = 30;

/** Default structural multipliers — neutral (1) so the default state == baseline. */
export const DEFAULT_PRIZE_POOL_MULTIPLIER = 1;
export const DEFAULT_TIER_STEEPNESS = 1;
export const DEFAULT_RACE_CADENCE_MULTIPLIER = 1;

/**
 * DEMO position-tier mix — fractions that sum to 1. These mirror
 * {@link BASELINE_TIER_SHARE} as the demo default; the LIVE page re-seeds this
 * with the measured per-tier WINNER-COUNT share from `getRaceInsightsPositions`,
 * and the engine re-normalizes whatever the sliders produce.
 */
export const DEFAULT_SEGMENT_MIX: Record<SegmentId, number> = {
  champion: 0.06,
  podium: 0.12,
  mid: 0.34,
  tail: 0.48,
};

// ─── Pool-mechanics coefficients ─────────────────────────────────────────────

/**
 * STEEPNESS REDISTRIBUTION MODEL — the directional truth the curve-reshape lever
 * encodes.
 *
 * A `steepness` of `s` reshapes the baseline tier share by raising each tier's
 * RANK weight to the power `s` (then renormalizing). Higher rank (champion =
 * highest) gains share as `s>1`; the tail loses it. `s<1` flattens toward the
 * tail. `s=1` reproduces the baseline curve exactly. The pool TOTAL is unchanged
 * by steepness — it only moves WHERE the dollars land, which moves retention
 * (top-heavy concentrates on a few big winners → less broad engagement) and
 * dead-weight leakage (a flatter curve spreads more small prizes onto churned
 * tail winners → more leakage).
 */
export const STEEPNESS_REDISTRIBUTION_MODEL = "rank-weight^steepness (renormalized)" as const;

/**
 * Tier RANK weights (champion highest → tail lowest) the steepness reshape
 * operates on. The renormalized weight at steepness `s` is
 * `rankWeight^s / Σ rankWeight^s`. Monotone in rank so a higher `s` always
 * concentrates more on the champion.
 */
export const TIER_RANK_WEIGHT: Record<SegmentId, number> = {
  champion: 4,
  podium: 3,
  mid: 2,
  tail: 1,
};

/**
 * Per-tier DEAD-WEIGHT weight multiplier applied to the global dead-weight share:
 * the tail leaks most (small prizes to one-off / churned finishers who rarely
 * re-engage), the champion least (a big winner is the stickiest). REDISTRIBUTES
 * leakage across tiers (the winner-weighted average stays ≈1 on the demo mix) —
 * it does not inflate the total.
 */
export const TIER_LEAK_WEIGHT: Record<SegmentId, number> = {
  champion: 0.4,
  podium: 0.6,
  mid: 1.0,
  tail: 1.4,
};

/**
 * Reference TOP-HEAVINESS of the baseline curve — the champion+podium share of
 * the baseline tier split. Drives the "tightness" axis: a steeper curve (more
 * concentrated than this) reads as tighter (more leakage captured, more
 * engagement risk); a flatter curve reads looser.
 */
export const BASELINE_TOP_SHARE =
  BASELINE_TIER_SHARE.champion + BASELINE_TIER_SHARE.podium; // = 0.60

/**
 * Above this EFFECTIVE per-race pool multiplier (vs baseline), the program starts
 * paying players who'd have wagered anyway → cannibalization rises. Set above 1
 * (the baseline) so the baseline itself sits at the knee, not past it. e.g. 1.5×
 * pool with the slope below adds materially to cannibalization.
 */
export const OVERGENEROUS_POOL_THRESHOLD = 1.0;

/**
 * Extra cannibalization fraction added per 1.0 of pool multiplier ABOVE
 * {@link OVERGENEROUS_POOL_THRESHOLD}. 0.18 ⇒ a 2× pool (i.e. 1.0 over) adds
 * +0.18 to the cannibalization fraction (clamped to 1 by the engine). Richer
 * pools increasingly reward players who'd have played anyway.
 */
export const OVERGENEROUS_CANNIBALIZATION_SLOPE = 0.18;

/** ±band on projected cost: ±15% (confidence interval, not a guarantee). */
export const CONFIDENCE_BAND_SPREAD = 0.15;

// ─── Friction weights (0-100 composite) ─────────────────────────────────────

/**
 * For races, "friction" is the PLAYER-EXPERIENCE drag a policy imposes on the
 * competitive incentive: a smaller pool and a more top-heavy curve both make the
 * race feel less rewarding to the broad field (only the very top wins anything),
 * and faster cadence raises grind pressure. Weighted sum of:
 *   • pool shrink     — how far below the baseline pool the effective pool sits,
 *   • curve steepness — how much more top-heavy than baseline (tail starved),
 *   • cadence grind   — how much faster than baseline races run.
 */
/** Weight: a smaller pool → more friction (less reward for the field). */
export const FRICTION_W_POOL_SHRINK = 45;
/** Weight: a steeper curve → more friction (tail finishers win ~nothing). */
export const FRICTION_W_STEEPNESS = 35;
/** Weight: faster cadence → more friction (grind pressure to keep placing). */
export const FRICTION_W_CADENCE = 20;

/**
 * Cadence multiplier at/below which cadence-friction is ~0 (the baseline
 * frequency). Anything faster adds friction proportional to how much faster, up
 * to {@link FRICTION_CADENCE_SATURATION}.
 */
export const FRICTION_CADENCE_REFERENCE = 1;

/** Cadence multiplier at which cadence-friction saturates to its full weight. */
export const FRICTION_CADENCE_SATURATION = 3;

// ─── Pacing curves (deterministic daily spread) ─────────────────────────────

/**
 * Front-load factor for INFREQUENT (sparse-cadence) races: a weekly/monthly race
 * pays out in a lump on settlement day, so a horizon with few races clusters its
 * cost. Daily races (the common case) spread evenly. We treat the baseline + most
 * scenarios as roughly flat (daily-race dominated) and only the explicit
 * slow-cadence scenarios as front-loaded. 1.0 = flat; >1 = front-loaded.
 */
export const SPARSE_CADENCE_FRONTLOAD = 1.4;

/** Frequent / daily-race cadence pays out evenly → flat daily series. */
export const FREQUENT_CADENCE_FRONTLOAD = 1.0;

/**
 * Cadence multiplier at/below which a scenario is considered "sparse" (lumpy
 * settlement) for pacing purposes. At/under 0.5× the baseline frequency the
 * payout clusters enough to front-load the daily series.
 */
export const SPARSE_CADENCE_THRESHOLD = 0.5;

// ─── Numerical guards ───────────────────────────────────────────────────────

/** Smallest denominator we treat as non-zero before short-circuiting to 0. */
export const EPSILON = 1e-9;
