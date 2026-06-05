/**
 * constants.ts — named assumptions for the RAFFLE-PRIZES forecast engine.
 *
 * RULE (mirrors the deposit-bonus reference + `edge-calc/math.ts`): NO magic
 * numbers downstream. Every coefficient the engine multiplies by lives here as
 * a `SCREAMING_SNAKE_CASE` export with a one-line rationale, so an admin can
 * read exactly what the model assumes and tune one knob in one place.
 *
 * The DEMO-vs-real split:
 *
 *   REAL (fetched server-side, see `getRaffleForecastBaseline`):
 *     • total reconstructed prize cost, winners (claimants), avg prize / winner,
 *       max single-raffle prize (empirical cap), winners ÷ participants
 *       (claim probability), entries-per-raffle + points-per-entry context.
 *
 *   DEMO / assumption (sliders seeded from the DEFAULT_* below):
 *     • farming share, farming-capture elasticity, retention uplift, breakage,
 *       cannibalization, participation sensitivity, segment mix, entries/window.
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
 * The four modeled entry-volume segments, their display labels and a stable
 * accent color. Order is the canonical display order (heaviest engagement
 * first, minimum/farming last). House-POV accents: the farming-heavy
 * `minimum_entrant` is the leakage cohort → rose; genuine cohorts use neutral/
 * positive tints.
 */
export const SEGMENTS: { id: SegmentId; label: string; accent: AccentColor }[] = [
  { id: "whale_entrant", label: "Whale entrants", accent: "purple" },
  { id: "regular_entrant", label: "Regular entrants", accent: "cyan" },
  { id: "casual_entrant", label: "Casual entrants", accent: "blue" },
  { id: "minimum_entrant", label: "Minimum / farming", accent: "rose" },
];

/** Stable id list (handy for iteration / normalization). */
export const SEGMENT_IDS: SegmentId[] = SEGMENTS.map((s) => s.id);

// ─── Baseline reference (the current program = all multipliers at 1.0) ──────

/**
 * The baseline program multipliers — every axis at 1.0 (the reference every
 * scenario is measured against). Named so the engine + scenarios read off the
 * same "unchanged" value rather than literal 1s scattered around.
 */
export const BASELINE_PRIZE_POOL_MULT = 1;
export const BASELINE_FREQUENCY_MULT = 1;
export const BASELINE_TICKET_RATE_MULT = 1;

// ─── Default assumptions (UI slider seeds — DEMO) ───────────────────────────

/**
 * Fallback P(win | entered) seed. The live page DEFAULTS the slider to the REAL
 * measured ratio (`ForecastBaseline.claimProbability` = winners ÷ participants);
 * this constant is the last-resort fallback when no real ratio is available
 * (e.g. a malformed shared link). Tunable for what-if either way.
 */
export const DEFAULT_CLAIM_PROBABILITY = 0.08;
/** DEMO seed — share of prize value captured by min-ticket / farming entrants. */
export const DEFAULT_FARMING_SHARE = 0.18;
/** Coefficient — farming value suppressed per unit of ticket-rate tightening (0-1). */
export const DEFAULT_FARMING_CAPTURE_ELASTICITY = 0.5;
/** Coefficient — retained downstream revenue per $1 of prize to genuine entrants. */
export const DEFAULT_RETENTION_UPLIFT = 0.1;
/** DEMO seed — share of won prize value never re-engaged (sits in inventory). */
export const DEFAULT_BREAKAGE_RATE = 0.25;
/** DEMO seed — share of prize value paid to would-wager-anyway users. */
export const DEFAULT_CANNIBALIZATION_RATE = 0.28;
/** Coefficient — genuine participation lost per unit of ticket-rate tightening (0-1). */
export const DEFAULT_PARTICIPATION_SENSITIVITY = 0.22;
/**
 * DEMO seed — baseline qualifying-deposit/entry frequency per winning user per
 * window. Used as the generic `depositsPerUserPerWindow` lever (the shared
 * orchestration reads it); for raffles it stands in for "entries per window per
 * winner" and is informational on the cost path (raffle cost is pool×frequency
 * driven, not per-claim-cap driven), so it stays a light contextual lever.
 */
export const DEFAULT_ENTRIES_PER_WINNER_PER_WINDOW = 1.5;
/** Fallback avg prize per winner (USD) — live page defaults to the real `avgBonusUsd`. */
export const DEFAULT_AVG_PRIZE_USD = 40;
/** Default forecast horizon (days). */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * DEMO segment mix — fractions that sum to 1. A typical raffle field skews
 * toward casual + minimum entrants with a long tail of whales. The engine
 * re-normalizes whatever the sliders produce.
 */
export const DEFAULT_SEGMENT_MIX: Record<SegmentId, number> = {
  whale_entrant: 0.08,
  regular_entrant: 0.22,
  casual_entrant: 0.4,
  minimum_entrant: 0.3,
};

// ─── Policy-mechanics coefficients ──────────────────────────────────────────

/**
 * RAFFLE COST MODEL — the directional truth the cost channel encodes.
 *
 * A raffle's prize payout over the horizon scales with the PRIZE-POOL size and
 * the FREQUENCY (more, or bigger, raffles ⇒ more total prizes). It does NOT
 * scale with the ticket rate — earning tickets faster does not make a prize
 * more expensive; it only changes WHO wins and how genuinely engaged they are.
 *
 *   costFactor(policy) = prizePoolMult × frequencyMult
 *
 * applied to the REAL anchored baseline cost. So:
 *   • a smaller pool OR less-frequent cadence ⇒ costFactor < 1 ⇒ lower cost ⇒
 *     POSITIVE gross savings (cost is monotone in pool×frequency),
 *   • a bigger pool / more frequent cadence ⇒ costFactor > 1 ⇒ higher cost.
 * The ticket-rate axis moves leakage + retention (genuine-engagement share),
 * never the headline prize cost directly.
 */
export const RAFFLE_COST_MODEL = "cost ∝ prizePoolMult × frequencyMult" as const;

/**
 * Above this prize-pool MULTIPLIER, the program starts paying users who'd have
 * wagered anyway → cannibalization rises. Set above the baseline (1.0) so the
 * baseline sits at the knee, not past it. A 1.4× pool is where over-generosity
 * begins to bite.
 */
export const OVERGENEROUS_POOL_MULT_THRESHOLD = 1.4;

/**
 * Extra cannibalization fraction added per +1.0 of prize-pool multiplier above
 * {@link OVERGENEROUS_POOL_MULT_THRESHOLD}. 0.5 ⇒ a 2.0× pool (i.e. 0.6 over)
 * adds +0.30 to the cannibalization fraction (clamped to 1 by the engine).
 */
export const OVERGENEROUS_CANNIBALIZATION_SLOPE = 0.5;

/**
 * Reference ticket-rate multiplier at which rate-tightness is ~0 (= baseline).
 * A rate BELOW this (harder to earn tickets) is "tighter" and drives farming
 * capture + participation loss; a rate ABOVE it (easier) loosens the field.
 */
export const BASELINE_RATE_REFERENCE = BASELINE_TICKET_RATE_MULT;

/**
 * The lowest ticket-rate multiplier the tightness scale saturates at (rate this
 * low ⇒ maximally tight field). Below this, tightness is clamped to 1.
 */
export const MIN_RATE_MULT = 0.25;

/** ±band on projected cost: ±15% (confidence interval, not a guarantee). */
export const CONFIDENCE_BAND_SPREAD = 0.15;

// ─── Friction weights (0-100 composite) ─────────────────────────────────────

/**
 * Raffle UX "friction" is the participation burden a policy imposes. Two axes:
 *   • rate tightness — a harder ticket rate makes entry feel less rewarding,
 *   • frequency churn — running raffles far more often than baseline adds
 *     fatigue/operational churn (and far LESS often reduces the program's pull).
 * Pool size alone adds no friction (a bigger prize is purely positive UX), so it
 * carries no weight here.
 */
export const FRICTION_W_RATE_TIGHTNESS = 60;
export const FRICTION_W_FREQUENCY_CHURN = 40;

/**
 * Frequency multiplier beyond which "churn" friction starts accruing in EITHER
 * direction (too-frequent fatigue OR too-rare loss of pull). Distance from 1.0
 * past this band, in multiplier units, scales the churn weight; saturates at
 * {@link FREQUENCY_CHURN_SATURATION}.
 */
export const FREQUENCY_CHURN_DEADBAND = 0.5;
/** Multiplier-distance from the deadband edge at which churn friction saturates. */
export const FREQUENCY_CHURN_SATURATION = 2;

// ─── Pacing curves (deterministic daily spread) ─────────────────────────────

/**
 * Raffles pay out in discrete draws spread across the horizon, so the daily
 * cost series is essentially FLAT (1.0 = even spread). Kept named for symmetry
 * with the deposit-bonus pacing constants / future tuning.
 */
export const RAFFLE_FRONTLOAD = 1.0;

// ─── Numerical guards ───────────────────────────────────────────────────────

/** Smallest denominator we treat as non-zero before short-circuiting to 0. */
export const EPSILON = 1e-9;
