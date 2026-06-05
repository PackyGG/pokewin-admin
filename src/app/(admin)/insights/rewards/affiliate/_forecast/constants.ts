/**
 * Named assumptions for the AFFILIATE commission forecast engine.
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
 *     • baseline total commission cost, active affiliates, avg commission,
 *       blended ROI, downstream GGR proxy → getAffiliateOverview
 *
 *   DEMO / assumption (sliders seeded from the DEFAULT_* below):
 *     • commission-rate multiplier, referral quality, qualification elasticity,
 *       retention uplift, cannibalization, acquisition sensitivity, tier mix,
 *       referrals/affiliate frequency, claim probability fallback.
 *
 * Changing a value here only affects NEW simulations — nothing is persisted.
 */

import type { TierId } from "./types";

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
 * The five modeled affiliate tiers, their display labels and a stable accent
 * color. Order is the canonical display order (whales first, dormant last).
 */
export const TIERS: { id: TierId; label: string; accent: AccentColor }[] = [
  { id: "whale", label: "Whale", accent: "purple" },
  { id: "established", label: "Established", accent: "blue" },
  { id: "emerging", label: "Emerging", accent: "cyan" },
  { id: "micro", label: "Micro", accent: "amber" },
  { id: "dormant", label: "Dormant", accent: "rose" },
];

/** Stable id list (handy for iteration / normalization). */
export const TIER_IDS: TierId[] = TIERS.map((t) => t.id);

// ─── Baseline reference (current policy) ────────────────────────────────────

/**
 * FALLBACK reference blended commission rate ($ per $ of referred wager), used
 * ONLY when the real `affiliate_level_configs` ladder is not threaded (the
 * self-check harness / a malformed shared link). On the live page the engine's
 * blended reference is the REAL ladder's mix-weighted rate (seeded via the
 * config's `defaults`), never this nominal figure. The ACTUAL cost anchor is
 * always the real measured total commission. ~5% is the mid of a typical ladder.
 */
export const BASELINE_BLENDED_RATE = 0.05;

/**
 * FALLBACK per-tier baseline commission rates ($ per $1 referred wager), used
 * ONLY when the real ladder is unavailable (self-check harness / malformed
 * link). On the live page these are REPLACED by the real `affiliate_level_configs`
 * rates collapsed onto the five tiers (see `live-policy.affiliateBaselineTierRate`,
 * threaded into the engine via `Assumptions.baselineTierRate`). Whales earn the
 * richest rate, micro the leanest. These set the RELATIVE tier weighting the
 * per-tier policies multiply; the absolute cost is anchored to the real total.
 */
export const BASELINE_TIER_RATE: Record<TierId, number> = {
  whale: 0.08,
  established: 0.06,
  emerging: 0.045,
  micro: 0.03,
  dormant: 0.03,
};

// ─── Default assumptions (UI slider seeds — DEMO) ───────────────────────────

/**
 * Fallback P(active | qualified affiliate) seed. The live page DEFAULTS the
 * slider to the REAL measured ratio (`ForecastBaseline.claimProbability`); this
 * constant is only the last-resort fallback when no real ratio is available
 * (e.g. the engine self-check harness, or a malformed shared link). Tunable for
 * what-if either way.
 */
export const DEFAULT_CLAIM_PROBABILITY = 0.55;
/** Global commission-rate multiplier seed (1 = configured rates as-is). */
export const DEFAULT_COMMISSION_RATE_MULT = 1;
/** DEMO seed — share of referral wager that is genuine / engaged. */
export const DEFAULT_REFERRAL_QUALITY = 0.7;
/** Coefficient — low-quality commission suppressed per unit of threshold tighten (0-1). */
export const DEFAULT_QUALIFICATION_ELASTICITY = 0.55;
/** Coefficient — retained downstream house revenue per $1 of quality commission. */
export const DEFAULT_RETENTION_UPLIFT = 0.15;
/** DEMO seed — share of commission paid on would-sign-up-anyway traffic. */
export const DEFAULT_CANNIBALIZATION_RATE = 0.25;
/** Coefficient — referred volume lost per unit of qualification tightening (0-1). */
export const DEFAULT_ACQUISITION_SENSITIVITY = 0.35;
/** DEMO seed — baseline referrals generating wager per active affiliate per window. */
export const DEFAULT_REFERRALS_PER_AFFILIATE = 1.6;
/** Fallback avg commission (USD) per active affiliate — live page defaults to the real figure. */
export const DEFAULT_AVG_COMMISSION_USD = 60;
/** Default forecast horizon (days). */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * DEMO tier mix — fractions that sum to 1. A few whales, a fat mid, a long micro
 * tail and a dormant slice. The engine re-normalizes whatever the sliders
 * produce; this is the seed.
 */
export const DEFAULT_TIER_MIX: Record<TierId, number> = {
  whale: 0.06,
  established: 0.2,
  emerging: 0.32,
  micro: 0.3,
  dormant: 0.12,
};

// ─── Rate-mechanics coefficients ────────────────────────────────────────────

/**
 * Per-tier share of commission that is "abuse leakage" AT the current policy —
 * commission paid on churned / self-referred / low-value traffic. Whales are the
 * most vetted (lowest leakage); micro & dormant carry the most junk. These are
 * the per-tier abuse shares the engine applies before quality / qualification
 * capture. DEMO assumptions — tunable via the `referralQuality` lever globally.
 */
export const TIER_BASE_LEAKAGE: Record<TierId, number> = {
  whale: 0.04,
  established: 0.08,
  emerging: 0.14,
  micro: 0.22,
  dormant: 0.45,
};

/**
 * Above this blended rate ($ per $1 wager), the program starts over-paying for
 * acquisition it would have won anyway → cannibalization rises. Set above the
 * baseline blended rate so the baseline itself sits BELOW the knee (enriching
 * rates past it is what triggers extra cannibalization).
 */
export const OVERGENEROUS_RATE_THRESHOLD = 0.06;

/**
 * Extra cannibalization fraction added per +0.01 (1 percentage point) of blended
 * rate above `OVERGENEROUS_RATE_THRESHOLD`. 4.0 ⇒ a 9% blended rate (i.e. +0.03
 * over the knee) adds +0.12 to the cannibalization fraction (clamped to 1 by the
 * engine). Expressed per-0.01 because rates move in single-percentage-point steps.
 */
export const OVERGENEROUS_CANNIBALIZATION_SLOPE = 4.0;

/** ±band on projected cost: ±15% (confidence interval, not a guarantee). */
export const CONFIDENCE_BAND_SPREAD = 0.15;

/**
 * Reference qualification threshold (lifetime referred wager, USD) the baseline
 * ladder sits at — a representative figure. A `qualification` / `hybrid` policy's
 * `thresholdMult` scales this; the tightness math reads the multiplier directly,
 * so the absolute value only labels the baseline. Roughly the mid of the live
 * ladder thresholds.
 */
export const BASELINE_QUALIFICATION_THRESHOLD = 5000;

/**
 * The qualification-tightness of a `thresholdMult`, mapped onto a 0-1 saturating
 * scale: at multiplier 1 (no tighten) tightness is 0; at this multiplier or
 * above it saturates to 1. 4× the baseline bar is treated as "maximally tight"
 * (almost nothing but whales/established qualify). Tunes how aggressively the
 * threshold knob bites.
 */
export const QUALIFICATION_SATURATION_MULT = 4;

// ─── Friction weights (0-100 composite) ─────────────────────────────────────

/**
 * The affiliate "friction" composite is the AFFILIATE-EXPERIENCE / partner-
 * relations cost of a policy: cutting rates and raising the bar antagonizes
 * partners (they promote less, churn to competitors). Weighted sum of:
 *   • rate-cut severity     — how far below the baseline blended rate,
 *   • threshold tightness   — how much higher the qualification bar,
 *   • quality-screen penalty— a hard referral-quality screen adds friction
 *                             (legit affiliates dislike clawbacks/screens).
 */
/** Weight: a deeper rate cut → more partner friction (the headline lever). */
export const FRICTION_W_RATE_CUT = 50;
/** Weight: a higher qualification bar → more friction (locks out small partners). */
export const FRICTION_W_THRESHOLD = 35;
/** Weight: a hard quality screen / clawback adds friction. */
export const FRICTION_W_QUALITY_SCREEN = 15;

// ─── Pacing curves (deterministic daily spread) ─────────────────────────────

/**
 * Commission accrues steadily as referred cohorts wager day-over-day, so the
 * affiliate daily series is essentially FLAT (1.0 = perfectly even). There is no
 * front-load the way deposit-bonus cap claims cluster early — kept named for
 * symmetry and so the config can pass it to the shared pacing curve.
 */
export const FLAT_FRONTLOAD = 1.0;

// ─── Numerical guards ───────────────────────────────────────────────────────

/** Smallest denominator we treat as non-zero before short-circuiting to 0. */
export const EPSILON = 1e-9;
