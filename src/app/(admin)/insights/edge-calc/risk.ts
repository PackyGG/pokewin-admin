/**
 * Pure, dependency-free pack RISK engine for the Edge Calc surface.
 *
 * Side-effect-free and dep-free (imports ONLY the dep-free math module) so the
 * client scenario builder, the server-rendered panels, AND the snapshot job that
 * scores EVERY pack can all call the same functions. No Decimal objects cross
 * this boundary — every input/output is a primitive number so the React state
 * machine stays serializable.
 *
 * Two consistent paths to the SAME `PackRisk` shape:
 *   • computePackRisk            — per-card (one row per pool card; exact)
 *   • computePackRiskFromAggregates — from SQL sums (the scalable snapshot path)
 *
 * Plus `shapeWeights` — an inverse solver that lays out per-card weights so a
 * pack hits a target edge + win-rate (the design-a-pack direction), built on
 * the SAME power-law template the math module's `computeOddsForTargetEv` uses.
 */

import { TARGET_HOUSE_EDGE } from "./math";

// ─── Types ────────────────────────────────────────────────────────────

/** A single pool card reduced to the only two facts the risk math needs. */
export type CardLite = { value: number; weight: number };

/**
 * Coarse risk bucket derived from the coefficient of variation (CV). Higher
 * tier = more volatile payout distribution (a "swingier" pack).
 */
export type RiskTier = "T1" | "T2" | "T3" | "T4" | "T5";

export type PackRisk = {
  /** Expected payout per open: SUM(p_i · v_i). */
  ev: number;
  /** Theoretical house edge = 1 − ev/price (0..1, clamped at 0 floor for >100% RTP). */
  edge: number;
  /** Coefficient of variation of the payout = stddev / ev (0 when ev ≤ 0). */
  cv: number;
  /** Probability mass on cards worth ≥ price (a "win" for the user). */
  winRate: number;
  /** Probability mass on cards worth [0.5·price, price) — a near-miss. */
  nearMiss: number;
  /** Highest single card value in the pool. */
  maxWin: number;
  /** maxWin / price — the headline "Nx" jackpot multiplier. */
  maxMult: number;
  /** Value of the single highest-weight (most-likely) card. */
  floorValue: number;
  /** floorValue / price — what the modal outcome returns vs the ticket. */
  floorRatio: number;
  /** Composite 0..100 risk score (CV-dominated, jackpot + floor adjusted). */
  riskScore0to100: number;
  /** CV-derived tier T1..T5. */
  tier: RiskTier;
};

// ─── Tiering ──────────────────────────────────────────────────────────

/**
 * Upper-exclusive CV boundaries between the five tiers:
 *   CV < 1.4 → T1, [1.4,3) → T2, [3,6) → T3, [6,12) → T4, ≥ 12 → T5.
 * A boundary value lands in the HIGHER tier (e.g. CV 1.4 → T2) so the bounds
 * read as "T1 is everything strictly below 1.4".
 */
export const CV_TIER_BOUNDS = [1.4, 3, 6, 12] as const;

export function riskTier(cv: number): RiskTier {
  if (!Number.isFinite(cv) || cv < CV_TIER_BOUNDS[0]) return "T1";
  if (cv < CV_TIER_BOUNDS[1]) return "T2";
  if (cv < CV_TIER_BOUNDS[2]) return "T3";
  if (cv < CV_TIER_BOUNDS[3]) return "T4";
  return "T5";
}

// ─── Internal numeric helpers ─────────────────────────────────────────

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** A fully-zeroed risk record — used for the NaN-safe / empty-pool early out. */
function zeroedRisk(): PackRisk {
  return {
    ev: 0,
    edge: 0,
    cv: 0,
    winRate: 0,
    nearMiss: 0,
    maxWin: 0,
    maxMult: 0,
    floorValue: 0,
    floorRatio: 0,
    riskScore0to100: 0,
    tier: "T1",
  };
}

/**
 * Assemble the final risk record from already-computed scalar moments. Shared by
 * both the per-card and aggregate entry points so the score / tier / ratio
 * derivations live in exactly ONE place and the two paths cannot drift.
 *
 * NaN-safe for ALL inputs: if any incoming moment (ev / variance / maxWin /
 * floorValue) is non-finite — e.g. a card carried a NaN or Infinity value that
 * propagated into the sums — the whole record falls back to `zeroedRisk()`
 * rather than emitting NaN/Infinity into the returned shape (which would render
 * as null/NaN downstream). The degenerate weight/price guards in the two entry
 * points cover the documented cases; this is the final backstop for the rest.
 */
function buildRisk(input: {
  price: number;
  ev: number;
  variance: number;
  winRate: number;
  nearMiss: number;
  maxWin: number;
  floorValue: number;
}): PackRisk {
  const { price, ev } = input;
  // Final non-finite sweep: a NaN/Infinity in any moment poisons the derived
  // record, so zero it out instead of leaking a non-finite number downstream.
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(ev) ||
    !Number.isFinite(input.variance) ||
    !Number.isFinite(input.maxWin) ||
    !Number.isFinite(input.floorValue)
  ) {
    return zeroedRisk();
  }
  const variance = Math.max(0, input.variance); // float-noise floor
  const cv = ev > 0 ? Math.sqrt(variance) / ev : 0;
  const edge = price > 0 ? Math.max(0, 1 - ev / price) : 0;
  const maxMult = price > 0 ? input.maxWin / price : 0;
  const floorRatio = price > 0 ? input.floorValue / price : 0;

  const riskScore0to100 = Math.round(
    100 *
      (0.7 * clamp01(cv / 12) +
        0.2 * clamp01(Math.log10(Math.max(maxMult, 1)) / 3) +
        0.1 * clamp01(1 - floorRatio)),
  );

  return {
    ev,
    edge,
    cv,
    winRate: clamp01(input.winRate),
    nearMiss: clamp01(input.nearMiss),
    maxWin: input.maxWin,
    maxMult,
    floorValue: input.floorValue,
    floorRatio,
    riskScore0to100,
    tier: riskTier(cv),
  };
}

// ─── Per-card path ────────────────────────────────────────────────────

/**
 * Score a pack from its full card pool. Probabilities are weight-normalized
 * draws (p_i = w_i / ΣW); EV / variance / win-rate / near-miss are the exact
 * moments of that single-draw distribution.
 *
 * NaN-safe: a non-positive total weight or price returns a fully-zeroed record
 * (tier T1, score 0). A card whose VALUE is non-finite (NaN/Infinity) is skipped
 * entirely — including from the total weight — so one poisoned row can't drag
 * the whole pool's ev/edge/cv to NaN or Infinity (the buildRisk backstop catches
 * anything that still slips through).
 */
export function computePackRisk(input: { cards: CardLite[]; price: number }): PackRisk {
  const { cards, price } = input;

  // A card only counts if BOTH its weight and value are finite & the weight is
  // positive. Skipping non-finite values here (not just weights) keeps the
  // probabilities normalized over the usable cards only.
  const usable = (c: CardLite): boolean =>
    Number.isFinite(c.weight) && c.weight > 0 && Number.isFinite(c.value);

  let totalWeight = 0;
  for (const c of cards) {
    if (usable(c)) totalWeight += c.weight;
  }
  if (!(totalWeight > 0) || !(price > 0)) return zeroedRisk();

  // EV first (needed for the variance pass).
  let ev = 0;
  for (const c of cards) {
    if (!usable(c)) continue;
    ev += (c.weight / totalWeight) * c.value;
  }

  let variance = 0;
  let winRate = 0;
  let nearMiss = 0;
  let maxWin = -Infinity;
  let floorWeight = -Infinity;
  let floorValue = 0;
  const nearMissLo = 0.5 * price;

  for (const c of cards) {
    if (!usable(c)) continue;
    const p = c.weight / totalWeight;
    const d = c.value - ev;
    variance += p * d * d;
    if (c.value >= price) winRate += p;
    else if (c.value >= nearMissLo) nearMiss += p;
    if (c.value > maxWin) maxWin = c.value;
    // Floor = highest-weight card; tie-break to the LOWEST value (the worst
    // realistic modal outcome — most conservative read).
    if (c.weight > floorWeight || (c.weight === floorWeight && c.value < floorValue)) {
      floorWeight = c.weight;
      floorValue = c.value;
    }
  }
  if (!Number.isFinite(maxWin)) maxWin = 0;

  return buildRisk({ price, ev, variance, winRate, nearMiss, maxWin, floorValue });
}

// ─── Aggregate path ───────────────────────────────────────────────────

/**
 * Score a pack from pre-aggregated SQL sums — the scalable snapshot path that
 * scores every pack without materializing each card row. Produces the SAME
 * `PackRisk` shape as `computePackRisk`; the two are kept consistent by sharing
 * `buildRisk`.
 *
 *   ev       = weightedPriceSum / totalWeight
 *   variance = weightedSqSum / totalWeight − ev²   (clamped ≥ 0 for float noise)
 *   winRate  = winWeight / totalWeight
 *   nearMiss = nearMissWeight / totalWeight
 *   maxWin   = maxValue   (floorValue supplied directly)
 *
 * NaN-safe: non-positive totalWeight or price → fully-zeroed record (tier T1).
 * If the supplied sums are themselves non-finite (a NaN/Infinity value leaked
 * into the SQL aggregation), the shared `buildRisk` backstop zeroes the record
 * rather than returning NaN/Infinity moments.
 */
export function computePackRiskFromAggregates(input: {
  price: number;
  totalWeight: number;
  weightedPriceSum: number;
  weightedSqSum: number;
  winWeight: number;
  nearMissWeight: number;
  maxValue: number;
  floorValue: number;
}): PackRisk {
  const { price, totalWeight } = input;
  if (!(totalWeight > 0) || !(price > 0)) return zeroedRisk();

  const ev = input.weightedPriceSum / totalWeight;
  const variance = input.weightedSqSum / totalWeight - ev * ev;
  const winRate = input.winWeight / totalWeight;
  const nearMiss = input.nearMissWeight / totalWeight;

  return buildRisk({
    price,
    ev,
    variance,
    winRate,
    nearMiss,
    maxWin: input.maxValue,
    floorValue: input.floorValue,
  });
}

// ─── Weight shaping (inverse solver) ──────────────────────────────────

export type ShapeWeightsInput = {
  cards: { value: number }[];
  price: number;
  /** Target house edge (0..1). Defaults to the house knob, 10.99%. */
  targetEdge?: number;
  /** Desired probability mass on win+grail cards (value ≥ price). */
  targetWinRate: number;
  /** Drop any card whose value exceeds this cap (jackpot ceiling). */
  maxWinCap?: number;
  /** If set, pin the floor (modal) card so floorValue/price ≥ this. */
  floorRatioMin?: number;
  /** Minimum probability mass on near-miss cards. Default 0.10. */
  nearMissMin?: number;
  /** Win-rate match tolerance. Default 0.02. */
  winRateTol?: number;
};

/**
 * One soft-target relaxation the solver applied to stay feasible. `requested` is
 * what the caller asked for; `applied` is the achievable value the solver fell
 * back to. For near-miss / floor / win-rate, relaxation only ever loosens the
 * soft target downward, so `applied` is between 0 and `requested`.
 */
export type ShapeWeightsRelaxation = {
  lever: "nearMiss" | "winRate" | "floor";
  requested: number;
  applied: number;
  reason: string;
};

export type ShapeWeightsSuccess = {
  weights: number[];
  risk: PackRisk;
  ev: number;
  edge: number;
  /** Soft targets the solver had to relax to reach a feasible result. Empty when nothing was relaxed. */
  relaxations: ShapeWeightsRelaxation[];
  /**
   * Whether the final weights were snapped to the clean-ladder probabilities
   * for human-readable odds. True only when the snap kept edge within
   * tolerance; false when the safe fallback (precise weights) was kept.
   */
  snapped?: boolean;
  /**
   * Whether the lottery-skew post-process redistributed the grail band's
   * weights along a steeper value^(-β) curve (β=2) to match the owner's
   * hand-tuned variance profile for tagged 1%/5% lottery packs. Only ever
   * true when the requested win-rate is ≤ 5% AND the grail band has > 1
   * card AND the redistribution kept the edge within the same ±0.05pp
   * tolerance the clean-ladder snap uses. Otherwise false (no skew applied,
   * solver weights preserved). The flag exists so callers can surface
   * "lottery-skewed distribution" in reviews / changelogs.
   */
  lotterySkewApplied?: boolean;
};

/**
 * Discriminator for the structured HARD-limit kinds `shapeWeights` can emit.
 * The set is enumerated for documentation + a single place to extend, but the
 * field on `ShapeWeightsLimit` stays a plain `string` so callers don't need an
 * exhaustive switch (renderers just show `detail` + `suggestion`).
 *
 * - `invalid-price`         — non-positive price input.
 * - `invalid-target-edge`   — target edge not in (0, 1).
 * - `invalid-target-win-rate` — target win-rate not in [0, 1).
 * - `empty-pool`            — no usable cards after value/cap filtering.
 * - `no-win-cards`          — pool has no card ≥ price (WIN + GRAIL empty).
 * - `no-win-band-card`      — pool has GRAIL cards but no WIN-band card in
 *                             [price, 5·price), and the math can't hit both the
 *                             target edge AND the target win-rate.
 * - `degenerate-pool`       — every usable card shares the same value.
 * - `ev-out-of-range`       — target EV outside [pool min, pool max].
 * - `no-dust-cards`         — pool has no card < 0.5·price to host losing mass.
 * - `no-dust-mass`          — win + near-miss allocation consumed all mass.
 * - `ev-unreachable-for-split` — target EV outside the chosen split's reachable range.
 * - `edge-unreachable`      — couldn't push edge to target within the bump budget.
 */
export type ShapeWeightsLimitKind =
  | "invalid-price"
  | "invalid-target-edge"
  | "invalid-target-win-rate"
  | "empty-pool"
  | "no-win-cards"
  | "no-win-band-card"
  | "degenerate-pool"
  | "ev-out-of-range"
  | "no-dust-cards"
  | "no-dust-mass"
  | "ev-unreachable-for-split"
  | "edge-unreachable";

/**
 * Structured description of the HARD limit that made the request genuinely
 * impossible (only the truly unsatisfiable cases — see `shapeWeights`). Carries
 * a human-readable detail plus a concrete, actionable suggestion.
 *
 * `kind` stays typed as `string` (not a strict `ShapeWeightsLimitKind`) so
 * consumers don't need an exhaustive switch and the set can be extended without
 * a breaking change. Use {@link ShapeWeightsLimitKind} for documentation of the
 * currently-emitted values.
 */
export type ShapeWeightsLimit = {
  kind: string;
  detail: string;
  suggestion: string;
  /**
   * Optional price range derived from the limit's suggestion. When present, the
   * UI can wire a one-click "Add a card in this range" button that opens the
   * card picker pre-filtered to `[min, max]` instead of forcing the owner to
   * parse the suggestion text and re-enter the range by hand.
   *
   * Emitted for the limit kinds whose `suggestion` already names an explicit
   * USD band — `no-win-cards`, `no-win-band-card`, `ev-out-of-range`, and
   * `no-dust-cards`. Other kinds (degenerate-pool, empty-pool, invalid-*) leave
   * this `undefined`.
   */
  suggestedRange?: { min: number; max: number };
};

export type ShapeWeightsError = {
  error: string;
  feasibility?: Record<string, unknown>;
  /** What hard limit was hit + how to resolve it. */
  limit: ShapeWeightsLimit;
};

export type ShapeWeightsResult = ShapeWeightsSuccess | ShapeWeightsError;

type Band = "GRAIL" | "WIN" | "NEARMISS" | "DUST";

/**
 * Expected value of a single power-law-weighted band: w_i ∝ value_i^(−beta).
 * The SAME mechanism `computeOddsForTargetEv` uses, replicated locally so it can
 * run per band on raw values (not prices). Returns 0 for an empty band.
 */
function bandEvForBeta(values: readonly number[], beta: number): number {
  if (values.length === 0) return 0;
  const w = values.map((v) => Math.pow(v, -beta));
  const sumW = w.reduce((a, b) => a + b, 0);
  if (!(sumW > 0)) return 0;
  const weighted = w.reduce((s, wi, i) => s + wi * values[i]!, 0);
  return weighted / sumW;
}

/**
 * Shared-beta bisection bounds for the EV solve. BETA_LO skews each band toward
 * its EXPENSIVE end (max EV); BETA_HI skews toward CHEAP (min EV). Module-level
 * so the up-front win-rate-vs-EV feasibility bound and the in-solver bisection
 * use the SAME endpoints (the bound must match what the solver can actually do).
 */
const BETA_LO = -20; // skew expensive → max EV
const BETA_HI = 50; // skew cheap → min EV

/** Power-law weight template for a band, normalized to sum to `mass`. */
function bandWeights(values: readonly number[], beta: number, mass: number): number[] {
  if (values.length === 0) return [];
  const w = values.map((v) => Math.pow(v, -beta));
  const sumW = w.reduce((a, b) => a + b, 0);
  if (!(sumW > 0)) return values.map(() => mass / values.length);
  return w.map((wi) => (wi / sumW) * mass);
}

/** Greatest common divisor of two non-negative integers. */
function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x === 0 ? 1 : x;
}

// ─── Lottery skew (steep grail-band redistribution for tagged 1%/5% packs) ──
//
// Even after the inverse solver picks a shared beta that hits the target edge,
// the resulting WITHIN-GRAIL distribution is much flatter than what an owner
// would hand-tune for a real lottery pack. For "1% 18 PLUS" ($1.25 pack,
// grail values $60–$810) the solver lands the $810 jackpot at ~0.013% and the
// $60 grail at ~0.06% — a ratio of ~4.4×. The owner's hand-tuned verbatim
// distribution was $810 at ~0.001% and $60 at ~0.19% — a ratio of ~190×.
// A flat grail distribution lets the rarest jackpot fire too often relative
// to the cheapest grail; short-term variance blows up.
//
// The fix: AFTER the edge-bump loop produces final integer weights, BEFORE
// the clean-ladder snap, redistribute the grail band's probability mass along
// a steeper value^(-β) curve (β=2). β=2 over $60.25..$810.07 yields raw weight
// ratio (60.25^-2) / (810.07^-2) ≈ 181× — matching the owner's ~190× target.
// The TOTAL grail mass stays the same — only the SHAPE within the band shifts.
//
// Trigger gate: targetWinRate ≤ 0.05 (1%, 2%, 3%, 5% packs). Above that
// threshold this function is a no-op so normal packs are byte-for-byte
// unchanged. Safety net: the redistribution slightly raises edge (more mass
// on cheap grails LOWERS grail EV contribution → RAISES edge) which is the
// direction the owner wants, but if drift exceeds the same ±0.05pp tolerance
// the snap uses, we KEEP the solver weights (safe fallback).

/**
 * Redistribute the GRAIL-band probability mass along a steep value^(-β) curve
 * (β=2) so the cheapest grail dominates by ~180× over the most expensive — the
 * profile owners hand-tune for tagged 1%/5% lottery packs. Pure: no mutation
 * of inputs.
 *
 * Two-phase:
 *   1. Re-shape the GRAIL band along value^(-β) (total grail mass preserved).
 *      β=2 on grail values [60..810] gives raw weight ratio
 *      (60.25^-2) / (810.07^-2) ≈ 181× — matching owner verbatim ~190×.
 *   2. EV-compensate by scaling DUST weights DOWN until the total edge lands
 *      back at target. Removing dust mass shifts probability up the value
 *      spectrum (the win/grail/near-miss categories' relative share rises),
 *      which RAISES EV and LOWERS edge — the direction needed because
 *      phase 1 alone lowers EV (more grail mass on cheap cards) and RAISES
 *      edge above target. Bisection on a single multiplicative dust-scale
 *      factor s ∈ [0, 1] hits target edge exactly (the family is monotone
 *      in s). The within-grail value^(-β) ratio is PRESERVED — only the
 *      dust band is scaled. The win-rate target drifts slightly upward as
 *      a consequence (less dust → higher relative grail+win share), and
 *      the caller's existing win-rate tolerance absorbs the drift; if the
 *      drift exceeds tolerance the existing post-shape win-rate relaxation
 *      records it and the result is still accepted (edge stays at target
 *      which is the hard constraint).
 *
 * If even s=0 (all dust removed) can't bring edge back to target — pool is
 * structurally hostile (no dust to remove, or dust value is too high) — the
 * function returns the redistributed weights unchanged and lets the caller's
 * edge-tolerance check decide accept/fallback.
 *
 * Skip conditions (returns the input weights unchanged + `applied=false`):
 *   • targetWinRate > 0.05 (not a lottery pack)
 *   • grail.length ≤ 1 (nothing to redistribute)
 *   • totalWeight ≤ 0 / price ≤ 0 (degenerate inputs)
 *   • totalGrailMass ≤ 0 (no grail mass — solver gave it all elsewhere)
 */
export function applyLotterySkew(input: {
  cards: { value: number }[];
  weights: number[];
  price: number;
  targetEdge: number;
  targetWinRate: number;
  beta?: number;
}): { weights: number[]; applied: boolean } {
  const beta = input.beta ?? 2.0;
  const { weights: original, price, targetEdge, targetWinRate } = input;

  // Trigger gate — only tagged lottery packs (1%/5%) get the steep skew.
  if (!(targetWinRate <= 0.05)) return { weights: original.slice(), applied: false };
  if (!(price > 0)) return { weights: original.slice(), applied: false };

  // Identify the grail band: value ≥ 5·price (same threshold the solver uses).
  type GrailSlot = { idx: number; value: number; weight: number };
  const grail: GrailSlot[] = [];
  let totalWeight = 0;
  let grailMass = 0;
  for (let i = 0; i < original.length; i++) {
    const w = original[i]!;
    if (!Number.isFinite(w) || w <= 0) continue;
    totalWeight += w;
    const v = input.cards[i]?.value;
    if (!Number.isFinite(v) || !(v! > 0)) continue;
    if (v! >= 5 * price) {
      grail.push({ idx: i, value: v!, weight: w });
      grailMass += w;
    }
  }
  if (!(totalWeight > 0)) return { weights: original.slice(), applied: false };
  if (grail.length <= 1) return { weights: original.slice(), applied: false };
  if (!(grailMass > 0)) return { weights: original.slice(), applied: false };

  // Power-law raw weights w_i = value_i^(-β); renormalize so the grail band
  // sums to EXACTLY grailMass (same total integer weight as before).
  const raw = grail.map((g) => Math.pow(g.value, -beta));
  const rawSum = raw.reduce((a, b) => a + b, 0);
  if (!(rawSum > 0)) return { weights: original.slice(), applied: false };

  const next = original.slice();
  // Distribute as integer weights summing to grailMass; floor each fractional
  // share, then dribble the remainder onto the largest fractional parts so
  // the total grail mass is preserved exactly. Each grail card keeps weight ≥ 1.
  const targets = raw.map((r, i) => {
    const share = (r / rawSum) * grailMass;
    return { i, share, floor: Math.max(1, Math.floor(share)) };
  });
  let remainder = grailMass;
  for (const t of targets) {
    next[grail[t.i]!.idx] = t.floor;
    remainder -= t.floor;
  }
  if (remainder !== 0) {
    if (remainder > 0) {
      const ranked = targets
        .map((t) => ({ i: t.i, frac: t.share - t.floor }))
        .sort((a, b) => b.frac - a.frac);
      let r = remainder;
      let k = 0;
      while (r > 0 && ranked.length > 0) {
        const slot = grail[ranked[k % ranked.length]!.i]!;
        next[slot.idx] = (next[slot.idx]! ?? 0) + 1;
        r -= 1;
        k += 1;
      }
    } else {
      let r = -remainder;
      const trimOrder = targets
        .map((t) => ({ i: t.i, frac: t.share - t.floor }))
        .sort((a, b) => a.frac - b.frac);
      let k = 0;
      const maxIter = trimOrder.length * 100 + 1;
      let iter = 0;
      while (r > 0 && iter < maxIter) {
        const slot = grail[trimOrder[k % trimOrder.length]!.i]!;
        if ((next[slot.idx] ?? 0) > 1) {
          next[slot.idx] = next[slot.idx]! - 1;
          r -= 1;
        }
        k += 1;
        iter += 1;
      }
    }
  }

  // ── Phase 2: EV-compensate by scaling DUST weights down ─────────────
  // Phase 1 lowered EV (more grail mass on cheap cards) → edge ROSE above
  // target. Removing dust mass raises the relative share of higher-value
  // bands, raising EV and lowering edge. Bisect the dust-scale factor s.
  // Identify dust cards (value < 0.5·price) with the original solver weights.
  type DustSlot = { idx: number; value: number; origWeight: number };
  const dustSlots: DustSlot[] = [];
  for (let i = 0; i < input.cards.length; i++) {
    const w = original[i]!;
    if (!Number.isFinite(w) || w <= 0) continue;
    const v = input.cards[i]?.value;
    if (!Number.isFinite(v) || !(v! > 0)) continue;
    if (v! < 0.5 * price) dustSlots.push({ idx: i, value: v!, origWeight: w });
  }
  if (dustSlots.length === 0) {
    // No dust to scale — return the redistribution as-is and let the caller's
    // edge-tolerance check decide accept/fallback.
    return { weights: next, applied: true };
  }

  const applyScale = (s: number): void => {
    for (const d of dustSlots) {
      // Scale + floor at 1 (a card with weight 0 effectively drops it).
      next[d.idx] = Math.max(1, Math.round(d.origWeight * s));
    }
  };
  const edgeAt = (s: number): number => {
    applyScale(s);
    const r = computePackRisk({
      cards: input.cards.map((c, i) => ({ value: c.value, weight: next[i]! })),
      price,
    });
    return r.edge;
  };

  // Bracket: at s=1 the dust is untouched (edge HIGH after phase 1); at s=0+
  // dust is minimal (edge LOWEST — typically below target). Bisect over s.
  // If the family doesn't bracket the target (edgeAt(0) > target), the pool
  // is structurally hostile — just leave the redistribution as-is.
  const edgeAt1 = edgeAt(1);
  const edgeAt0 = edgeAt(1e-9);
  if (edgeAt0 > targetEdge + 0.0005 || edgeAt1 < targetEdge) {
    // Either: even minimum dust can't bring edge down enough, or phase 1
    // somehow lowered edge below target (shouldn't happen). Restore the
    // post-phase-1 weights (s=1 == untouched dust) and return.
    applyScale(1);
    return { weights: next, applied: true };
  }
  // Monotone-INCREASING-in-s: higher s → more dust → lower EV → higher edge.
  // (More dust mass at low value drags average value down → EV down → edge up.)
  // So edge is INCREASING in s. Bisect: if edge > target, reduce s (less dust);
  // if edge < target, raise s (more dust).
  let lo = 1e-9;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const e = edgeAt(mid);
    if (e > targetEdge) hi = mid;
    else lo = mid;
  }
  // Final commit at hi (edge just above target — one-sided-up invariant).
  applyScale(hi);

  return { weights: next, applied: true };
}

// ─── Clean-ladder snap (human-readable odds post-process) ─────────────
//
// The solver produces edge-correct weights that, expressed as percentages,
// often read as awkward decimals like `0.0132%` or `0.0173%`. A human pack
// designer would pick clean round numbers — `0.01%`, `0.015%`, `10%`, `89%`.
// This post-process snaps each card's probability to the nearest value on a
// fixed ladder of "nice" decimals (by log distance, which handles the wide
// dynamic range from sub-basis-point dust odds to dominant floor cards), then
// re-normalizes the snapped masses to sum to 1 and converts back to integer
// weights. The caller decides whether to keep the snapped result (when edge
// stays within tolerance) or fall back to the precise weights (safe default).

/** Base magnitudes of the clean ladder — multiplied across decades below. */
const CLEAN_LADDER_BASE = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10, 15, 20, 25, 30, 40, 50, 75] as const;

/**
 * Full clean ladder (in PERCENT units), scaled across decades from 1e-6%
 * (0.0001% basis-point territory) up to 100%. Values strictly in (0, 100)
 * are generated from the base, and 100 is appended so the upper edge of the
 * dynamic range is representable. Sorted ascending, no duplicates by
 * construction (each decade is a distinct order of magnitude).
 */
const CLEAN_LADDER: readonly number[] = (() => {
  const out: number[] = [];
  for (let decade = -6; decade <= 1; decade++) {
    for (const b of CLEAN_LADDER_BASE) {
      const v = b * Math.pow(10, decade);
      if (v > 0 && v < 100) out.push(v);
    }
  }
  out.push(100);
  out.sort((a, b) => a - b);
  return out;
})();

/**
 * Snap each weight in `input.weights` to the nearest clean-ladder probability
 * percentage (log-distance argmin), using a **buffer-card residual** scheme to
 * keep the total at exactly 100% without re-normalizing every rung. Pure: no
 * mutation of the input.
 *
 * Algorithm — why buffer-residual instead of "snap-then-renormalize":
 *
 *   The previous naive approach snapped EVERY card to a rung, then multiplied
 *   by `100 / pctSum` to renormalize. That multiplier is rarely exactly 1, so
 *   a "clean" 0.05% rung came out as 0.0521% — defeating the entire purpose.
 *
 *   The buffer scheme picks ONE card — the card carrying the largest mass
 *   (typically the dust card) — and treats it as the residual. Every OTHER
 *   card is snapped to a clean rung, and the buffer card takes whatever is
 *   left so the total stays exactly 100%. This way N-1 cards land on
 *   genuinely-clean numbers (0.05%, 0.1%, 10%, 25%, ...), and the single
 *   buffer card absorbs the rounding into its (already large) share. From
 *   a human-readability standpoint the buffer's pct is the LEAST important
 *   to be "clean" — it's the dust that swallows the house edge.
 *
 * Steps:
 *   1. Convert weights → percentages.
 *   2. Identify the BUFFER index = argmax(pct).
 *   3. For every non-buffer card, snap pct to the nearest CLEAN_LADDER rung
 *      via log10-distance argmin (handles the wide dynamic range).
 *   4. Buffer pct = 100 − sum(non-buffer snapped pcts). NOT snapped — exact
 *      residual.
 *   5. Convert all pcts → integer weights via ×10000 (so 0.0001% rungs are
 *      still representable as weight ≥ 1). Every originally-positive card
 *      keeps weight ≥ 1 so none silently disappears.
 *
 * Returns the snapped integer weight vector. `edgeDelta` is left at 0 — the
 * caller already recomputes risk via `computePackRisk` to decide accept/reject,
 * and the snap intentionally doesn't take card values so it can be reused.
 *
 * Safety fallback: if the buffer residual would go negative (the snapped
 * non-buffer pcts already sum to ≥ 100%) or any other degeneracy, the original
 * weights are returned unchanged. The caller's accept/reject pass then keeps
 * the precise weights — no regression possible from the snap itself.
 */
export function snapWeightsToCleanLadder(input: {
  weights: number[];
  price: number;
}): { weights: number[]; edgeDelta: number } {
  const original = input.weights;
  const price = input.price;

  let totalWeight = 0;
  for (const w of original) {
    if (Number.isFinite(w) && w > 0) totalWeight += w;
  }
  // Degenerate inputs: nothing to snap, no delta.
  if (!(totalWeight > 0) || !(price > 0)) {
    return { weights: original.slice(), edgeDelta: 0 };
  }

  // Step 1: compute percentages + identify the buffer index (argmax pct).
  // Slots with non-positive weights stay at pct=0 and are NEVER eligible as the
  // buffer (they carry no mass to absorb the residual).
  const pcts = new Array<number>(original.length).fill(0);
  let bufferIdx = -1;
  let bufferPct = -Infinity;
  for (let i = 0; i < original.length; i++) {
    const w = original[i]!;
    if (!Number.isFinite(w) || w <= 0) continue;
    const p = (w / totalWeight) * 100;
    pcts[i] = p;
    if (p > bufferPct) {
      bufferPct = p;
      bufferIdx = i;
    }
  }
  if (bufferIdx < 0) {
    // No positive-weight slot found (defensive: totalWeight > 0 above already
    // guarantees at least one such slot exists).
    return { weights: original.slice(), edgeDelta: 0 };
  }

  // Step 2: snap each non-buffer slot's pct to the nearest ladder rung.
  // log10-distance is the right metric across the wide dynamic range (sub-
  // basis-point jackpots next to >50% dust). A linear nearest-neighbour would
  // collapse every tiny pct onto the smallest rung.
  const snappedPct = new Array<number>(original.length).fill(0);
  let nonBufferSum = 0;
  for (let i = 0; i < original.length; i++) {
    if (i === bufferIdx) continue;
    const p = pcts[i]!;
    if (!(p > 0)) continue;
    const logP = Math.log10(p);
    let bestIdx = 0;
    let bestDist = Math.abs(Math.log10(CLEAN_LADDER[0]!) - logP);
    for (let k = 1; k < CLEAN_LADDER.length; k++) {
      const d = Math.abs(Math.log10(CLEAN_LADDER[k]!) - logP);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = k;
      }
    }
    snappedPct[i] = CLEAN_LADDER[bestIdx]!;
    nonBufferSum += snappedPct[i]!;
  }

  // Step 3: buffer pct = 100 − sum(non-buffer). Exact residual, NOT snapped.
  // If the non-buffer cards already sum to ≥ 100% the buffer would go ≤ 0 —
  // safety fallback: return the original weights unchanged.
  const bufferResidual = 100 - nonBufferSum;
  if (!(bufferResidual > 0)) {
    return { weights: original.slice(), edgeDelta: 0 };
  }
  snappedPct[bufferIdx] = bufferResidual;

  // Step 4: convert back to integer weights via ×10000 multiplier (so 0.0001%
  // snapped rungs are still representable as weight ≥ 1). Every originally-
  // positive card keeps weight ≥ 1 so no kept card silently disappears.
  const MULT = 10000;
  const snappedWeights = new Array<number>(original.length).fill(0);
  for (let i = 0; i < original.length; i++) {
    const w = original[i]!;
    if (!Number.isFinite(w) || w <= 0) continue;
    snappedWeights[i] = Math.max(1, Math.round(snappedPct[i]! * MULT));
  }

  // edgeDelta is computed by the CALLER (it has card values for the risk
  // recompute). The post-process intentionally doesn't take card values, so it
  // can be reused in any pipeline. Returned as 0 here as a placeholder.
  void price;
  return { weights: snappedWeights, edgeDelta: 0 };
}

/**
 * Repair the within-band monotonicity invariants on a snapped weight vector.
 *
 * Owner-facing invariants (designer rules — packs are read by humans):
 *   1. WITHIN EACH BAND (GRAIL, WIN, NEARMISS, DUST), as card value DESCENDS,
 *      probability must NON-DECREASE. I.e., if card A is more expensive than
 *      card B (both in same band), `pct[A] <= pct[B]`. Never `>`.
 *   2. STRICT RARITY AT GRAIL TOP: the most-expensive grail card must be at a
 *      STRICTLY LOWER ladder rung than the second-most-expensive grail card.
 *      No tie at the top — the headline jackpot is the rarest pull.
 *
 * The base buffer-residual snap (above) can violate both: log-nearest rounding
 * makes adjacent cards collapse onto the same rung or zigzag across rungs. This
 * helper walks each band cheapest→most-expensive and DEMOTES any violator to
 * the next-lower ladder rung. Buffer card stays untouched; non-buffer pcts that
 * weren't on the ladder to begin with (already-buffer or zero-weight slots) are
 * left alone. After repair, the buffer residual is recomputed so the total
 * stays at 100%.
 *
 * Returns `{ weights, ok }`. `ok=false` when a demotion would push a card below
 * the smallest ladder rung — caller falls back to the precise weights (safe
 * default, never regresses).
 */
function repairSnapMonotonicity(input: {
  weights: number[];
  values: number[];
  price: number;
}): { weights: number[]; ok: boolean } {
  const { weights, values, price } = input;
  const n = weights.length;
  if (!(price > 0)) return { weights: weights.slice(), ok: true };

  let totalWeight = 0;
  for (const w of weights) {
    if (Number.isFinite(w) && w > 0) totalWeight += w;
  }
  if (!(totalWeight > 0)) return { weights: weights.slice(), ok: true };

  // Step 1: pcts + buffer = argmax.
  const pcts = new Array<number>(n).fill(0);
  let bufferIdx = -1;
  let bufferPct = -Infinity;
  for (let i = 0; i < n; i++) {
    const w = weights[i]!;
    if (!Number.isFinite(w) || w <= 0) continue;
    const p = (w / totalWeight) * 100;
    pcts[i] = p;
    if (p > bufferPct) {
      bufferPct = p;
      bufferIdx = i;
    }
  }
  if (bufferIdx < 0) return { weights: weights.slice(), ok: true };

  // Step 2: find each non-buffer card's ladder rung index (log-nearest).
  const rungIdx = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (i === bufferIdx) continue;
    if (!(pcts[i]! > 0)) continue;
    const logP = Math.log10(pcts[i]!);
    let best = 0;
    let bestDist = Math.abs(Math.log10(CLEAN_LADDER[0]!) - logP);
    for (let k = 1; k < CLEAN_LADDER.length; k++) {
      const d = Math.abs(Math.log10(CLEAN_LADDER[k]!) - logP);
      if (d < bestDist) {
        bestDist = d;
        best = k;
      }
    }
    rungIdx[i] = best;
  }

  // Step 3: classify into bands; sort each band by value DESC (most-expensive first).
  const grail: number[] = [];
  const win: number[] = [];
  const nearMiss: number[] = [];
  const dust: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === bufferIdx) continue;
    if (rungIdx[i] < 0) continue;
    const v = values[i]!;
    if (!(v > 0) || !Number.isFinite(v)) continue;
    if (v >= 5 * price) grail.push(i);
    else if (v >= price) win.push(i);
    else if (v >= 0.5 * price) nearMiss.push(i);
    else dust.push(i);
  }
  const byValueDesc = (a: number, b: number) => values[b]! - values[a]!;
  grail.sort(byValueDesc);
  win.sort(byValueDesc);
  nearMiss.sort(byValueDesc);
  dust.sort(byValueDesc);

  // Step 4: within each band, walk second-cheapest → most-expensive,
  // demote any violator so `rungIdx[expensive] <= rungIdx[cheaper]`.
  for (const band of [grail, win, nearMiss, dust]) {
    for (let i = band.length - 2; i >= 0; i--) {
      const expensive = band[i]!;
      const cheaper = band[i + 1]!;
      while (rungIdx[expensive]! > rungIdx[cheaper]!) {
        if (rungIdx[expensive]! === 0) {
          return { weights: weights.slice(), ok: false };
        }
        rungIdx[expensive] = rungIdx[expensive]! - 1;
      }
    }
  }

  // Step 5: STRICT inequality at GRAIL top — top card must be at a STRICTLY
  // lower rung than the second card. No ties at the top.
  if (grail.length >= 2) {
    const top = grail[0]!;
    const second = grail[1]!;
    while (rungIdx[top]! >= rungIdx[second]!) {
      if (rungIdx[top]! === 0) {
        return { weights: weights.slice(), ok: false };
      }
      rungIdx[top] = rungIdx[top]! - 1;
    }
  }

  // Step 6: apply repaired ladder pcts back into the pcts array.
  for (let i = 0; i < n; i++) {
    if (i === bufferIdx) continue;
    if (rungIdx[i]! < 0) continue;
    pcts[i] = CLEAN_LADDER[rungIdx[i]!]!;
  }

  // Step 7: recompute buffer residual to keep total at 100%.
  let nonBufferSum = 0;
  for (let i = 0; i < n; i++) {
    if (i === bufferIdx) continue;
    nonBufferSum += pcts[i]!;
  }
  const bufferResidual = 100 - nonBufferSum;
  if (!(bufferResidual > 0)) {
    return { weights: weights.slice(), ok: false };
  }
  pcts[bufferIdx] = bufferResidual;

  // Step 8: convert back to integer weights via the same ×10000 multiplier
  // used by the snap. Each originally-positive card keeps weight ≥ 1.
  const MULT = 10000;
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const w = weights[i]!;
    if (!Number.isFinite(w) || w <= 0) continue;
    out[i] = Math.max(1, Math.round(pcts[i]! * MULT));
  }
  return { weights: out, ok: true };
}

/**
 * Local-search refinement around a buffer-residual snap. Used by `shapeWeights`
 * AFTER the basic snap when the resulting edge drifts outside the accept
 * tolerance. Pure: returns a NEW weight vector or `null` when no combination
 * lands within tolerance.
 *
 * Strategy:
 *   1. Convert weights → snapped pcts (via the same buffer-residual snap).
 *   2. Identify the N non-buffer cards whose snap delta moved the most EV
 *      (|deltaPct · value|). These are the cards to wiggle.
 *   3. For the TOP `searchTop` cards (default 5), enumerate the 3 ladder
 *      positions (one rung DOWN / SAME / one rung UP) — 3^searchTop combos
 *      (default 243). For each combo: recompute the buffer residual, build
 *      the weight vector, recompute the risk, and track the combo with the
 *      smallest |edge − targetEdge| that still satisfies edge ≥ targetEdge.
 *   4. Return the winning weight vector if its drift is within `tolerance`
 *      (default 0.0005 = 0.05pp); otherwise `null` (caller falls back to the
 *      precise weights — never regresses).
 */
function snapLocalSearchRefine(input: {
  weights: number[];
  values: number[];
  price: number;
  targetEdge: number;
  tolerance?: number;
  searchTop?: number;
  /** Per-card ladder-offset radius (e.g. 1 = wiggle ±1 rung; 2 = ±2 rungs). */
  searchRadius?: number;
  /** Win-rate of the precise solution — the snap must stay within `winRateTol`. */
  preciseWinRate?: number;
  winRateTol?: number;
}): { weights: number[]; edge: number; winRate: number } | null {
  const { weights: original, values, price, targetEdge } = input;
  const tolerance = input.tolerance ?? 0.0005;
  const searchTop = input.searchTop ?? 5;
  const searchRadius = input.searchRadius ?? 1;
  const preciseWinRate = input.preciseWinRate;
  const winRateTol = input.winRateTol ?? 0.02;

  let totalWeight = 0;
  for (const w of original) {
    if (Number.isFinite(w) && w > 0) totalWeight += w;
  }
  if (!(totalWeight > 0) || !(price > 0)) return null;

  // Identify the buffer (argmax-pct) slot.
  const pcts = new Array<number>(original.length).fill(0);
  let bufferIdx = -1;
  let bufferPct = -Infinity;
  for (let i = 0; i < original.length; i++) {
    const w = original[i]!;
    if (!Number.isFinite(w) || w <= 0) continue;
    const p = (w / totalWeight) * 100;
    pcts[i] = p;
    if (p > bufferPct) {
      bufferPct = p;
      bufferIdx = i;
    }
  }
  if (bufferIdx < 0) return null;

  // For each non-buffer slot, find its log-nearest ladder index. The local
  // search wiggles each of the top-N cards by ±1 ladder index around that base.
  type Slot = {
    idx: number;
    baseLadderIdx: number;
    value: number;
    deltaEvImpact: number; // |deltaPct · value| — proxy for EV sensitivity
  };
  const nonBuffer: Slot[] = [];
  for (let i = 0; i < original.length; i++) {
    if (i === bufferIdx) continue;
    const p = pcts[i]!;
    if (!(p > 0)) continue;
    const logP = Math.log10(p);
    let bestIdx = 0;
    let bestDist = Math.abs(Math.log10(CLEAN_LADDER[0]!) - logP);
    for (let k = 1; k < CLEAN_LADDER.length; k++) {
      const d = Math.abs(Math.log10(CLEAN_LADDER[k]!) - logP);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = k;
      }
    }
    const v = values[i] ?? 0;
    const snappedP = CLEAN_LADDER[bestIdx]!;
    nonBuffer.push({
      idx: i,
      baseLadderIdx: bestIdx,
      value: v,
      deltaEvImpact: Math.abs(snappedP - p) * v,
    });
  }

  // Sort by EV impact desc; the top-N cards are the ones we wiggle.
  nonBuffer.sort((a, b) => b.deltaEvImpact - a.deltaEvImpact);
  const wiggleSlots = nonBuffer.slice(0, Math.min(searchTop, nonBuffer.length));
  const fixedSlots = nonBuffer.slice(wiggleSlots.length);

  // Sum of non-wiggle, non-buffer snapped pcts is constant across combos.
  let fixedSum = 0;
  for (const s of fixedSlots) fixedSum += CLEAN_LADDER[s.baseLadderIdx]!;

  // Enumerate B^N combos where B = 2·searchRadius + 1 (offsets {−r..+r} per
  // wiggle). Each combo defines: pct[wiggleSlots[k]] = CLEAN_LADDER[base + offset].
  // Compute buffer = 100 − fixedSum − Σ wigglePcts. Reject if ≤ 0 (degenerate).
  const OFFSETS: number[] = [];
  for (let r = -searchRadius; r <= searchRadius; r++) OFFSETS.push(r);
  const B = OFFSETS.length;
  const N = wiggleSlots.length;
  const totalCombos = Math.pow(B, N);
  const MULT = 10000;

  let bestEdge = NaN;
  let bestWinRate = NaN;
  let bestDrift = Infinity;
  let bestWeights: number[] | null = null;

  // Pre-fill the constant fixed-slot weights into a reusable buffer.
  const weightsTemplate = new Array<number>(original.length).fill(0);
  for (const s of fixedSlots) {
    const p = CLEAN_LADDER[s.baseLadderIdx]!;
    weightsTemplate[s.idx] = Math.max(1, Math.round(p * MULT));
  }
  // Also copy any originally-positive slots that are NOT non-buffer + NOT
  // buffer — defensive: shouldn't happen (pcts covers all positive), but a
  // zero-pct slot can exist for a value-skipped row. Keep them at 0.

  for (let combo = 0; combo < totalCombos; combo++) {
    let wiggleSum = 0;
    let degenerate = false;
    // Decode combo digits in base-B.
    let c = combo;
    const wigglePcts = new Array<number>(N);
    for (let k = 0; k < N; k++) {
      const digit = c % B;
      c = Math.floor(c / B);
      const ladderIdx = wiggleSlots[k]!.baseLadderIdx + OFFSETS[digit]!;
      if (ladderIdx < 0 || ladderIdx >= CLEAN_LADDER.length) {
        degenerate = true;
        break;
      }
      const p = CLEAN_LADDER[ladderIdx]!;
      wigglePcts[k] = p;
      wiggleSum += p;
    }
    if (degenerate) continue;

    const bufferResidual = 100 - fixedSum - wiggleSum;
    if (!(bufferResidual > 0)) continue;

    // Build the weight vector for this combo.
    const w = weightsTemplate.slice();
    for (let k = 0; k < N; k++) {
      const s = wiggleSlots[k]!;
      w[s.idx] = Math.max(1, Math.round(wigglePcts[k]! * MULT));
    }
    w[bufferIdx] = Math.max(1, Math.round(bufferResidual * MULT));

    // Recompute the edge via the canonical scorer.
    const cards: CardLite[] = values.map((v, i) => ({ value: v, weight: w[i]! }));
    const risk = computePackRisk({ cards, price });
    const drift = Math.abs(risk.edge - targetEdge);

    // Prefer combos that satisfy edge ≥ target (the one-sided-up invariant)
    // AND keep win-rate within tol of the precise solver's result (the snap
    // must not drift win-rate outside the soft-target window — check #7's
    // sweep asserts this). Among satisfying combos, smaller edge-drift wins.
    const edgeOk = risk.edge >= targetEdge - 1e-9;
    const winRateOk =
      preciseWinRate === undefined ||
      Math.abs(risk.winRate - preciseWinRate) <= winRateTol + 1e-9;
    if (edgeOk && winRateOk && drift < bestDrift) {
      bestDrift = drift;
      bestEdge = risk.edge;
      bestWinRate = risk.winRate;
      bestWeights = w;
    }
  }

  if (bestWeights !== null && bestDrift <= tolerance) {
    return { weights: bestWeights, edge: bestEdge, winRate: bestWinRate };
  }
  return null;
}

/**
 * Design a per-card weight vector so a pack lands on a target edge + win-rate.
 *
 * Direction is the inverse of scoring: given fixed card VALUES, choose weights.
 * Banding (relative to price): GRAIL ≥ 5p, WIN [p,5p), NEARMISS [0.5p,p),
 * DUST < 0.5p. Win-rate mass = grail+win; near-miss mass = NEARMISS; the
 * remainder is DUST mass (which must be > 0 — a pack needs losing outcomes).
 *
 * Within each band, probability is power-law distributed by value^(−beta); the
 * DUST band's beta is the free knob binary-searched (it is the most EV-elastic
 * band) so the total EV lands exactly on ev* = price·(1 − targetEdge).
 *
 * GRACEFUL RELAXATION: the near-miss floor, the modal-floor pin, and the
 * win-rate target are all SOFT. When the pool genuinely cannot honour one of
 * them, the solver does NOT fail — it RELAXES the soft target down to the
 * achievable maximum (possibly 0), proceeds, and records what it gave up in
 * `relaxations`. The edge target stays HARD (one-sided-up: edge ≥ targetEdge in
 * every success). HARD errors are reserved for the truly impossible: no
 * win/grail card at all, a required EV outside the pool's min/max value range,
 * or a degenerate single-value pool (no value spread → no edge can be shaped).
 *
 * Returns EITHER a success `{weights,risk,ev,edge,relaxations}` (weights =
 * positive ints, gcd-reduced; relaxations empty when nothing relaxed) OR an
 * error `{error,feasibility?,limit}` (limit = structured kind/detail/suggestion).
 * The two arms are DISJOINT — success has weights+relaxations, an error has
 * error+limit, never both.
 */
export function shapeWeights(input: ShapeWeightsInput): ShapeWeightsResult {
  const price = input.price;
  const targetEdge = input.targetEdge ?? TARGET_HOUSE_EDGE;
  const requestedWinRate = input.targetWinRate;
  const requestedNearMissMin = input.nearMissMin ?? 0.1;
  const winRateTol = input.winRateTol ?? 0.02;
  const maxWinCap = input.maxWinCap;
  const floorRatioMin = input.floorRatioMin;

  // Soft targets the solver had to loosen. Filled in as we go; empty on a clean run.
  const relaxations: ShapeWeightsRelaxation[] = [];

  if (!(price > 0)) {
    return {
      error: "Price must be positive.",
      limit: {
        kind: "invalid-price",
        detail: `Price must be a positive number; got ${price}.`,
        suggestion: "Set a pack price greater than $0.",
      },
    };
  }
  if (!Number.isFinite(targetEdge) || targetEdge <= 0 || targetEdge >= 1) {
    return {
      error: "Target edge must be between 0 and 1 (exclusive).",
      limit: {
        kind: "invalid-target-edge",
        detail: `Target edge must lie strictly between 0 and 1; got ${targetEdge}.`,
        suggestion: "Use a target edge like 0.1099 (10.99%).",
      },
    };
  }
  if (!Number.isFinite(requestedWinRate) || requestedWinRate < 0 || requestedWinRate >= 1) {
    return {
      error: "Target win-rate must be in [0, 1).",
      limit: {
        kind: "invalid-target-win-rate",
        detail: `Target win-rate must lie in [0, 1); got ${requestedWinRate}.`,
        suggestion: "Use a win-rate target like 0.2 (20%).",
      },
    };
  }

  // Index-preserving pool: drop value ≤ 0 and (if capped) value > cap.
  type Slot = { idx: number; value: number; band: Band };
  const slots: Slot[] = [];
  input.cards.forEach((c, idx) => {
    const v = c.value;
    if (!(v > 0)) return;
    if (maxWinCap !== undefined && v > maxWinCap) return;
    let band: Band;
    if (v >= 5 * price) band = "GRAIL";
    else if (v >= price) band = "WIN";
    else if (v >= 0.5 * price) band = "NEARMISS";
    else band = "DUST";
    slots.push({ idx, value: v, band });
  });

  if (slots.length === 0) {
    return {
      error: "No usable cards after dropping non-positive / over-cap values.",
      limit: {
        kind: "empty-pool",
        detail:
          maxWinCap !== undefined
            ? `Every card has value ≤ 0 or exceeds the max-win cap of $${maxWinCap.toFixed(2)}.`
            : "Every card has a non-positive value.",
        suggestion:
          maxWinCap !== undefined
            ? `Add at least one card priced above $0 and at or below the $${maxWinCap.toFixed(2)} cap (Builder/card editor).`
            : "Add at least one card with a positive value (Builder/card editor).",
      },
    };
  }

  const grail = slots.filter((s) => s.band === "GRAIL");
  const win = slots.filter((s) => s.band === "WIN");
  const nearMiss = slots.filter((s) => s.band === "NEARMISS");
  const dust = slots.filter((s) => s.band === "DUST");

  const minValue = Math.min(...slots.map((s) => s.value));
  const maxValue = Math.max(...slots.map((s) => s.value));
  const evTarget = price * (1 - targetEdge);

  const feasibility: Record<string, unknown> = {
    price,
    targetEdge,
    targetWinRate: requestedWinRate,
    nearMissMin: requestedNearMissMin,
    evTarget,
    minValue,
    maxValue,
    bands: { grail: grail.length, win: win.length, nearMiss: nearMiss.length, dust: dust.length },
  };

  const tol = 1e-9;

  // Pre-compute helpers for band-aware messaging.
  // The WIN band is [price, 5·price); GRAIL is ≥ 5·price; NEARMISS is [0.5·price,
  // price); DUST is < 0.5·price. The price formatting style is the same
  // `$X.XX` form used elsewhere in this file so the error strings read uniformly.
  const winLo = price;
  const winHi = 5 * price;
  const dustHi = 0.5 * price;

  // Detect whether the maxWinCap pre-filter actually DROPPED cards from the
  // input pool. When the cap is the reason the pool ended up with no win-band
  // cards, the error message is more useful if it says so directly (rather than
  // implying the pool is intrinsically too cheap).
  const capDroppedCount =
    maxWinCap !== undefined
      ? input.cards.reduce(
          (n, c) => (Number.isFinite(c.value) && c.value > maxWinCap ? n + 1 : n),
          0,
        )
      : 0;

  // ── HARD limit 1: need at least one win/grail card to make ANY win-rate ──
  if (grail.length + win.length === 0) {
    // Two distinct sub-cases: (a) the cap pre-filter stripped what would have
    // been win/grail cards, or (b) the pool intrinsically has no card ≥ price.
    if (maxWinCap !== undefined && capDroppedCount > 0) {
      return {
        error: `Auto-cap filter removed ${capDroppedCount} card(s) above $${maxWinCap.toFixed(2)}; after filtering, pool has no card worth ≥ the $${price.toFixed(2)} price.`,
        feasibility,
        limit: {
          kind: "no-win-cards",
          detail: `Auto-cap filter removed ${capDroppedCount} card(s) above $${maxWinCap.toFixed(2)}. After filtering, pool has no card worth ≥ $${price.toFixed(2)} (the WIN/GRAIL bands are empty).`,
          suggestion: `Either add a card priced between $${price.toFixed(2)} and $${maxWinCap.toFixed(2)} (a small-win card to host the win mass), OR raise the pack's max-win cap so the stripped jackpot card(s) can stay.`,
          suggestedRange: { min: price, max: maxWinCap },
        },
      };
    }
    return {
      error: "No win/grail cards (value ≥ price): cannot produce a non-zero win-rate.",
      feasibility,
      limit: {
        kind: "no-win-cards",
        detail: `Pool has no card priced at or above $${price.toFixed(2)} (the WIN and GRAIL bands are empty). The win mass has nowhere to land.`,
        suggestion: `Add at least one card priced between $${price.toFixed(2)} and $${winHi.toFixed(2)} (a small-win card to host the win mass).`,
        suggestedRange: { min: price, max: winHi },
      },
    };
  }

  // ── HARD limit 1b (NEW): grail-only pool can't satisfy edge + win-rate ──
  // When the pool has GRAIL cards (≥ 5·price) but no WIN-band card in
  // [price, 5·price), the minimum achievable EV at the target win-rate may be
  // higher than evTarget. The min EV is achieved by putting all win-rate mass
  // on the cheapest GRAIL card and all remaining mass on the cheapest non-grail
  // card (preferring DUST, the cheapest band). If even THAT minimum EV exceeds
  // evTarget, the solver cannot simultaneously hit the target edge AND the
  // target win-rate without a small-win card to host the win mass.
  //
  // This is the "1% 18 PLUS" situation: a $1.25 pack with a $0.08 dust card and
  // 16 jackpots at $60+. At a 1% target win-rate the cheapest grail (~$60)
  // forces an EV that's structurally too high — the edge can't drop low enough.
  // Without this pre-check the solver would later return `ev-unreachable-for-
  // split`, but the surfaced message wouldn't tell the operator WHICH band is
  // missing or what price range to add.
  if (win.length === 0 && grail.length > 0) {
    const cheapestGrail = Math.min(...grail.map((s) => s.value));
    const nonGrail = slots.filter((s) => s.band !== "GRAIL");
    const cheapestOther =
      nonGrail.length > 0
        ? Math.min(...nonGrail.map((s) => s.value))
        : cheapestGrail; // pool is grail-only, no slack possible
    const minEvAtWinRate =
      requestedWinRate * cheapestGrail + (1 - requestedWinRate) * cheapestOther;
    if (minEvAtWinRate > evTarget + tol) {
      const exampleA = Math.max(price, 2 * price);
      const exampleB = Math.max(price, 4 * price);
      return {
        error: `No WIN-band card: ${grail.length} jackpot card(s) ≥ $${winHi.toFixed(2)} but none in $${winLo.toFixed(2)}–$${winHi.toFixed(2)}. At ${(requestedWinRate * 100).toFixed(2)}% win-rate the min EV $${minEvAtWinRate.toFixed(2)} exceeds the target EV $${evTarget.toFixed(2)}.`,
        feasibility: { ...feasibility, minEvAtWinRate, cheapestGrail, cheapestOther },
        limit: {
          kind: "no-win-band-card",
          detail: `Pool has ${grail.length} jackpot card(s) ≥ $${winHi.toFixed(2)} but no small-win card in $${winLo.toFixed(2)}–$${winHi.toFixed(2)}. With a ${(requestedWinRate * 100).toFixed(2)}% target win-rate, the math can't simultaneously hit the target edge ${(targetEdge * 100).toFixed(2)}% — even the cheapest jackpot (≈$${cheapestGrail.toFixed(2)}) carries too much value for the ${(requestedWinRate * 100).toFixed(2)}% win-rate.`,
          suggestion: `Add 1-2 cards priced between $${winLo.toFixed(2)} and $${winHi.toFixed(2)} (e.g. one around $${exampleA.toFixed(2)} and one around $${exampleB.toFixed(2)}). The retune will distribute weights for you.`,
          suggestedRange: { min: winLo, max: winHi },
        },
      };
    }
  }

  // ── HARD limit 2: a degenerate single-value pool cannot host an edge ──
  // With every usable card at the same value, EV is pinned to that value: the
  // distribution has zero spread, so the edge is fixed and cannot be shaped.
  if (maxValue - minValue <= tol) {
    return {
      error: `Degenerate pool: every usable card is worth $${minValue.toFixed(2)}, so the edge is fixed and cannot be shaped.`,
      feasibility,
      limit: {
        kind: "degenerate-pool",
        detail: `All cards in the pool have the same value $${minValue.toFixed(2)}. Cannot shape an edge from a single value — without spread, EV is pinned to that one price.`,
        suggestion: `Add variety: at least one card at a different price tier (e.g. a DUST card below $${dustHi.toFixed(2)} or a small-win card between $${winLo.toFixed(2)} and $${winHi.toFixed(2)}).`,
      },
    };
  }

  // ── HARD limit 3: required ev* must lie within the pool's value range ──
  // (Same bound logic as computeOddsForTargetEv: a normalized mix can only land
  // between the pool min and max — no choice of weights can escape that range.)
  if (evTarget < minValue - tol || evTarget > maxValue + tol) {
    const tooLow = evTarget < minValue;
    return {
      error: `Target EV $${evTarget.toFixed(4)} is out of range; pool values span $${minValue.toFixed(2)}–$${maxValue.toFixed(2)}.`,
      feasibility,
      limit: {
        kind: "ev-out-of-range",
        detail: tooLow
          ? `Target EV $${evTarget.toFixed(2)} for a ${(targetEdge * 100).toFixed(2)}% edge is BELOW the pool's minimum value $${minValue.toFixed(2)}; no weighting can pull EV down to the target.`
          : `Target EV $${evTarget.toFixed(2)} for a ${(targetEdge * 100).toFixed(2)}% edge is ABOVE the pool's maximum value $${maxValue.toFixed(2)}; no weighting can lift EV up to the target.`,
        suggestion: tooLow
          ? `Add cheaper cards in the DUST band (< $${dustHi.toFixed(2)}) so the EV can be pulled down to $${evTarget.toFixed(2)}.`
          : `Add higher-value cards in the WIN band ($${winLo.toFixed(2)}–$${winHi.toFixed(2)}) or GRAIL band (≥ $${winHi.toFixed(2)}) so the EV can reach $${evTarget.toFixed(2)}.`,
        suggestedRange: tooLow
          ? { min: 0, max: dustHi }
          : { min: winLo, max: winHi },
      },
    };
  }

  // ── SOFT relaxation: near-miss floor ────────────────────────────────
  // Near-miss is a feel dial, not a hard constraint. If the pool has NO
  // near-miss cards [0.5·price, price), or the requested floor can't fit the
  // mass budget, relax it down to the achievable maximum (possibly 0).
  let nearMissMin = requestedNearMissMin;
  if (nearMissMin > tol && nearMiss.length === 0) {
    relaxations.push({
      lever: "nearMiss",
      requested: requestedNearMissMin,
      applied: 0,
      reason: "Pool has no near-miss cards in [0.5·price, price); near-miss mass relaxed to 0.",
    });
    nearMissMin = 0;
  }

  // ── HARD limit 4: need dust cards to host the losing mass / EV slack ──
  // The one-sided-up edge enforcement nudges the cheapest DUST card, so a dust
  // card must exist to carry the losing mass and the post-quantize EV slack.
  if (dust.length === 0) {
    return {
      error: "No dust cards (value < 0.5·price): nothing to carry the losing mass / EV slack.",
      feasibility,
      limit: {
        kind: "no-dust-cards",
        detail: `Pool has no DUST card (< $${dustHi.toFixed(2)}, half the $${price.toFixed(2)} price). The losing mass has nowhere to sit, so the house edge can't be shaped.`,
        suggestion: `Add one or more low-value cards priced under $${dustHi.toFixed(2)} (Builder/card editor) so the house edge has somewhere to sit.`,
        suggestedRange: { min: 0, max: dustHi },
      },
    };
  }

  // ── SOFT relaxation: win-rate vs the available mass budget ──────────
  // A pack always needs SOME losing (dust) mass to carry the house edge. If win
  // + near-miss would consume (nearly) all the probability mass, the win-rate is
  // too high for this split — relax it DOWN to leave a small dust margin rather
  // than erroring.
  const MIN_DUST_MARGIN = 0.02; // keep ≥2% dust mass for the edge
  const winMassCeiling = 1 - nearMissMin - MIN_DUST_MARGIN;
  let targetWinRate = requestedWinRate;
  if (targetWinRate > winMassCeiling) {
    const applied = Math.max(0, winMassCeiling);
    relaxations.push({
      lever: "winRate",
      requested: requestedWinRate,
      applied,
      reason: `Win-rate ${requestedWinRate} + near-miss ${nearMissMin} leave no dust mass for the house edge; relaxed to ${applied.toFixed(4)}.`,
    });
    targetWinRate = applied;
  }

  // ── SOFT relaxation: win-rate vs EV feasibility ─────────────────────
  // Even within the mass budget, too much mass on win/grail cards (which pay
  // ≥ price) pins the MINIMUM achievable EV above the edge target — a high
  // win-rate is simply incompatible with a positive house edge. The minimum EV
  // (every band skewed cheap, beta→HI) is linear in the win mass wr:
  //   evMin(wr) = wr·winCheap + nmMass·nmCheap + (1−wr−nmMass)·dustCheap
  // which RISES with wr (winCheap ≥ price > dustCheap). So the largest win mass
  // that still admits the edge is the wr solving evMin(wr) = evTarget. If the
  // requested win-rate exceeds that, relax DOWN to it rather than erroring.
  {
    const nmMassForBound = nearMiss.length > 0 ? nearMissMin : 0;
    const winCheap = bandEvForBeta(
      [...grail, ...win].map((s) => s.value),
      BETA_HI,
    );
    const nmCheap = bandEvForBeta(nearMiss.map((s) => s.value), BETA_HI);
    const dustCheap = bandEvForBeta(dust.map((s) => s.value), BETA_HI);
    const denom = winCheap - dustCheap;
    if (denom > tol) {
      const wrMaxForEv =
        (evTarget - nmMassForBound * nmCheap - (1 - nmMassForBound) * dustCheap) / denom;
      // Clamp into the valid range; the mass-budget ceiling already applied above.
      const wrCap = Math.max(0, Math.min(targetWinRate, wrMaxForEv));
      if (targetWinRate > wrCap + tol) {
        const existing = relaxations.find((r) => r.lever === "winRate");
        if (existing) {
          existing.applied = wrCap;
          existing.reason = `Win-rate relaxed to ${wrCap.toFixed(4)} (requested ${requestedWinRate}); a higher win mass would pin EV above the ${(targetEdge * 100).toFixed(2)}% edge target.`;
        } else {
          relaxations.push({
            lever: "winRate",
            requested: requestedWinRate,
            applied: wrCap,
            reason: `Win-rate relaxed to ${wrCap.toFixed(4)}; a higher win mass would pin EV above the ${(targetEdge * 100).toFixed(2)}% edge target.`,
          });
        }
        targetWinRate = wrCap;
      }
    }
  }

  // ── Band mass allocation ────────────────────────────────────────────
  const winMass = targetWinRate;
  const nearMissMass = nearMiss.length > 0 ? nearMissMin : 0;
  const dustMass = 1 - winMass - nearMissMass;
  // Backstop: after the win-rate relaxation above, dustMass ≥ MIN_DUST_MARGIN by
  // construction, so this never fires on the relaxed path — it's a NaN-safe guard.
  if (!(dustMass > tol)) {
    return {
      error: "No dust probability mass remains after win + near-miss allocation.",
      feasibility,
      limit: {
        kind: "no-dust-mass",
        detail: "Win + near-miss allocation consumed all probability mass, leaving nothing to carry the house edge.",
        suggestion: "Lower the win-rate or near-miss target so some losing (dust) mass remains.",
      },
    };
  }

  // The full win-rate mass sits on the combined WIN+GRAIL pool (all cards with
  // value ≥ price). Keeping them as ONE band — rather than pinning grails to a
  // tiny fixed slice — lets the shared beta below concentrate win mass on the
  // jackpot when the EV target is high, or spread it toward cheaper wins when
  // the EV target is low. (The GRAIL/WIN split still exists for banding/labels;
  // it just doesn't fragment the win mass.)
  const winMassTotal = winMass;
  const winPoolSlots = [...grail, ...win];
  const winPoolValues = winPoolSlots.map((s) => s.value);
  const nearMissValues = nearMiss.map((s) => s.value);
  const dustValues = dust.map((s) => s.value);

  // ── Solve ONE shared beta across all four bands so total EV = evTarget ──
  //
  // Each band lays out its fixed probability MASS internally by value^(−beta).
  // For a single shared beta, total EV is
  //   E(beta) = Σ_band  mass_band · bandMean_band(beta)
  // and bandMean is monotone DECREASING in beta, so E(beta) is monotone too.
  // Therefore E ranges over [E(+50)  (all bands skewed cheap, min EV),
  //                          E(−20)  (all bands skewed expensive, max EV)].
  // If evTarget is inside that range it is reachable; bisect the shared beta.
  // The DUST band is the most EV-elastic (widest value span at the cheap end),
  // so it dominates the fine-tune — but binding all four to one beta guarantees
  // monotonicity and a single feasibility test. (Dust still carries the slack;
  // the post-quantize one-sided-up bump nudges the cheapest dust card.)
  const dustMin = Math.min(...dustValues);
  const dustMax = Math.max(...dustValues);

  // ── Floor reservation (optional, done BEFORE the EV solve) ──────────
  // If a floor ratio is required, pick the cheapest dust card meeting it and
  // RESERVE a fixed probability mass on it up-front so it is the modal card.
  // Reserving before the beta solve keeps EV exact (the solve targets the EV
  // residual after the floor's contribution) — pinning it AFTER would distort EV
  // and the up-only bump couldn't pull it back. The floor card is removed from
  // the free dust template; the rest of dust carries (dustMass − floorMass).
  let floorSlot: Slot | null = null;
  let floorMass = 0;
  let freeDust = dust;
  let freeDustValues = dustValues;
  let freeDustMass = dustMass;
  if (floorRatioMin !== undefined && floorRatioMin > 0) {
    const needFloor = floorRatioMin * price;
    const cand = dust.filter((s) => s.value >= needFloor - 1e-9);
    // SOFT relaxation: if no dust card meets the floor ratio, drop the floor pin
    // (applied 0) and proceed — the modal card falls out naturally.
    if (cand.length === 0) {
      relaxations.push({
        lever: "floor",
        requested: floorRatioMin,
        applied: 0,
        reason: `No dust card worth ≥ $${needFloor.toFixed(2)} (floorRatioMin·price); floor pin dropped.`,
      });
    } else {
      cand.sort((a, b) => a.value - b.value);
      const pick = cand[0]!;
      // Reserve enough mass that the floor card dominates any OTHER single card.
      // Upper bound on any other single-card mass ≈ max(winMassTotal, nearMissMass,
      // remaining dustMass). Give the floor a hair more, but never ≥ dustMass (it
      // must leave room for the rest of the losing band) and never so much it kills
      // the EV solve. We cap it at 60% of dust mass.
      const otherMax = Math.max(winMassTotal, nearMissMass, dustMass);
      const reserve = Math.min(dustMass * 0.6, otherMax * 1.05 + 1e-6);
      // SOFT relaxation: if a dominant floor mass can't fit the dust band, drop
      // the pin (applied 0) rather than erroring.
      if (!(reserve > 0) || reserve >= dustMass) {
        relaxations.push({
          lever: "floor",
          requested: floorRatioMin,
          applied: 0,
          reason: `Cannot reserve a dominant floor mass within the dust band (reserve ${reserve.toFixed(4)}, dustMass ${dustMass.toFixed(4)}); floor pin dropped.`,
        });
      } else {
        floorSlot = pick;
        floorMass = reserve;
        freeDust = dust.filter((s) => s !== floorSlot);
        freeDustValues = freeDust.map((s) => s.value);
        freeDustMass = dustMass - floorMass;
      }
    }
  }

  // EV total for a shared beta, INCLUDING the reserved floor card's fixed share.
  const floorEvFixed = floorSlot ? floorMass * floorSlot.value : 0;
  const totalEvForBeta = (beta: number): number =>
    winMassTotal * bandEvForBeta(winPoolValues, beta) +
    nearMissMass * bandEvForBeta(nearMissValues, beta) +
    freeDustMass * bandEvForBeta(freeDustValues, beta) +
    floorEvFixed;

  const evMax = totalEvForBeta(BETA_LO);
  const evMin = totalEvForBeta(BETA_HI);

  if (evTarget < evMin - 1e-6 || evTarget > evMax + 1e-6) {
    return {
      error: `Edge target needs EV $${evTarget.toFixed(4)} but this band split can only reach $${evMin.toFixed(4)}–$${evMax.toFixed(4)}.`,
      feasibility: {
        ...feasibility,
        evReachable: { min: evMin, max: evMax },
        bands: { winMass: winMassTotal, nearMissMass, dustMass, floorMass },
        dustMin,
        dustMax,
      },
      limit: {
        kind: "ev-unreachable-for-split",
        detail: `The ${(targetEdge * 100).toFixed(2)}% edge needs EV $${evTarget.toFixed(2)}, but at the chosen win/near-miss split this pool can only produce EV $${evMin.toFixed(2)}–$${evMax.toFixed(2)}.`,
        suggestion:
          evTarget > evMax
            ? `Add a higher-value card in the WIN band ($${winLo.toFixed(2)}–$${winHi.toFixed(2)}) or GRAIL band (≥ $${winHi.toFixed(2)}) so EV can reach $${evTarget.toFixed(2)} — or lower the edge target.`
            : `Add a cheaper card in the DUST band (< $${dustHi.toFixed(2)}) so EV can drop to $${evTarget.toFixed(2)} — or raise the edge target.`,
      },
    };
  }

  // Bisect the shared beta on the monotone E(beta).
  let lo = BETA_LO;
  let hi = BETA_HI;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (totalEvForBeta(mid) > evTarget) lo = mid;
    else hi = mid;
  }
  const sharedBeta = (lo + hi) / 2;

  const winPoolW = bandWeights(winPoolValues, sharedBeta, winMassTotal);
  const nearMissW = bandWeights(nearMissValues, sharedBeta, nearMissMass);
  const freeDustW = bandWeights(freeDustValues, sharedBeta, freeDustMass);

  // Stitch the per-slot fractional weights back into slot order. Build a
  // slot→position map once so we don't pay indexOf in a loop.
  const slotPos = new Map<Slot, number>();
  slots.forEach((s, i) => slotPos.set(s, i));
  const frac = new Array<number>(slots.length).fill(0);
  winPoolSlots.forEach((s, i) => {
    frac[slotPos.get(s)!] = winPoolW[i]!;
  });
  nearMiss.forEach((s, i) => {
    frac[slotPos.get(s)!] = nearMissW[i]!;
  });
  freeDust.forEach((s, i) => {
    frac[slotPos.get(s)!] = freeDustW[i]!;
  });
  // The reserved floor card carries its fixed mass directly.
  if (floorSlot) {
    frac[slotPos.get(floorSlot)!] = floorMass;
  }

  // ── Integer quantize ────────────────────────────────────────────────
  // Scale ×1e6 (not ×1e4) so every weight is large: this makes the +1 edge-
  // correction bump below a TINY relative step, so the one-sided-up loop can
  // land the edge just above target without overshooting past target+0.001. A
  // single +1 on a small pool would otherwise be a coarse jump. We gcd-reduce
  // only at the very END (after bumping) to keep weights minimal.
  const QUANT = 1_000_000;
  const weights = new Array<number>(input.cards.length).fill(0);
  slots.forEach((s, i) => {
    weights[s.idx] = Math.max(1, Math.round(frac[i]! * QUANT));
  });

  // ── One-sided-UP edge enforcement ───────────────────────────────────
  // Quantization can nudge EV up (edge below target). Bumping the CHEAPEST dust
  // card's weight is monotone: more mass on a cheap card lowers EV → raises edge.
  // We step by an adaptive amount (halving on overshoot risk) so we converge to
  // edge ∈ [target, target+0.001] quickly, capped at MAX_BUMPS iterations.
  const cardsForRisk = (): CardLite[] =>
    input.cards.map((c, i) => ({ value: c.value, weight: weights[i]! }));

  const cheapestDustIdx = dust.reduce(
    (best, s) => (s.value < input.cards[best]!.value ? s.idx : best),
    dust[0]!.idx,
  );

  let risk = computePackRisk({ cards: cardsForRisk(), price });
  let bumps = 0;
  const MAX_BUMPS = 5000;
  // Adaptive step: start large to cross the target fast, shrink near it so the
  // final landing sits inside the [target, target+0.001] window.
  let step = Math.max(1, Math.round(weights[cheapestDustIdx]! * 0.5));
  while (risk.edge < targetEdge - 1e-9 && bumps < MAX_BUMPS) {
    const prev = weights[cheapestDustIdx]!;
    weights[cheapestDustIdx] = prev + step;
    bumps += 1;
    const next = computePackRisk({ cards: cardsForRisk(), price });
    if (next.edge > targetEdge + 0.001 && step > 1) {
      // Overshot the upper bound — undo and halve the step to refine.
      weights[cheapestDustIdx] = prev;
      step = Math.max(1, Math.floor(step / 2));
      continue;
    }
    risk = next;
  }
  if (risk.edge < targetEdge - 1e-9) {
    return {
      error: `Could not reach edge ≥ ${(targetEdge * 100).toFixed(2)}% within ${MAX_BUMPS} weight bumps (achieved ${(risk.edge * 100).toFixed(2)}%).`,
      feasibility: { ...feasibility, achievedEdge: risk.edge, bumps },
      limit: {
        kind: "edge-unreachable",
        detail: `Could not push the edge up to ${(targetEdge * 100).toFixed(2)}% within ${MAX_BUMPS} weight bumps (reached ${(risk.edge * 100).toFixed(2)}%).`,
        suggestion: `Add a cheaper card in the DUST band (well below $${dustHi.toFixed(2)}) so weighting it down can lift the edge to target.`,
      },
    };
  }

  // ── gcd-reduce the final vector (after all bumps) ───────────────────
  const present = weights.filter((w) => w > 0);
  if (present.length > 0) {
    let g = present[0]!;
    for (let i = 1; i < present.length; i++) g = gcd(g, present[i]!);
    if (g > 1) {
      for (let i = 0; i < weights.length; i++) {
        if (weights[i]! > 0) weights[i] = Math.round(weights[i]! / g);
      }
      risk = computePackRisk({ cards: cardsForRisk(), price });
    }
  }

  // ── Win-rate re-check (after all integer adjustments) ───────────────
  // Win-rate is a TARGET within tol — but if the pool genuinely could not land
  // on it (the edge bumps moved mass around to keep edge ≥ target, or the pool
  // can't host the requested win mass), we RELAX to the achieved value and
  // record it rather than erroring. Edge ≥ target is already guaranteed above,
  // so the result is still a valid, edge-correct pack.
  if (Math.abs(risk.winRate - targetWinRate) > winRateTol) {
    const existing = relaxations.find((r) => r.lever === "winRate");
    if (existing) {
      // A win-rate relaxation was already recorded (mass-budget cap); refine its
      // applied value + reason to reflect the actual achieved win-rate.
      existing.applied = risk.winRate;
      existing.reason = `Win-rate relaxed to the achievable ${(risk.winRate * 100).toFixed(2)}% (requested ${(requestedWinRate * 100).toFixed(2)}%); the pool could not host the full win mass while keeping edge ≥ target.`;
    } else {
      relaxations.push({
        lever: "winRate",
        requested: requestedWinRate,
        applied: risk.winRate,
        reason: `Pool could not land win-rate ${(targetWinRate * 100).toFixed(2)}% within ±${(winRateTol * 100).toFixed(2)}% while keeping edge ≥ target; relaxed to the achievable ${(risk.winRate * 100).toFixed(2)}%.`,
      });
    }
  }

  // ── Lottery skew (steep grail-band redistribution, lottery packs only) ──
  // For tagged 1%/5% packs the inverse solver's WITHIN-GRAIL distribution is
  // too flat compared to what an owner hand-tunes. Redistribute the grail
  // band's mass along a steep value^(-β) curve (β=2) so the $810 jackpot
  // sits ~190× rarer than the $60 grail — matching the owner's verbatim.
  // Total grail mass and WIN/NEARMISS/DUST weights are NEVER changed; this
  // function only re-shapes the GRAIL band. Safety: keep the skew only when
  // edge drift ≤ ±0.05pp AND edge ≥ target. Otherwise fall back.
  let lotterySkewApplied = false;
  const lottery = applyLotterySkew({
    cards: input.cards,
    weights,
    price,
    targetEdge,
    targetWinRate: requestedWinRate,
  });
  if (lottery.applied) {
    const lotteryRisk = computePackRisk({
      cards: input.cards.map((c, i) => ({ value: c.value, weight: lottery.weights[i]! })),
      price,
    });
    const lotteryDrift = Math.abs(lotteryRisk.edge - targetEdge);
    if (lotteryDrift <= 0.0005 && lotteryRisk.edge >= targetEdge - 1e-9) {
      for (let i = 0; i < weights.length; i++) weights[i] = lottery.weights[i]!;
      risk = lotteryRisk;
      lotterySkewApplied = true;
    }
  }

  // ── Snap to clean-ladder for human-readable odds (safe post-process) ──
  // The precise weights above are edge-correct but produce ugly percentages
  // like 0.0458% / 0.0879%. The snap is a buffer-residual scheme: N-1 cards
  // are placed on clean ladder rungs (0.05%, 0.1%, 10%, 25%, ...) and ONE
  // buffer card (the largest mass, typically the dust card) absorbs the
  // residual so the total stays at 100% without re-normalizing every rung
  // (which is what made the old approach produce ugly 0.0521% rather than
  // 0.05%).
  //
  // Acceptance is two-tiered:
  //   1. Try the basic buffer-residual snap. If edge stays within ±0.05pp
  //      AND ≥ target → ACCEPT.
  //   2. Otherwise, run a local-search refinement over the top-5 EV-impact
  //      cards (3 ladder positions each = 3^5 = 243 combos), pick the combo
  //      with smallest drift that still satisfies edge ≥ target. If that
  //      combo's drift is within tolerance → ACCEPT.
  //   3. Otherwise → safety fallback: keep the precise weights. The snap
  //      never regresses edge, by construction.
  let snapped = false;
  const values = input.cards.map((c) => c.value);
  const preciseWinRate = risk.winRate;
  const snap = snapWeightsToCleanLadder({ weights, price });
  // Apply within-band monotonicity repair (owner invariants — see
  // `repairSnapMonotonicity`). If the basic snap can't be made monotonic
  // within the ladder bounds, treat as failed and fall through to local-search
  // refinement (which retries with different ladder positions).
  const snapRepaired = repairSnapMonotonicity({ weights: snap.weights, values, price });
  const snapCandidate = snapRepaired.ok ? snapRepaired.weights : snap.weights;
  const snapCandidateRisk = computePackRisk({
    cards: input.cards.map((c, i) => ({ value: c.value, weight: snapCandidate[i]! })),
    price,
  });
  const snapDrift = Math.abs(snapCandidateRisk.edge - targetEdge);
  const snapWinRateDrift = Math.abs(snapCandidateRisk.winRate - preciseWinRate);
  // Tier 1: accept the basic buffer-residual snap when edge stays within
  // ±0.05pp of target AND ≥ target (one-sided-up invariant) AND win-rate
  // stays within the soft tolerance of the precise solver's win-rate AND the
  // monotonicity repair succeeded.
  if (
    snapRepaired.ok &&
    snapDrift <= 0.0005 &&
    snapCandidateRisk.edge >= targetEdge - 1e-9 &&
    snapWinRateDrift <= winRateTol + 1e-9
  ) {
    for (let i = 0; i < weights.length; i++) weights[i] = snapCandidate[i]!;
    risk = snapCandidateRisk;
    snapped = true;
  } else {
    // Tier 2: local-search refinement. Wiggle the top-5 EV-impact cards by
    // ±1 ladder rung; recompute the buffer residual for each combo; pick the
    // combo whose edge lands closest to target while still ≥ target and
    // win-rate stays within tol of the precise win-rate.
    // Try escalating searches: 3^5=243 → 5^4=625 → 3^7=2187. Cheap-then-broad
    // keeps the common case fast while still catching pools where the rungs
    // are far from the precise pcts.
    let refined = snapLocalSearchRefine({
      weights,
      values,
      price,
      targetEdge,
      tolerance: 0.0005,
      searchTop: 5,
      searchRadius: 1,
      preciseWinRate,
      winRateTol,
    });
    if (refined === null) {
      refined = snapLocalSearchRefine({
        weights,
        values,
        price,
        targetEdge,
        tolerance: 0.0005,
        searchTop: 4,
        searchRadius: 2,
        preciseWinRate,
        winRateTol,
      });
    }
    if (refined === null) {
      refined = snapLocalSearchRefine({
        weights,
        values,
        price,
        targetEdge,
        tolerance: 0.0005,
        searchTop: 7,
        searchRadius: 1,
        preciseWinRate,
        winRateTol,
      });
    }
    if (refined !== null) {
      // Apply monotonicity repair to the local-search winner, then re-verify
      // edge + win-rate tolerance. If the repair pushes the result out of
      // tolerance — or fails outright — fall back to precise weights instead
      // of accepting an ordering that violates the owner invariants.
      const refinedRepaired = repairSnapMonotonicity({
        weights: refined.weights,
        values,
        price,
      });
      if (refinedRepaired.ok) {
        const refinedRisk = computePackRisk({
          cards: input.cards.map((c, i) => ({ value: c.value, weight: refinedRepaired.weights[i]! })),
          price,
        });
        const refinedDrift = Math.abs(refinedRisk.edge - targetEdge);
        const refinedWinRateDrift = Math.abs(refinedRisk.winRate - preciseWinRate);
        if (
          refinedDrift <= 0.0005 &&
          refinedRisk.edge >= targetEdge - 1e-9 &&
          refinedWinRateDrift <= winRateTol + 1e-9
        ) {
          for (let i = 0; i < weights.length; i++) weights[i] = refinedRepaired.weights[i]!;
          risk = refinedRisk;
          snapped = true;
        }
      }
    }
  }

  return { weights, risk, ev: risk.ev, edge: risk.edge, relaxations, snapped, lotterySkewApplied };
}

// ─── Price search wrapper around shapeWeights ─────────────────────────
//
// The auto-retune normally holds the pack PRICE constant and only adjusts
// weights. On some pools this forces the clean-ladder snap to fall back to
// ugly precise weights (e.g. 0.0458% / 0.0879%) because no combination of
// rungs lands on a clean total. A tiny price bump (e.g. $1.25 → $1.27) often
// lets every card sit on a ladder rung.
//
// `searchBestPriceForCleanSnap` is a pure deterministic wrapper around the
// existing `shapeWeights`: it sweeps candidate prices around `basePrice` in
// 1-cent steps up to ±`maxPriceChangePct` (default ±25%), runs the FULL
// `shapeWeights` pipeline at each candidate, and picks the best candidate.
//
// SCORING — backward-compatible default (no `taggedWinRate`):
//   Tier 1: snapPriority (snapped + skew matches base < snapped < not snapped < error)
//   Tier 2: centsDist (closer to basePrice wins)
//   Tier 3: edgeDrift (smaller |edge − target| wins)
//   ─ The base price is preferred whenever it produces a clean snap matching
//     the base lottery-skew state (early return).
//
// SCORING — TAGGED-PACK mode (`taggedWinRate` set):
//   When the pack name carries an "X%" tag (e.g. "1% 18 PLUS"), the owner
//   wants the achieved win-rate to be EXACTLY X% — not 1.6% or 1.95%. The
//   lottery skew's dust-scale EV-compensation drifts the achieved win-rate
//   above the tag at the base price. The search re-bands the pool (price /
//   0.5·price / 5·price boundaries shift) at every candidate so the solver
//   can land BOTH the target edge AND the exact tag win-rate. New tiers:
//   Tier 0 (PRIMARY):  winRateInTol — |winRate − taggedWinRate| ≤
//                       {@link TAGGED_WINRATE_TOLERANCE} (0.01pp) BEATS not.
//   Tier 1 (SECONDARY): snapPriority (same scale as the default mode).
//   Tier 2 (TERTIARY):  centsDist (closer to basePrice wins).
//   Tier 3 (QUATERNARY): edgeDrift (smaller |edge − target| wins).
//   ─ The base price's early return (clean snap + skew matches) is REPLACED
//     by a tagged-aware early return: prefer base ONLY if it both clean-snaps
//     AND lands within the win-rate tolerance. Otherwise the full sweep runs.
//
// Does NOT modify `shapeWeights`. Bounded at 50 candidates so big-priced
// packs don't pay an unbounded cost. `maxPriceChangePct = 0` short-circuits
// the search and returns the base-price result (backward-compat).

/**
 * Strict tolerance for the tagged-pack win-rate accuracy gate: 0.01pp = 0.0001
 * as a fraction. The owner's spec for tagged "X%" packs requires the achieved
 * win-rate to land within this tolerance of the tag — much tighter than the
 * solver's default ±2pp soft tolerance.
 */
export const TAGGED_WINRATE_TOLERANCE = 0.0001;

export type SearchBestPriceResult = {
  bestPrice: number;
  bestResult: ShapeWeightsResult;
  /** How many price candidates were evaluated (includes the base run). */
  searched: number;
  /** True when no candidate beat the base price's outcome. */
  fellBackToBase: boolean;
  /**
   * Tagged-mode only (`taggedWinRate` was provided): did the chosen candidate
   * satisfy the strict {@link TAGGED_WINRATE_TOLERANCE} gate? `null` when the
   * search ran in default mode (no `taggedWinRate`).
   */
  taggedAccuracyHit: boolean | null;
};

export function searchBestPriceForCleanSnap(input: {
  cards: { value: number }[];
  basePrice: number;
  targetEdge: number;
  targetWinRate: number;
  maxWinCap?: number;
  nearMissMin?: number;
  winRateTol?: number;
  /** ±range as a fraction of basePrice (default 0.25 = ±25%). 0 disables the search. */
  maxPriceChangePct?: number;
  /**
   * Tagged-pack mode: when set, the scoring elevates a STRICT win-rate
   * accuracy criterion (|winRate − taggedWinRate| ≤
   * {@link TAGGED_WINRATE_TOLERANCE} = 0.01pp) ABOVE snap-cleanness as the
   * primary tier. Pass the tag value (e.g. 0.01 for a "1% 18 PLUS" pack); the
   * search will pick the candidate whose `shapeWeights` result lands BOTH
   * edge ≥ target AND winRate within 0.01pp of `taggedWinRate`. Omit (or
   * leave undefined) to run the legacy snap-first scoring — existing callers
   * stay byte-for-byte unchanged.
   */
  taggedWinRate?: number;
  /**
   * Owner's edge-target nudge mode (chip-strip): when the operator selects a
   * higher edge target than the pack's baseline, "raise the ticket price" is
   * the right knob (higher price + same payouts = higher edge), so the search
   * may push UP past the normal ±maxPriceChangePct band. Pass the upward
   * extension as a fraction of basePrice — e.g. `1.0` lets price go up to
   * +100% (2× basePrice) — `0` disables (legacy behavior). The downward band
   * stays at `maxPriceChangePct`. Used by `planAllRetunes` /
   * `applyPackRetune` when an `edgeFloorOverride` is active so the snap can
   * actually land both clean odds AND the raised edge target.
   */
  upwardPriceExtensionPct?: number;
  /**
   * When TRUE, the scoring elevates the achieved HOUSE EDGE above clean-snap
   * cleanness. Without this, the search picks the candidate with the cleanest
   * ladder snap that just satisfies `edge ≥ targetEdge` — which can mean
   * LOWERING the price (lower price + same payouts = lower edge, still ≥ target
   * only if the pool barely clears it). The owner reported this on a 1%-tagged
   * pack ($1.25 → $1.00 with edge dropping). With `preferHigherEdge=true` the
   * scoring buckets candidates by edge in 0.1pp bins (higher = better) BEFORE
   * the snap-priority tier, so a candidate giving up cleanness for ≥ 0.1pp
   * more edge wins. Used by `planAllRetunes` / `applyPackRetune` whenever the
   * operator has nudged the edge floor UP via the chip-strip OR pinned an
   * explicit price anchor (both paths want "edge first").
   */
  preferHigherEdge?: boolean;
}): SearchBestPriceResult {
  const {
    cards,
    basePrice,
    targetEdge,
    targetWinRate,
    maxWinCap,
    nearMissMin,
    winRateTol,
  } = input;
  const maxPriceChangePct = input.maxPriceChangePct ?? 0.25;
  const upwardPriceExtensionPct = Math.max(0, input.upwardPriceExtensionPct ?? 0);
  const taggedWinRate = input.taggedWinRate;
  const tagged = typeof taggedWinRate === "number" && Number.isFinite(taggedWinRate);
  const preferHigherEdge = input.preferHigherEdge === true;

  // Single-call passthrough for the degenerate / disabled cases. Mirrors the
  // backward-compat contract: callers can wire this in unconditionally and
  // disable search with `maxPriceChangePct: 0`.
  const runAt = (price: number): ShapeWeightsResult =>
    shapeWeights({
      cards,
      price,
      targetEdge,
      targetWinRate,
      maxWinCap,
      nearMissMin,
      winRateTol,
    });

  // Tagged-mode helper: did this shape land within 0.01pp of the tag?
  const isWithinTaggedTol = (r: ShapeWeightsResult): boolean => {
    if (!tagged) return false;
    if (!isShapeWeightsSuccess(r)) return false;
    return Math.abs(r.risk.winRate - taggedWinRate!) <= TAGGED_WINRATE_TOLERANCE;
  };

  if (
    cards.length === 0 ||
    !(basePrice > 0) ||
    (!(maxPriceChangePct > 0) && !(upwardPriceExtensionPct > 0))
  ) {
    // The disabled / degenerate paths run a single shape and report whether
    // the base produced a clean snap (`fellBackToBase=false` — base was good)
    // or did NOT snap (`fellBackToBase=true` — we returned base only because
    // search was disabled / impossible). In tagged mode, "base was good"
    // also requires within-tol on win-rate.
    const baseResult = runAt(basePrice);
    const baseSnapped =
      isShapeWeightsSuccess(baseResult) && baseResult.snapped === true;
    const baseAccuracy = tagged ? isWithinTaggedTol(baseResult) : true;
    return {
      bestPrice: basePrice,
      bestResult: baseResult,
      searched: 1,
      fellBackToBase: !(baseSnapped && baseAccuracy),
      taggedAccuracyHit: tagged ? baseAccuracy : null,
    };
  }

  // ── Build the candidate list ────────────────────────────────────────
  // basePrice first, then ±1¢, ±2¢, ... up to ±(basePrice · maxPriceChangePct).
  // Each candidate is cent-rounded. Deduplicate via a Set keyed on cents.
  //
  // Cap-per-mode:
  //   • Default mode (legacy clean-snap): 50 candidates — bounded cost; the
  //     densest coverage near the base price is what matters for an "ugly
  //     odds → clean odds" nudge.
  //   • TAGGED MODE: the Owner spec is explicit ±25% of basePrice, so the
  //     cap is raised to cover the full requested band even for expensive
  //     packs (e.g. $5 base → 125¢ deviation → ~250 candidates). The strict
  //     win-rate accuracy gate is the whole point of tagged mode; clipping
  //     the band would silently fail the accuracy requirement on costly
  //     packs.
  // When an upward price extension is active (operator nudging edge UP via the
  // chip-strip), we widen the candidate cap so the upward search has room to
  // climb past +25% and still leave budget for the snap+win-rate trade-off.
  const upwardBoosted = upwardPriceExtensionPct > 0;
  const MAX_CANDIDATES = upwardBoosted ? 800 : tagged ? 320 : 50;
  const centsAtBase = Math.round(basePrice * 100);
  const downCents = Math.max(0, Math.floor(basePrice * maxPriceChangePct * 100));
  // Upward span = the LARGER of the symmetric ±maxPriceChangePct band and the
  // operator's explicit upwardPriceExtensionPct (a chip-strip nudge can push
  // far past +25% to land both clean odds AND the raised edge target).
  const upCents = Math.max(
    downCents,
    Math.floor(basePrice * upwardPriceExtensionPct * 100),
  );
  const seenCents = new Set<number>();
  const candidates: number[] = [];
  const pushCents = (cents: number): void => {
    if (cents <= 0) return;
    if (seenCents.has(cents)) return;
    if (candidates.length >= MAX_CANDIDATES) return;
    seenCents.add(cents);
    candidates.push(Math.round(cents) / 100);
  };
  pushCents(centsAtBase);
  const maxDelta = Math.max(downCents, upCents);
  for (let d = 1; d <= maxDelta; d++) {
    if (d <= upCents) {
      pushCents(centsAtBase + d);
      if (candidates.length >= MAX_CANDIDATES) break;
    }
    if (d <= downCents) {
      pushCents(centsAtBase - d);
      if (candidates.length >= MAX_CANDIDATES) break;
    }
  }

  // ── Evaluate the base price first (anchor for the "prefer base" rule) ──
  const baseResult = runAt(basePrice);
  let searched = 1;

  // Determine the base run's lotterySkewApplied state — we PIN this so the
  // search doesn't accidentally flip lottery skew on/off across candidates
  // (changing the within-grail distribution shape is a separate decision).
  const baseSkew =
    isShapeWeightsSuccess(baseResult) && baseResult.lotterySkewApplied === true;

  // Score function: smaller is better.
  //
  // DEFAULT MODE (`tagged === false`, `preferHigherEdge === false`):
  //   Tier 0: always 0 (inactive — the tagged tier is collapsed).
  //   Tier 0b: always 0 (inactive — edgeBand only active under preferHigherEdge).
  //   Tier 1: snapPriority (snapped + skew matches base < snapped < not snapped < error)
  //   Tier 2: centsDist (closer to basePrice wins).
  //   Tier 3: edgeDrift (smaller |edge − target| wins).
  //
  // TAGGED MODE (`tagged === true`):
  //   Tier 0: winRateTier — 0 = within {@link TAGGED_WINRATE_TOLERANCE} of
  //           the tag, 1 = outside tol but still a success, 2 = error.
  //   Tier 0b: edgeBand if preferHigherEdge, else inactive.
  //   Tier 1: snapPriority (same as default).
  //   Tier 2: centsDist.
  //   Tier 3: edgeDrift.
  //
  // PREFER-HIGHER-EDGE MODE (`preferHigherEdge === true`):
  //   The owner reported the search lowering a 1%-tagged pack from $1.25 →
  //   $1.00 — a price drop that hurts edge — because the $1.00 candidate's
  //   snap was cleaner. When the operator has nudged the edge floor up via
  //   the chip strip OR pinned a specific anchor price, edge becomes the
  //   PRIMARY optimization (after winRate-tier for tagged). The `edgeBand`
  //   tier buckets each successful candidate by its achieved edge in 0.1pp
  //   bins (-floor(edge * 1000)) so a candidate giving up snap-cleanness for
  //   ≥0.1pp more edge wins. Within a band, snap-cleanness still breaks ties.
  //   Failed candidates (no edge) land in the worst band.
  //
  // The tagged tier 0 is the OWNER's hard requirement — a tagged pack must
  // hit its tag, full stop. Snap-cleanness is the secondary preference.
  type Scored = {
    price: number;
    result: ShapeWeightsResult;
    winRateTier: number; // tagged mode only; always 0 in default mode
    edgeBand: number; // preferHigherEdge only; always 0 otherwise. Smaller = higher edge.
    snapPriority: number; // 0 = snapped + skew matches base, 1 = snapped wrong skew, 2 = not snapped, 3 = error
    centsDist: number;
    edgeDrift: number;
  };
  const scoreOf = (price: number, result: ShapeWeightsResult): Scored => {
    let snapPriority: number;
    let edgeDrift: number;
    let winRateTier: number;
    let edgeBand: number;
    if (isShapeWeightsSuccess(result)) {
      const isSnapped = result.snapped === true;
      const skewMatchesBase =
        (result.lotterySkewApplied === true) === baseSkew;
      if (isSnapped && skewMatchesBase) snapPriority = 0;
      else if (isSnapped) snapPriority = 1;
      else snapPriority = 2;
      edgeDrift = Math.abs(result.edge - targetEdge);
      // Tagged-mode tier 0: within-tol = 0, outside-but-ok = 1.
      winRateTier = tagged ? (isWithinTaggedTol(result) ? 0 : 1) : 0;
      // Edge band: bucketize achieved edge in 0.1pp bins; negate so higher
      // edge = lower (better) score. Only active under preferHigherEdge.
      edgeBand = preferHigherEdge ? -Math.floor(result.edge * 1000) : 0;
    } else {
      snapPriority = 3;
      edgeDrift = Infinity;
      winRateTier = tagged ? 2 : 0;
      // Failed candidates land in the worst (largest positive) band so they
      // lose to every success.
      edgeBand = preferHigherEdge ? Number.MAX_SAFE_INTEGER : 0;
    }
    return {
      price,
      result,
      winRateTier,
      edgeBand,
      snapPriority,
      centsDist: Math.abs(Math.round(price * 100) - centsAtBase),
      edgeDrift,
    };
  };

  let best: Scored = scoreOf(basePrice, baseResult);

  // ── Base-prefer early return ─────────────────────────────────────────
  // DEFAULT MODE: if the base price already produced a snapped (and
  // skew-matching) result, prefer it — never deviate without reason.
  // TAGGED MODE: ALSO require base to satisfy the 0.01pp win-rate gate.
  // PREFER-HIGHER-EDGE MODE: the sweep MUST run — even if base snaps cleanly,
  //   a HIGHER-priced candidate may give the operator the edge they asked for.
  // Otherwise the sweep MUST run — the owner's accuracy requirement is
  // the hard primary.
  const baseQualifiesForEarlyReturn = preferHigherEdge
    ? false
    : tagged
      ? best.winRateTier === 0 && best.snapPriority === 0
      : best.snapPriority === 0;
  if (baseQualifiesForEarlyReturn) {
    return {
      bestPrice: basePrice,
      bestResult: baseResult,
      searched: 1,
      fellBackToBase: false,
      taggedAccuracyHit: tagged ? true : null,
    };
  }

  // Evaluate the remaining candidates (skip the base, already scored). The
  // candidate list is built deterministically (basePrice, then ±1¢, ±2¢, ...)
  // so iteration order is stable across runs.
  for (let i = 0; i < candidates.length; i++) {
    const price = candidates[i]!;
    if (Math.abs(Math.round(price * 100) - centsAtBase) === 0) continue; // already done
    const result = runAt(price);
    searched += 1;
    const scored = scoreOf(price, result);
    // Lexicographic comparator: winRateTier < edgeBand < snapPriority < centsDist < edgeDrift.
    // In default mode winRateTier + edgeBand are always 0 → effectively starts at snapPriority.
    if (
      scored.winRateTier < best.winRateTier ||
      (scored.winRateTier === best.winRateTier &&
        scored.edgeBand < best.edgeBand) ||
      (scored.winRateTier === best.winRateTier &&
        scored.edgeBand === best.edgeBand &&
        scored.snapPriority < best.snapPriority) ||
      (scored.winRateTier === best.winRateTier &&
        scored.edgeBand === best.edgeBand &&
        scored.snapPriority === best.snapPriority &&
        scored.centsDist < best.centsDist) ||
      (scored.winRateTier === best.winRateTier &&
        scored.edgeBand === best.edgeBand &&
        scored.snapPriority === best.snapPriority &&
        scored.centsDist === best.centsDist &&
        scored.edgeDrift < best.edgeDrift)
    ) {
      best = scored;
    }
  }

  // `fellBackToBase` semantic: TRUE only when the chosen price equals the base
  // AND the chosen result was NOT a clean snap (we couldn't find anything
  // better, so we returned base as a degraded fallback). When the search
  // PICKED base for its own merits (clean snap) we returned earlier with
  // `fellBackToBase: false`; this is the "nothing snapped" tail.
  const chosenSnapped =
    isShapeWeightsSuccess(best.result) && best.result.snapped === true;
  const fellBackToBase = best.centsDist === 0 && !chosenSnapped;
  const taggedAccuracyHit = tagged
    ? isWithinTaggedTol(best.result)
    : null;
  return {
    bestPrice: best.price,
    bestResult: best.result,
    searched,
    fellBackToBase,
    taggedAccuracyHit,
  };
}

/** Narrow a `ShapeWeightsResult` to its success arm. */
function isShapeWeightsSuccess(r: ShapeWeightsResult): r is ShapeWeightsSuccess {
  return "weights" in r;
}
