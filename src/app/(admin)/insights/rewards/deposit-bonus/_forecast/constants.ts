/**
 * Named assumptions for the deposit-bonus forecast engine.
 *
 * RULE (mirrors `insights/edge-calc/math.ts`): there are NO magic numbers
 * downstream. Every coefficient the engine multiplies by lives here as a
 * `SCREAMING_SNAKE_CASE` export with a one-line rationale, so an admin can
 * read off exactly what the model assumes and tune one knob in one place.
 *
 * Many of these are DEMO seeds (clearly tagged). They are starting values for
 * the UI sliders — illustrative, not measured. The DEMO-vs-real split is:
 *
 *   REAL (fetched server-side, see `types.ForecastBaseline`):
 *     • baseline total bonus cost, claimants, avg / median / max bonus,
 *       empirical cap            → getDepositBonusOverview
 *     • cap-hit rate             → getDepositBonusCapHitRate
 *     • downstream GGR / ROI     → getDepositBonusROI (14d forward window)
 *
 *   DEMO / assumption (sliders seeded from the DEFAULT_* below):
 *     • claim probability, breakage, abuse share, abuse-capture elasticity,
 *       retention uplift, cannibalization, legit-conversion sensitivity,
 *       segment mix, deposit frequency.
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
 * The five modeled segments, their display labels and a stable accent color.
 * Order is the canonical display order (legit first, abuse last).
 */
export const SEGMENTS: { id: SegmentId; label: string; accent: AccentColor }[] = [
  { id: "legit_low_risk", label: "Legit · low risk", accent: "emerald" },
  { id: "high_value", label: "High value", accent: "purple" },
  { id: "promo_sensitive", label: "Promo sensitive", accent: "amber" },
  { id: "high_risk_abuse", label: "High risk · abuse", accent: "rose" },
  { id: "reactivated_dormant", label: "Reactivated dormant", accent: "cyan" },
];

/** Stable id list (handy for iteration / normalization). */
export const SEGMENT_IDS: SegmentId[] = SEGMENTS.map((s) => s.id);

// ─── Baseline reference (Scenario A) ────────────────────────────────────────

/** Current production cap ($) — the reference every scenario is measured against. */
export const BASELINE_CAP_USD = 100;
/** Current production window (hours) for the baseline cap. */
export const BASELINE_WINDOW_HOURS = 24;

// ─── Default assumptions (UI slider seeds — DEMO) ───────────────────────────

/** DEMO seed — P(claim | deposit). */
export const DEFAULT_CLAIM_PROBABILITY = 0.62;
/** DEMO seed — awarded-but-never-wagered share. */
export const DEFAULT_BREAKAGE_RATE = 0.18;
/** DEMO seed — baseline abusive-claimant share at the baseline cap. */
export const DEFAULT_ABUSE_SHARE = 0.07;
/** Coefficient — abuse suppressed per unit of cap tightening (0-1). */
export const DEFAULT_ABUSE_CAPTURE_ELASTICITY = 0.55;
/** Coefficient — retained downstream revenue per $1 of legit bonus. */
export const DEFAULT_RETENTION_UPLIFT = 0.12;
/** DEMO seed — share of bonus paid to would-deposit-anyway users. */
export const DEFAULT_CANNIBALIZATION_RATE = 0.3;
/** Coefficient — legit conversion lost per unit of cap tightening (0-1). */
export const DEFAULT_LEGIT_CONVERSION_SENSITIVITY = 0.2;
/** DEMO seed — baseline deposits per eligible user per cap window. */
export const DEFAULT_DEPOSITS_PER_USER_PER_WINDOW = 1.4;
/** DEMO seed — eligible population modeled in the window. */
export const DEFAULT_ELIGIBLE_USERS = 4000;
/** DEMO seed — average bonus (USD) before the cap clamp. */
export const DEFAULT_AVG_BONUS_USD = 42;
/** Default forecast horizon (days). */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * DEMO segment mix — fractions that sum to 1. These are the fixed shares the
 * demo dataset uses; the engine re-normalizes whatever the sliders produce.
 */
export const DEFAULT_SEGMENT_MIX: Record<SegmentId, number> = {
  legit_low_risk: 0.52,
  high_value: 0.09,
  promo_sensitive: 0.22,
  high_risk_abuse: 0.07,
  reactivated_dormant: 0.1,
};

// ─── Cap-mechanics coefficients ─────────────────────────────────────────────

/**
 * Burst-damping factor for spaced / split caps (split_window). The same total
 * dollars enforced over a SHORTER window pace out: the velocity-driven leakage
 * component is multiplied by this (<1) vs the same dollars in one 24h lump.
 * 0.65 = a ~35% reduction in burst leakage for tightly-spaced caps.
 *
 * NOTE: this discounts ABUSE LEAKAGE only — it never inflates total bonus COST.
 * (See {@link SPLIT_CAP_BURST_DAMPING}'s use in `leakageBurstDamping`.) The cost
 * channel is bounded by deposit behaviour, NOT by how many cap windows fit the
 * horizon — see {@link EFFECTIVE_CEILING_MODEL}.
 */
export const SPLIT_CAP_BURST_DAMPING = 0.65;

/**
 * EFFECTIVE-CEILING COST MODEL — the directional truth the cost channel encodes.
 *
 * Total claims/payout over the horizon is bounded by DEPOSIT BEHAVIOUR
 * (`eligibleUsers × depositsPerDay × days × P(claim)`), NOT by the number of
 * cap windows in the horizon. Shrinking the cap window does NOT multiply the
 * modeled claim count — it is an anti-abuse / velocity control.
 *
 * Cost differences between policies therefore come from the per-claim PAID
 * bonus, which a tighter cap reduces by truncating the upper tail of the bonus
 * distribution. We summarize each policy by its EFFECTIVE DAILY-EQUIVALENT
 * CEILING (see `effectiveDailyCeilingUsd`) — the most a realistically-depositing
 * user can pull in a day — and reduce the average paid bonus by a monotone,
 * concave "payout retention factor" of that ceiling vs the baseline ceiling:
 *
 *   r = clamp01(dailyCeiling(policy) / dailyCeiling(baseline))   // 1 at baseline
 *   payoutRetentionFactor = 2r − r²                              // = mean of a
 *     truncated Uniform[0, baselineCeiling] at ceiling c, divided by the
 *     untruncated mean — 1.0 at r=1, 0 at r=0, monotone↑, concave.
 *
 * Consequences (the spec's directional contract):
 *   • a strictly-lower effective ceiling ⇒ lower paid bonus ⇒ lower cost ⇒
 *     POSITIVE gross savings (cost is monotone in the ceiling),
 *   • a modest trim (e.g. $75/24h) bites modestly; an aggressive cap
 *     (e.g. $5/1h, which a 1.4-deposit/day user can only reach ~$7/day on)
 *     bites hard — but NEVER blows cost above the baseline.
 */
export const EFFECTIVE_CEILING_MODEL = "truncated-uniform-mean (2r − r²)" as const;

/**
 * Above this cap ($), the program starts paying users who'd have deposited
 * anyway → cannibalization rises. Set above the baseline cap so the baseline
 * itself sits at the knee, not past it.
 */
export const OVERGENEROUS_CAP_THRESHOLD_USD = 150;

/**
 * Extra cannibalization fraction added per $1 of cap above
 * `OVERGENEROUS_CAP_THRESHOLD_USD`. 0.004 ⇒ a $250 cap (i.e. $100 over) adds
 * +0.40 to the cannibalization fraction (clamped to 1 by the engine).
 */
export const OVERGENEROUS_CANNIBALIZATION_SLOPE = 0.004;

/** ±band on projected cost: ±15% (confidence interval, not a guarantee). */
export const CONFIDENCE_BAND_SPREAD = 0.15;

/**
 * A weekly pooled cap is amortized to one modeled window by dividing by this
 * (7 days). Keeps `weekly_pooled` comparable to per-window caps.
 */
export const WEEKLY_POOL_DAYS = 7;

/**
 * Hours per day. Used to convert a cap's `windowHours` into a windows-per-day
 * figure (`HOURS_PER_DAY / windowHours`) for the effective daily-equivalent
 * ceiling, and to convert the horizon (`windowDays`) into the day count the
 * behaviour-bounded claim volume spans.
 */
export const HOURS_PER_DAY = 24;

/**
 * Reference window-count per day at the baseline (24h window → 1/day). The
 * baseline's effective daily-equivalent ceiling uses this, so the baseline
 * scenario reads exactly its nominal cap per day and `payoutRetentionFactor`
 * returns 1.0 (baseline cost is unchanged / anchors on the real total).
 */
export const BASELINE_WINDOWS_PER_DAY =
  HOURS_PER_DAY / BASELINE_WINDOW_HOURS; // = 1

// ─── Friction weights (0-100 composite) ─────────────────────────────────────

/** Weight: shorter window → more friction (re-deposit cadence pressure). */
export const FRICTION_W_WINDOW_TIGHTNESS = 45;
/** Weight: lower cap vs baseline → more friction (smaller reward ceiling). */
export const FRICTION_W_CAP_LOWNESS = 35;
/** Weight: a decay-after-N rule adds friction (serial claimers throttled). */
export const FRICTION_W_DECAY = 20;

/**
 * Reference window (hours) at which window-tightness friction is ~0. Anything
 * shorter than the baseline window adds friction proportional to how much
 * shorter. Equals the baseline window so the baseline reads ~0 friction.
 */
export const FRICTION_REFERENCE_WINDOW_HOURS = BASELINE_WINDOW_HOURS;

/**
 * Floor window (hours) at which window-tightness friction saturates to its
 * full weight (1h = hourly tranche = maximum cadence pressure).
 */
export const FRICTION_MIN_WINDOW_HOURS = 1;

// ─── Pacing curves (deterministic daily spread) ─────────────────────────────

/**
 * Front-load factor for FIXED-window caps: day-0 weight relative to a flat
 * spread. Fixed 24h caps cluster claims early in the period (users hit the
 * generous cap fast), so the daily series is front-loaded by this much and
 * decays linearly to keep the total exact. 1.0 = flat; >1 = front-loaded.
 */
export const FIXED_WINDOW_FRONTLOAD = 1.6;

/**
 * Split/spaced caps pace evenly (the whole point), so their daily series is
 * effectively flat. Kept named for symmetry / future tuning.
 */
export const SPLIT_WINDOW_FRONTLOAD = 1.0;

// ─── Numerical guards ───────────────────────────────────────────────────────

/** Smallest denominator we treat as non-zero before short-circuiting to 0. */
export const EPSILON = 1e-9;
