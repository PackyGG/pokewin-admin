/**
 * Named assumptions for the RAKEBACK forecast engine.
 *
 * RULE (mirrors the deposit-bonus reference + `insights/edge-calc/math.ts`):
 * there are NO magic numbers downstream. Every coefficient the engine
 * multiplies by lives here as a `SCREAMING_SNAKE_CASE` export with a one-line
 * rationale, so an admin can read off exactly what the model assumes and tune
 * one knob in one place.
 *
 * Many of these are DEMO seeds (clearly tagged). They are starting values for
 * the UI sliders — illustrative, not measured. The DEMO-vs-real split is:
 *
 *   REAL (fetched server-side, see `types.ForecastBaseline` + the server tab):
 *     • baseline total rakeback cost, distinct claimants, avg per claim,
 *       largest claim, total wager, blended rate  → getRakebackOverview
 *     • downstream GGR / ROI / avg GGR per claimant → getRakebackRoi
 *
 *   DEMO / assumption (sliders seeded from the DEFAULT_* below):
 *     • breakage, farmed-wager share, farm-capture elasticity, retention
 *       uplift, rate-conversion sensitivity, wager elasticity, segment mix,
 *       deposit/qualifying frequency, claim probability (fallback only).
 *
 * Changing a value here only affects NEW simulations — nothing is persisted.
 */

import type { ClaimCadence, RatePolicy, SegmentId } from "./types";

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
 * The four modeled wager-tier segments, their display labels and a stable
 * accent color. Order is the canonical display order (whales first, dormant
 * last). The `tierRank` (0 = lowest wager … N = highest) drives the
 * progressive-taper rate (higher tier → more taper).
 */
export const SEGMENTS: { id: SegmentId; label: string; accent: AccentColor; tierRank: number }[] = [
  { id: "whales", label: "Whales", accent: "purple", tierRank: 3 },
  { id: "mid_volume", label: "Mid volume", accent: "cyan", tierRank: 2 },
  { id: "low_volume", label: "Low volume", accent: "amber", tierRank: 1 },
  { id: "dormant", label: "Dormant / reactivated", accent: "rose", tierRank: 0 },
];

/** Stable id list (handy for iteration / normalization). */
export const SEGMENT_IDS: SegmentId[] = SEGMENTS.map((s) => s.id);

/** Quick lookup: segment id → its wager tier rank (0 lowest … 3 highest). */
export const SEGMENT_TIER_RANK: Record<SegmentId, number> = SEGMENTS.reduce(
  (acc, s) => {
    acc[s.id] = s.tierRank;
    return acc;
  },
  {} as Record<SegmentId, number>,
);

/** The highest tier rank in the segment set (for normalizing taper depth). */
export const MAX_TIER_RANK = Math.max(...SEGMENTS.map((s) => s.tierRank));

// ─── Baseline reference (Scenario A) ────────────────────────────────────────

/**
 * Current production blended rakeback rate ($ rakeback / $ wager) used as the
 * FALLBACK reference when the real measured blended rate is unavailable (the
 * self-check harness, or a malformed shared link). The live page ALWAYS
 * defaults the baseline rate to the real measured ratio. 0.05 = 5% of wager —
 * a typical rakeback headline rate; the real figure overrides it.
 */
export const BASELINE_RATE_FALLBACK = 0.05;

/** Current production claim cadence — the reference cadence the baseline uses. */
export const BASELINE_CADENCE: ClaimCadence = "daily";

// ─── Default assumptions (UI slider seeds — DEMO) ───────────────────────────

/**
 * Fallback P(claim | qualified) seed. The live page DEFAULTS the slider to the
 * REAL measured ratio when available; this constant is the last-resort fallback
 * when no real ratio is computable (rakeback's overview does not expose a clean
 * "qualifying depositors" denominator, so this fallback is the common case).
 * Tunable for what-if either way.
 */
export const DEFAULT_CLAIM_PROBABILITY = 0.7;
/** DEMO seed — accrued-but-never-claimed share (expired / abandoned). */
export const DEFAULT_BREAKAGE_RATE = 0.12;
/** DEMO seed — share of rebated wager farmed purely to harvest rakeback. */
export const DEFAULT_FARMED_WAGER_SHARE = 0.06;
/** Coefficient — farmed-wager leakage suppressed per unit of rate cut (0-1). */
export const DEFAULT_FARM_CAPTURE_ELASTICITY = 0.5;
/** Coefficient — retained downstream GGR per $1 of rakeback to genuine players. */
export const DEFAULT_RETENTION_UPLIFT = 0.18;
/** Coefficient — genuine downstream play lost per unit of rate cut (0-1). */
export const DEFAULT_RATE_CONVERSION_SENSITIVITY = 0.25;
/**
 * Coefficient — wager elasticity to the rate. 0.15 ⇒ doubling the rate vs
 * baseline lifts total wager ~15% (and halving it trims ~15%). A mild,
 * deliberately conservative behavioural response; tunable.
 */
export const DEFAULT_WAGER_ELASTICITY = 0.15;
/** DEMO seed — qualifying events per claiming user per cadence window. */
export const DEFAULT_DEPOSITS_PER_USER_PER_WINDOW = 1.0;
/** Default forecast horizon (days). */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * DEMO WAGER mix — fractions of TOTAL WAGER that sum to 1. Rakeback dollars are
 * wager-proportional, so this is a wager split, not a headcount split: whales
 * are few in number but carry most of the wager (and therefore most of the
 * rakeback cost). The engine re-normalizes whatever the sliders produce.
 */
export const DEFAULT_SEGMENT_MIX: Record<SegmentId, number> = {
  whales: 0.45,
  mid_volume: 0.3,
  low_volume: 0.18,
  dormant: 0.07,
};

// ─── Rate-mechanics coefficients ────────────────────────────────────────────

/**
 * Per-cadence breakage MULTIPLIER applied on top of the `breakageRate` lever.
 * Faster cadence → users sweep reliably → less expires. Slower cadence → more
 * accrues and more lapses unclaimed. 1.0 at the baseline (daily) cadence so the
 * baseline reads exactly the slider value; >1 raises breakage, <1 lowers it.
 *
 *   daily   → 0.8  (reliable sweeps, least breakage)
 *   weekly  → 1.0  (the neutral reference)
 *   monthly → 1.4  (long accrual, most lapses)
 */
export const CADENCE_BREAKAGE_MULT: Record<ClaimCadence, number> = {
  daily: 0.8,
  weekly: 1.0,
  monthly: 1.4,
};

/**
 * Reference cadence whose breakage multiplier is the neutral 1.0. Weekly is the
 * mid-point; daily reads below it (less breakage) and monthly above (more).
 */
export const CADENCE_BREAKAGE_REFERENCE: ClaimCadence = "weekly";

/**
 * EXPIRY → BREAKAGE model. A shorter unclaimed-accrual expiry forfeits more of
 * the accrual. We add an expiry-driven breakage component that climbs as the
 * expiry shortens below the reference, saturating at a floor expiry:
 *
 *   expiryBreakage = EXPIRY_BREAKAGE_MAX × clamp01(
 *       (EXPIRY_REFERENCE_DAYS − expiryDays) / (EXPIRY_REFERENCE_DAYS − EXPIRY_FLOOR_DAYS))
 *
 * Added to (not multiplied with) the base breakage, then clamped to 1. At/above
 * the reference expiry it contributes 0; at the floor it contributes the max.
 */
export const EXPIRY_REFERENCE_DAYS = 30;
export const EXPIRY_FLOOR_DAYS = 1;
export const EXPIRY_BREAKAGE_MAX = 0.35;

/**
 * RATE-TIGHTNESS model — how far BELOW the baseline blended rate a policy's
 * effective (wager-weighted) rate sits, as a 0-1 fraction where 0 = at/above
 * the baseline rate and 1 = a zero rate. Drives farmed-wager capture (a lower
 * rate gives farmers less to harvest) and genuine-conversion loss (a lower rate
 * gives genuine players less reason to play):
 *
 *   tightness = clamp01((baselineRate − effectiveRate) / baselineRate)
 *
 * Symmetric, dimensionless; identical mechanic to deposit-bonus's
 * `tightnessVsBaseline` but on the RATE axis instead of the cap axis.
 */
export const RATE_TIGHTNESS_MODEL = "(baselineRate − effectiveRate) / baselineRate" as const;

/**
 * Over-generous rate THRESHOLD (fraction of wager). Above this the program
 * over-rebates — cannibalizing GGR it would have kept and pulling in pure
 * farmers faster than genuine play. Set above a typical baseline so the
 * baseline sits at the knee, not past it. 0.10 = 10% of wager.
 */
export const OVERGENEROUS_RATE_THRESHOLD = 0.1;

/**
 * Extra farmed-wager fraction added per 0.01 (1 percentage point) of rate above
 * {@link OVERGENEROUS_RATE_THRESHOLD}. 0.4 ⇒ a 15%-of-wager rate (i.e. 5pp over)
 * adds +0.20 to the farmed share (clamped to 1 by the engine). Encodes "a too-
 * generous rate attracts farmers".
 */
export const OVERGENEROUS_FARM_SLOPE = 0.4;

/** ±band on projected cost: ±15% (confidence interval, not a guarantee). */
export const CONFIDENCE_BAND_SPREAD = 0.15;

// ─── Friction weights (0-100 composite) ─────────────────────────────────────

/**
 * UX friction for a rakeback policy is dominated by how much LESS a player gets
 * (rate cut) and how LONG they wait / how easily their accrual evaporates
 * (slow cadence + short expiry). A flat baseline-rate daily policy reads ~0.
 */
/** Weight: a lower effective rate vs baseline → more friction (smaller rebate). */
export const FRICTION_W_RATE_LOWNESS = 50;
/** Weight: a slower claim cadence → more friction (longer wait to realize). */
export const FRICTION_W_CADENCE = 30;
/** Weight: a short expiry → more friction (accrual can evaporate). */
export const FRICTION_W_EXPIRY = 20;

/**
 * Friction contribution per cadence, as a 0-1 factor (× FRICTION_W_CADENCE).
 * Daily is frictionless (claim whenever); monthly is the worst wait.
 */
export const CADENCE_FRICTION: Record<ClaimCadence, number> = {
  daily: 0,
  weekly: 0.5,
  monthly: 1,
};

// ─── Pacing curves (deterministic daily spread) ─────────────────────────────

/**
 * Front-load factor for a DAILY-cadence rakeback policy: day-0 weight relative
 * to a flat spread. Daily rakeback is claimed continuously, so its series is
 * effectively FLAT (1.0). Kept named for symmetry / future tuning.
 */
export const DAILY_CADENCE_FRONTLOAD = 1.0;

/**
 * Front-load factor for SLOWER cadences (weekly / monthly): accrual builds then
 * is swept in lumps, which — averaged over the horizon and smoothed by the
 * deterministic pacing curve — reads slightly front-loaded as early accrual
 * clears first. >1 front-loads day 0; the curve always integrates EXACTLY to
 * the supplied total.
 */
export const POOLED_CADENCE_FRONTLOAD = 1.3;

/** Resolve the daily-pacing front-load a cadence implies. */
export function cadenceFrontload(cadence: ClaimCadence): number {
  return cadence === "daily" ? DAILY_CADENCE_FRONTLOAD : POOLED_CADENCE_FRONTLOAD;
}

// ─── Misc ────────────────────────────────────────────────────────────────────

/** Hours per day — day/window conversions. */
export const HOURS_PER_DAY = 24;

/** Smallest denominator we treat as non-zero before short-circuiting to 0. */
export const EPSILON = 1e-9;

/**
 * Helper: the cadence a policy carries (every policy variant has one). Kept here
 * so the engine + friction + pacing read it identically.
 */
export function policyCadence(policy: RatePolicy): ClaimCadence {
  return policy.cadence;
}
