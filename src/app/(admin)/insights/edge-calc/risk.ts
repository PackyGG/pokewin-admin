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

/** One owner-pinned card-odds entry — see {@link ShapeWeightsInput.pinnedShares}. */
export type ShapeWeightsPinnedShare = {
  /** Index into `cards`. */
  index: number;
  /** EXACT probability share as a fraction of TOTAL pool mass (0 < share ≤ 1). */
  share: number;
};

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
  /**
   * The pack's CURRENT per-card weights (pool order, parallel to `cards`).
   * OPTIONAL. When supplied, the solver enforces the owner's ANTI-INFLATION
   * anchor (rule #1): no WIN/GRAIL card's resulting probability may EXCEED its
   * current probability — raising the edge must only TRIM the expensive tail,
   * never inflate it. The solver steepens the win-pool decay (and floats the
   * win-rate up) until every win/grail card's odds sit at/below its current
   * odds. When a card's current odds are SO low that not even the steepest
   * feasible decay can match it (mathematically unavoidable for this pool), the
   * inflation is allowed but FLAGGED via a `winRate`-lever relaxation entry so
   * the proposal can surface it — never silently. Omit to skip the anchor
   * (value-only shaping with the `BETA_WIN_FLOOR` baseline rarity).
   */
  currentWeights?: number[];
  /**
   * When TRUE, the `targetWinRate` is a HARD design target that must NOT drift —
   * used for TAGGED lottery packs whose name carries an "X%" hit-rate tag (the
   * tag IS the intended win-rate). With a hard win-rate the solver does NOT float
   * the win-rate up to reach a high EV (owner rule #2's float-up is for soft /
   * untagged packs only) and does NOT exempt the cheapest winner from its
   * anti-inflation cap — so a "5% …" pack stays at ~5% wins, its big jackpots
   * carrying the EV at the tag rate. ONE bounded exception (the RC4 saturated
   * EV knob): when the anchored+hard-tag solve is SATURATED (target EV below
   * the capped pool's reachable minimum — previously a hard
   * `ev-unreachable-for-split` error), the solver interpolates the capped win
   * shares toward the CHEAPEST winner: every jackpot / non-cheapest winner's
   * odds only ever DROP, the win mass stays pinned at the tag, and only the
   * cheapest winner (the anti-jackpot) rises. Default FALSE: the win-rate is
   * SOFT and floats UP rather than inflating the jackpot (the untagged-pack
   * policy).
   */
  winRateIsHard?: boolean;
  /**
   * WIN-RATE HOLD (owner-lens item 4): when TRUE (the untagged RETUNE path), the
   * SOFT win-rate float-up is capped at `targetWinRate + WINRATE_HOLD_BAND`
   * (+5pp) so the achieved win-rate holds within the band of the pack's
   * live-anchored design instead of floating far above it (Three Blades
   * 30%→37.5%). The float can still rise toward the band to reach the edge; when
   * the pool genuinely needs MORE than the band's winners to hit the edge at a
   * given price, the solve errors at THAT price and the retune's price search
   * moves the ticket to a price where the band-held win-rate reaches the edge
   * (a clean plan) — or, if no in-budget price admits it, the pack honestly
   * surfaces as the wide-probe / pool-edit path. Default FALSE: the float is
   * UNBOUNDED (the legacy behavior every direct `shapeWeights` caller — the
   * scenario builder, the anti-inflation harness — keeps byte-identical). No-op
   * when `winRateIsHard` (tagged packs never float).
   */
  holdWinRate?: boolean;
  /**
   * WIN-RATE HOLD — HARD (untagged retune, owner-lens spike fix, attempt #2):
   * when TRUE, the UNTAGGED win-rate is PINNED at the design `targetWinRate` (no
   * +band float at all — a strict superset of {@link holdWinRate}'s +5pp band)
   * AND the CHEAPEST winner is NOT EV-exempt from its anti-inflation cap.
   * Distinct from {@link winRateIsHard} on purpose: this flag carries NONE of
   * the tagged-only semantics — no RC4 saturated-EV interpolation, no
   * one-sided-up tag acceptance, no 0.01pp {@link TAGGED_WINRATE_TOLERANCE} snap
   * gate. Snap acceptance stays on the SOFT untagged path (within `winRateTol`
   * under the `softWinRateCeil`).
   *
   * ROOT CAUSE it fixes: on the soft path the cheapest winner is EV-exempt (its
   * `monoCap` is `Infinity`), so it becomes an uncapped SINK; the win-rate then
   * floats up to design+5pp and the solver dumps that floated win mass onto that
   * one uncapped cheapest card — the mid-pool SPIKE. Pinning the win-rate at
   * design and capping the cheapest winner removes the sink: EV is reached by
   * the (unconditional) `winBeta` steepening within the anti-inflation caps +
   * `disperseLoss`, yielding a clean monotonic ladder where the cheapest card
   * carries the most.
   *
   * GRACEFUL FALLBACK (attempt #2 fix for the regression in attempt #1): this
   * flag is a PREFERENCE at the `searchBestPriceForCleanSnap` orchestration
   * level, not a hard requirement — when NO in-budget price admits a hard-held
   * clean solve, the caller (`searchBestPriceForCleanSnap`) automatically
   * retries the WHOLE search with the old SOFT `holdWinRate` so a genuinely
   * EV-forced pack (Captive, Dooms Day) still gets its plan instead of a bare
   * refusal — see `searchBestPriceForCleanSnap`'s `holdWinRateHard` handling.
   *
   * No-op when {@link winRateIsHard} (a tagged pack already pins the win-rate).
   * Default FALSE: every legacy direct `shapeWeights` caller stays byte-identical.
   */
  holdWinRateHard?: boolean;
  /**
   * LOSS-MASS DISPERSION (owner-lens item 10): when TRUE (the RETUNE path), the
   * free-dust loss band is RE-SPREAD after the single-β layout — the min-L2
   * (affine-in-value) distribution at the SAME band mass + EV, so edge / win-rate
   * / tag / every anti-inflation cap are byte-for-byte preserved while the loss
   * mass stops piling on a single carrier (the crush ladder). No-op when the band
   * has < 2 distinct values or the required average is EV-forced near the band
   * max (Captive — the pool-edit path is the real fix there). Default FALSE: the
   * legacy single-β loss layout (every direct `shapeWeights` caller — the
   * scenario builder, the anti-inflation / niceness harnesses — byte-identical).
   */
  disperseLoss?: boolean;
  /**
   * Owner-pinned EXACT per-card odds (Retune V2 pins). Each entry holds the
   * card at `cards[index]` at EXACTLY `share` (a fraction of the TOTAL pool
   * mass) through the whole pipeline — solve, quantize AND the clean-ladder
   * snap: a pin is an owner-chosen number, exempt from ladder membership, so
   * the snap only ever moves unpinned cards and picks its buffer among them.
   * The pinned mass + EV are subtracted up-front and the residual pool solves
   * to the residual EV target with all the existing machinery (bands,
   * anti-inflation anchor, tag hardness, one-sided-up acceptance, quantize)
   * operating on the remainder. On a hard-tag solve, pinned WIN-band shares
   * count toward the tag sum and the remaining win cards absorb the residual
   * so the tag stays exact.
   *
   * Pins that make the request impossible come back as the structured
   * `pins-infeasible` limit (data, never a throw): a pin the max-win-cap
   * pre-filter would drop (carries the raise-cap remedy), pins overshooting a
   * hard tag, pins forcing the edge below target (deliberate below-target
   * pools live in the Drafts flow) or above the accepted band, and pins
   * pushing EV outside the residual pool's reach — each with a computable
   * suggestion quantifying the over/undershoot. Omit (or pass an empty
   * array) for the legacy behavior — byte-identical.
   */
  pinnedShares?: ShapeWeightsPinnedShare[];
  /**
   * PLAN-WIDE tagged-snap DFS node budget (perf-incident fix). A MUTABLE shared
   * counter threaded straight into {@link snapTaggedPer100k} so ALL of a plan's
   * snaps share ONE bound on the all-nice enumeration (see the
   * {@link snapTaggedPer100k} header). Set by {@link searchBestPriceForCleanSnap}
   * in tagged mode; omit for the legacy per-snap-only cap (byte-identical).
   */
  nodeBudget?: SnapNodeBudget;
  /**
   * NICE-GRID POST-PASS (Retune V3 wave 7): forwarded to
   * {@link snapTaggedPer100k} so an accepted tier-G tagged snap is polished
   * onto the human-nice grid ({@link polishTaggedNiceGrid} — strictly
   * improving, full acceptance stack re-verified per move). Set by
   * {@link searchBestPriceForCleanSnap} when its own flag is on; omit for the
   * legacy tier-G vector (byte-identical).
   */
  niceGridPolish?: boolean;
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
  /**
   * ANTI-INFLATION anchor outcome (only meaningful when `currentWeights` was
   * supplied — see {@link ShapeWeightsInput.currentWeights}). When the solver
   * could NOT keep every WIN/GRAIL card's odds at/below its current odds — i.e.
   * a card's current rarity is so extreme that no feasible decay matches it —
   * the inflation is mathematically unavoidable for this pool. This flag is then
   * `true` and a `winRate`-lever relaxation records the detail, so the proposal
   * surfaces "jackpot odds had to rise (unavoidable)" instead of silently
   * inflating. `false`/undefined = no win/grail card inflated vs current (the
   * normal case), or the anchor wasn't requested.
   */
  topInflationUnavoidable?: boolean;
  /**
   * ONE-SIDED-UP acceptance outcome (hard-tag solves only): when the pool's
   * never-inflate caps + hard tag pinned the reachable EV BELOW the target EV
   * (achieved edge lands ABOVE the target — house-favorable), the solve was
   * accepted with this edge excess (≤ {@link ONE_SIDED_EDGE_EXCESS_TOL},
   * 0.25pp) instead of hard-erroring. `undefined` = the normal exact landing.
   * Surfaces as "edge landed +X.XXpp above target (pool-pinned)" in plans.
   */
  oneSidedEdgeExcess?: number;
  /**
   * Tagged per-100k snap only: every non-exempt card landed on the human-nice
   * rung grid ({@link isOnNiceGridPct} — 0.05% / 0.25% / 0.35% / 2.5% …).
   * `false` = the accepted snap is per-100k-exact but still carries ≥ 1
   * non-exempt off-nice card (the pool is too pinned for round numbers at any
   * in-band price — the plan surfaces the honesty banner). `undefined` for
   * untagged / unsnapped results — untagged behavior is byte-identical.
   */
  allNice?: boolean;
  /**
   * Tagged per-100k snap only: indexes EXEMPT from the niceness ACCOUNTING
   * (the dust residual buffer, owner-pinned cards, a forced single free
   * winner). The partial-tier absorber is construction-exempt but COUNTS —
   * the owner reads its odds too. The plan projection skips these when
   * flagging off-nice rows so the engine and the workspace can never
   * disagree.
   */
  niceExemptIdx?: number[];
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
 * - `pins-infeasible`       — owner-pinned odds make the request impossible
 *                             (cap-dropped pin, tag/EV over- or undershoot,
 *                             edge out of the accepted band, malformed pin);
 *                             the suggestion quantifies the miss.
 * - `loss-nonmonotone`      — no monotone-non-increasing layout of the FREE
 *                             below-price loss band exists at the required loss
 *                             mass + EV (the pins / added cards force a rich
 *                             loss card likelier than a cheaper one). The plan
 *                             would be garbage-ordered; the pool edit is the fix.
 * - `monotone-unreachable`  — LAW M (Retune V3): no FULL-ladder monotone layout
 *                             (odds only rising down the value order, pins
 *                             sovereign, zero-weight rows exempt) can carry the
 *                             landed EV at this price/win mass under the
 *                             never-inflate caps. The detail carries the lawful
 *                             EV window so guidance can say what WOULD fit.
 * - `tag-unreachable`       — LAW T (Retune V3 stage 3): the pack's TAG cannot
 *                             be lawfully hosted — the solver refused at every
 *                             in-band candidate price AND the LAW M window
 *                             math at the live price proves the tag sits
 *                             outside the pool's lawful fit range
 *                             ({@link lawfulTagFitRange}). The detail carries
 *                             the largest tag that DOES fit (or that no tag
 *                             fits at all), so the verdict is actionable:
 *                             retag, untag, or edit the pool.
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
  | "edge-unreachable"
  | "pins-infeasible"
  | "loss-nonmonotone"
  | "monotone-unreachable"
  | "tag-unreachable";

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
  /**
   * TRUE when no price change can clear this limit (e.g. no-dust-cards with
   * 2·minValue ≥ maxValue): the cheapest card is worth more than half the
   * priciest, so every price either strips all winners or leaves no losers.
   * The price search short-circuits on it (searched = 1) and the plan copy
   * says "no price works — edit the pool" instead of suggesting price moves.
   */
  priceIndependent?: boolean;
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
 *
 * EXPORTED for the tag-guidance engine (`tag-guidance.ts`), which rebuilds the
 * solver's exact feasibility interval (LAW 1) outside a solve — sharing this
 * implementation is what makes the interval identity a structural fact.
 */
export function bandEvForBeta(values: readonly number[], beta: number): number {
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
export const BETA_LO = -20; // skew expensive → max EV
export const BETA_HI = 50; // skew cheap → min EV

/**
 * Hard FLOOR on the beta used to lay out the WIN+GRAIL pool (cards worth
 * ≥ price). Owner rule #1: for value ≥ price, probability must be STRICTLY
 * DECREASING in value — the jackpot is always the rarest pull, and raising the
 * edge must only ever TRIM the expensive tail, never inflate it.
 *
 * A power-law template `value^(−β)` is strictly decreasing in value iff β > 0.
 * The legacy solver bisected a SINGLE shared β over [BETA_LO=−20, BETA_HI=50]
 * across all four bands, and to reach a HIGH EV target (a low win-rate with a
 * big payout budget) it drove β NEGATIVE — which skews the win pool toward the
 * EXPENSIVE end and inflates the jackpot's odds (the $20.50 Charizard
 * 0.15% → 0.75% bug). Flooring the win-pool β at a small POSITIVE value keeps
 * the jackpot strictly the rarest winner regardless of the EV target. EV is
 * instead reached by (a) the loss bands' β and (b) floating the win-RATE up
 * (more cheap winners) — never by enlarging jackpot odds. See the EV solve.
 *
 * 1.5 is calibrated against the live catalog: on the real $20.50 / 12-card
 * pack (Charizard $541.96), the win pool spans $20.53–$541.96 and the live
 * jackpot odds are 0.15%. A flat β (≈0) at the 20% win-mass put 1.37% on the
 * Charizard (the inflation bug); β=1.5 puts ~0.06% — comfortably BELOW the live
 * 0.15%, so raising the edge TRIMS the jackpot instead of inflating it. β=1.5
 * (value^−1.5) is the gentlest decay that keeps the expensive tail rare across
 * the catalog's win-pool value spreads without over-steepening tight clusters
 * (where all win cards sit close, the curve is still nearly flat). Tagged
 * lottery packs steepen FURTHER via `applyLotterySkew` (β=2); this floor is the
 * baseline rarity every pack's win pool must clear.
 */
export const BETA_WIN_FLOOR = 1.5;

/**
 * Hard CEILING on the win-pool steepening beta (the EV-lowering knob): the
 * solver may steepen the win pool from {@link BETA_WIN_FLOOR} up to this to
 * pull a too-high capped win EV down toward a low target. Module-level (and
 * exported) so the tag-guidance engine's LAW-1 EVmin — `W(BETA_WIN_MAX)` —
 * uses the SAME endpoint the solver's own steepening bisection can reach.
 */
export const BETA_WIN_MAX = 12;

/**
 * One-sided-UP edge acceptance for HARD-TAGGED solves (ruleset §1.2
 * saturation acceptance, [math LAW 9] companion — kills the RC4 1e-6 equality
 * wall): when a tagged pool's reachable EV maximum sits BELOW the target EV —
 * i.e. the pool lands HOUSE-FAVORABLE, achieved edge ABOVE the target — the
 * solve is accepted as long as the excess `(1 − evMax/price) − targetEdge` is
 * at most this (0.25pp). The edge floor stays sacred (the `evTarget < evMin`
 * side — achieved edge BELOW target — still hard-errors); this only ever
 * accepts extra house margin on a pool whose never-inflate caps + hard tag pin
 * the EV to (nearly) a point. Fleet-verified: two-sided 0.25pp accepts 23/33
 * stuck tagged pools; one-sided-up keeps the floor while unlocking the same.
 */
export const ONE_SIDED_EDGE_EXCESS_TOL = 0.0025;

/**
 * POST-SOLVE WIN-RATE HOLD band for SOFT (untagged) packs (owner-lens
 * build-order item 4, 2026-07-03). The live-anchored `targetWinRate` sets the
 * pack's designed win-rate, but the anchored EV solve still FLOATS the win-rate
 * UP without bound (the cheapest winner is EV-exempt at `Infinity` cap, so the
 * float ceiling `winMassCeil` collapses to the structural dust margin — the
 * float ran to 37%+ on a 30%-designed pack). The fleet re-run measured 38
 * untagged plans whose achieved win-rate floated MORE than this band above
 * their live-anchored target (Three Blades 30.0%→37.5%, Trash 33.2%→40.2% among
 * them), rewriting the pack's designed hit-rate.
 *
 * The HOLD caps the float ceiling at `targetWinRate + this band` (SOFT +
 * anchored only), so the achieved win-rate lands within +5pp of the designed
 * rate. It only ever LOWERS the ceiling toward the design — it never floats
 * BELOW `targetWinRate` (that stays the floor) and it never inflates a jackpot
 * (the never-inflate caps are untouched). When the pool genuinely needs MORE
 * than `target + band` winners to reach the edge target, the float saturates at
 * the cap and the achieved edge lands ABOVE target — house-favorable, accepted
 * within {@link ONE_SIDED_EDGE_EXCESS_TOL} or surfaced honestly as the
 * ev-unreachable limit (the pool-edit / retag path). TAGGED packs are untouched
 * (`winRateIsHard` already pins the win-rate to the tag exactly).
 */
export const WINRATE_HOLD_BAND = 0.05;

/**
 * Water-fill a probability MASS over a band's values by a `value^(−beta)`
 * power-law, capping each card at `caps[i]` (absolute pool-odds) and
 * re-distributing the overflow onto the still-uncapped cards. Returns the
 * per-card probabilities plus how much of the mass fit under the caps
 * (`placed < mass` ⇒ the caps saturate — the caller decides how to spill the
 * residual). Pure; `caps[i] = Infinity` means uncapped.
 *
 * This is THE anchored win-pool layout `shapeWeights` uses (extracted so the
 * tag-guidance engine can rebuild the solver's exact feasibility interval —
 * one implementation, no drift).
 */
export function waterFillBandProbs(
  values: readonly number[],
  caps: readonly number[],
  mass: number,
  beta: number,
): { probs: number[]; placed: number } {
  const n = values.length;
  const raw = values.map((v) => Math.pow(v, -beta));
  const probs = new Array<number>(n).fill(0);
  const capped = new Array<boolean>(n).fill(false);
  let remaining = mass;
  for (let round = 0; round < n + 1; round++) {
    let rawSum = 0;
    for (let i = 0; i < n; i++) if (!capped[i]) rawSum += raw[i]!;
    if (!(rawSum > 0) || !(remaining > 1e-15)) break;
    let cappedThisRound = false;
    for (let i = 0; i < n; i++) {
      if (capped[i]) continue;
      const want = probs[i]! + (raw[i]! / rawSum) * remaining;
      const cap = caps[i]!;
      if (want > cap + 1e-15) {
        remaining -= cap - probs[i]!;
        probs[i] = cap;
        capped[i] = true;
        cappedThisRound = true;
      }
    }
    if (!cappedThisRound) {
      for (let i = 0; i < n; i++) {
        if (capped[i]) continue;
        probs[i] = probs[i]! + (raw[i]! / rawSum) * remaining;
      }
      remaining = 0;
      break;
    }
  }
  const placed = probs.reduce((a, b) => a + b, 0);
  return { probs, placed };
}

/**
 * The win-band EV of a water-filled mass INCLUDING the proportional spill of
 * any residual the caps couldn't hold (spill ∝ v^−β — exactly how the solver
 * spills unavoidable inflation). This is the `W(β)` of the LAW-1 feasibility
 * interval:  EVmin = W(BETA_WIN_MAX) + loss-cheap,  EVmax = W(BETA_WIN_FLOOR)
 * + loss-expensive. Exported for `tag-guidance.ts`.
 */
export function waterFillWinEv(
  values: readonly number[],
  caps: readonly number[],
  mass: number,
  beta: number,
): number {
  if (values.length === 0 || !(mass > 0)) return 0;
  const { probs, placed } = waterFillBandProbs(values, caps, mass, beta);
  let ev = 0;
  for (let i = 0; i < values.length; i++) ev += probs[i]! * values[i]!;
  if (placed < mass - 1e-12) {
    const residual = mass - placed;
    const raw = values.map((v) => Math.pow(v, -beta));
    const rawSum = raw.reduce((a, b) => a + b, 0);
    if (rawSum > 0) {
      for (let i = 0; i < values.length; i++) {
        ev += (raw[i]! / rawSum) * residual * values[i]!;
      }
    }
  }
  return ev;
}

/**
 * The quantization floor (as a FRACTION of the pool, not percent) a card's
 * planned share is pinned at once it lands there — mirrors
 * `tag-guidance.ts`'s `FLOOR_PINNED_MAX_PCT` (0.0001%) as a fraction
 * (0.0001 / 100 = 1e-6). Duplicated as a raw fraction (rather than imported)
 * because `tag-guidance.ts` imports FROM `risk.ts` — importing back would be a
 * cycle. Used ONLY by {@link disperseLossBand}'s never-newly-crush guard
 * below; the two constants must stay numerically in lock-step.
 */
const DISPERSE_FLOOR_PIN_FRACTION = 1e-6;

/**
 * A card's input share counts as "real" (not already floor-pinned / dust-tier
 * noise) once it clears 20× the floor-pin fraction — i.e. it already carries
 * meaningfully more than a quantization artifact. Used ONLY by the
 * never-newly-crush guard: dispersion must never take a card with REAL input
 * mass down to the floor, even when doing so numerically lowers the band's
 * max single-card concentration.
 */
const DISPERSE_REAL_MASS_FLOOR = 20 * DISPERSE_FLOOR_PIN_FRACTION;

/** Power-law weight template for a band, normalized to sum to `mass`. */
function bandWeights(values: readonly number[], beta: number, mass: number): number[] {
  if (values.length === 0) return [];
  const w = values.map((v) => Math.pow(v, -beta));
  const sumW = w.reduce((a, b) => a + b, 0);
  if (!(sumW > 0)) return values.map(() => mass / values.length);
  return w.map((wi) => (wi / sumW) * mass);
}

/**
 * LOSS-MASS DISPERSION (owner-lens build-order item 10, 2026-07-03).
 *
 * The loss band is laid out by ONE shared power-law β chosen to hit the exact EV
 * target — which pins the band's MEAN but is indifferent between a live-like
 * spread and a single-carrier collapse. On ~60 fleet packs that produced a crush
 * ladder: one card carries almost all the loss mass while its siblings sit at the
 * quantization floor (a live-≥5% card planned ≤0.005%). This pass RE-SPREADS the
 * loss mass across the band WITHOUT changing the band's mass or EV — so the pack's
 * edge, win-rate, tag and every anti-inflation cap are byte-for-byte preserved
 * (the loss band has no never-inflate cap; only its mass + EV are load-bearing,
 * and both are held exactly).
 *
 * THE MATH — the minimum-concentration distribution at fixed (mass, EV) is AFFINE
 * in value. Minimizing the L2 norm `½·Σ wᵢ²` (the standard "spread the mass out"
 * objective — L2 is minimized by the flattest vector) subject to `Σ wᵢ = mass`
 * and `Σ wᵢ·vᵢ = EV` has the Lagrangian stationary point `wᵢ = a + b·vᵢ` — a
 * straight line in value. Solve `a`, `b` from the two constraints:
 *   b = (mass·Σv·v̄ − EV·Σv) / (mass·Σv² − (Σv)²)   [ = Cov-form ]
 *   a = (mass − b·Σv) / n
 * (denominator = mass·n·Var(v) > 0 whenever ≥ 2 DISTINCT values exist).
 *
 * NON-NEGATIVITY (the EV-forced case): when the required mean sits at/near the
 * band's MAX value (Captive's loss side must average ≈$80 across $80/$34/$18 —
 * only the $80 card can carry it), the affine solution puts NEGATIVE weight on
 * the cheap cards. That is the honest signal that the crush is EV-FORCED, not a
 * layout artifact — dispersion can't help and the pool-edit path is the real fix.
 * We active-set clamp: drop the most-negative card to 0 and re-solve on the rest,
 * repeating until all weights are ≥ 0 (mass + EV still held exactly on the
 * survivors). If fewer than 2 free cards remain, we stop — a single carrier is
 * unavoidable and the input weights are returned unchanged.
 *
 * ONLY DISPERSES (never concentrates): the affine result is adopted ONLY when it
 * strictly LOWERS the band's max single-card share vs the input (Σw² is a proxy;
 * we check the max share directly) — so a band the β-layout already spread well
 * is left byte-identical. Pure; returns the input array unchanged when there is
 * no room to disperse (< 2 distinct values, degenerate variance, or no
 * improvement).
 */
export function disperseLossBand(
  values: readonly number[],
  weights: readonly number[],
  mass: number,
): number[] {
  const n = values.length;
  if (n < 2 || !(mass > 0)) return weights.slice();
  // The band's current EV (the invariant we hold exactly).
  let ev = 0;
  for (let i = 0; i < n; i++) ev += weights[i]! * values[i]!;
  if (!(ev > 0)) return weights.slice();

  // Active-set solve of the affine (min-L2) distribution `w = a + b·v` on the
  // set of cards allowed positive mass; drop the most-negative card and re-solve
  // until all survivors are ≥ 0 (mass + EV held exactly on the survivors).
  const active = new Array<boolean>(n).fill(true);
  const out = new Array<number>(n).fill(0);
  for (let iter = 0; iter < n; iter++) {
    let k = 0;
    let sumV = 0;
    let sumV2 = 0;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      k += 1;
      sumV += values[i]!;
      sumV2 += values[i]! * values[i]!;
    }
    if (k < 2) return weights.slice(); // one carrier left — nothing to disperse
    const denom = k * sumV2 - sumV * sumV; // = k²·Var(v) ≥ 0
    if (!(denom > 1e-12)) return weights.slice(); // all-equal values on the active set
    // Solve the 2×2 system exactly:
    //   a·k    + b·Σv   = mass
    //   a·Σv   + b·Σv²  = ev
    // ⇒ b = (mass·Σv − ev·k) / (Σv² · … ) — via Cramer's rule (det = Σv² − k·… );
    // written with det = (sumV² − k·sumV2) = −denom so the signs stay explicit.
    const det = sumV * sumV - k * sumV2; // = −denom < 0
    const bSolved = (mass * sumV - ev * k) / det;
    const aSolved = (mass - bSolved * sumV) / k;
    let anyNeg = false;
    let mostNegIdx = -1;
    let mostNegVal = 0;
    for (let i = 0; i < n; i++) {
      if (!active[i]) {
        out[i] = 0;
        continue;
      }
      const w = aSolved + bSolved * values[i]!;
      out[i] = w;
      if (w < -1e-12 && w < mostNegVal) {
        mostNegVal = w;
        mostNegIdx = i;
        anyNeg = true;
      }
    }
    if (!anyNeg) break;
    active[mostNegIdx] = false; // drop the most-negative card, re-solve
  }

  // Guard: mass + EV must still match (numerical safety), the result must
  // actually DISPERSE (lower the max single-card share), AND it must never
  // NEWLY CRUSH a card that carried real input mass down to the quantization
  // floor — else keep the input.
  //
  // NEAR-MISS FLOOR-PIN FIX (owner-lens attempt #2, item B): the active-set
  // solve above can zero out a card whose value sits at the EXPENSIVE end of
  // the loss band (typically a near-miss card) when the required band mean is
  // dragged low by a cheap concentration elsewhere — the affine fit needs
  // NEGATIVE weight there, so the active-set drops it entirely. That numerically
  // LOWERS the max single-card share (the old guard's only test), so the old
  // guard accepted it — but it just turned a healthy live-tracking card into a
  // brand-new 0.0001%-floor-pinned card, the exact "why is this at 0.0001%?"
  // ugliness the dispersion pass exists to REMOVE, not create. A card is
  // "newly crushed" when its INPUT share already cleared
  // `DISPERSE_REAL_MASS_FLOOR` (meaningfully more than floor-pin noise) but its
  // OUTPUT share lands at/under the floor-pin fraction. When that happens the
  // whole dispersed vector is rejected (return the un-dispersed input instead)
  // — the single-carrier crush the input already had is the honest signal for
  // the pool-edit / add-card guidance to pick up, never silently swapped for a
  // DIFFERENT crushed card.
  let outMass = 0;
  let outEv = 0;
  let outMax = 0;
  let inMax = 0;
  let newlyCrushed = false;
  for (let i = 0; i < n; i++) {
    const w = out[i]! > 0 ? out[i]! : 0;
    out[i] = w;
    outMass += w;
    outEv += w * values[i]!;
    if (w > outMax) outMax = w;
    if (weights[i]! > inMax) inMax = weights[i]!;
    if (weights[i]! >= DISPERSE_REAL_MASS_FLOOR && w <= DISPERSE_FLOOR_PIN_FRACTION) {
      newlyCrushed = true;
    }
  }
  if (
    !(outMass > 0) ||
    Math.abs(outMass - mass) > 1e-6 * Math.max(1, mass) ||
    Math.abs(outEv - ev) > 1e-6 * Math.max(1, ev) ||
    outMax >= inMax - 1e-12 || // no improvement — the layout was already spread
    newlyCrushed // would create a NEW floor-pinned card — reject, keep input
  ) {
    return weights.slice();
  }
  return out;
}

/**
 * A whole-band dispersal result is only kept when it does not DRAIN the
 * near-miss band: the affine min-L2 fit is near-miss-blind, and when the loss
 * band's required mean sits low (cheap dust must carry the edge) the straight
 * line assigns the expensive near-miss cards almost nothing — silently
 * rewriting the pack's designed "almost!" band (owner incident "Tails?",
 * 2026-07-06: a live-10% near-miss card planned at 4% with no diagnostic).
 * Below this tolerance of near-miss band shrinkage the plain dispersal is
 * kept as-is; above it the rescue layout below is tried first.
 */
const NEARMISS_PRESERVE_TOL = 0.005;

/**
 * Boundary-dip gate for the loss-chain FLATTEN (owner incident "OG Set",
 * 2026-07-06): the flatten is tried only when the most expensive loss-chain
 * card lands more than this far (2pp) BELOW the cheapest planned card of the
 * band above it — the "ladder sandwich" the owner reads as a hole (win 15% →
 * dust 5% → 20% → 34.5%). Sub-2pp dips are left to the affine dispersal so
 * near-flat fleet layouts don't churn.
 */
const LOSS_FLATTEN_DIP_TOL = 0.02;

/**
 * NEAR-MISS-PRESERVING LOSS LAYOUT — the rescue arm of the loss dispersion.
 *
 * {@link disperseLossBand} re-spreads the WHOLE loss band (near-miss + dust)
 * at fixed mass + EV, but its affine-in-value objective knows nothing about
 * the near-miss FLOOR the solver just allocated ({@link ShapeWeightsInput}'s
 * `nearMissMin` — a designed feel dial, live-anchored on untagged packs). On
 * a pool whose loss mean is dragged low by cheap dust, the affine line
 * starves the expensive near-miss card(s) (owner incident "Tails?": live 10%
 * → planned 4%, sitting visually UNDER a win card).
 *
 * This function builds the alternative layout that keeps the near-miss band
 * as close to its allocated input mass as the pool's physics allow, while
 * holding the SAME hard invariants as the dispersal (total mass + total EV
 * exact ⇒ edge/win-rate/tag byte-preserved) AND the loss-monotonicity owner
 * rule (cheapest-carries-most on the non-buffer chain — so the later
 * {@link enforceLossMonotone} pass has nothing to pull back down):
 *
 *   1. FULLY-FUNDED: keep the near-miss cards' input weights VERBATIM, run
 *      the standard dispersal on the dust side alone (its own mass + EV), and
 *      accept only when every non-buffer dust card still carries ≥ the
 *      heaviest near-miss card (monotone across the band boundary).
 *   2. SCALED (the EV-feasible maximum): one shared level `x` across ALL
 *      non-buffer loss cards (near-miss + dust chain) with the buffer
 *      absorbing the remainder — the closed-form solution of "maximize the
 *      near-miss band subject to mass, EV and monotonicity". `x` solves
 *      `x·Σv_chain + (mass − k·x)·v_buffer = EV`. The near-miss band lands at
 *      `min(k_nm·x, its input mass)` — the honest physical ceiling.
 *
 * Returns `null` when no rescue shape passes the guards (buffer inside the
 * near-miss band, degenerate values, a level that would newly floor-pin a
 * real-mass card, or a non-monotone/mass/EV-violating result) — the caller
 * then keeps the plain dispersal and the end-of-solve relaxation check
 * reports the shrinkage honestly instead. Pure + dep-free for the
 * `packs/__checks__` harness.
 *
 * NO-NEAR-MISS POOLS (owner incident "OG Set", 2026-07-06): with zero cards
 * in the near-miss band the same scaled arm degrades to the pure uniform
 * dust chain — the closed-form MAXIMUM the most expensive loss card can
 * carry at fixed mass + EV with a monotone chain. The caller uses it to
 * flatten ladder sandwiches (win-bottom 15% → dust 5% → 20% → 34.5% reads
 * as a hole; the uniform 8% / 8% / 43.5% is the physics ceiling for the 5%).
 */
export function preserveNearMissLossLayout(input: {
  /** Loss-band card values (parallel to `weights`). */
  values: readonly number[];
  /** PRE-dispersal loss-band weights — the mass/EV/near-miss source of truth. */
  weights: readonly number[];
  /** The NEARMISS band's lower boundary (0.5·price): value ≥ this ⇒ near-miss. */
  nearMissLo: number;
}): number[] | null {
  const { values, weights, nearMissLo } = input;
  const n = values.length;
  if (n < 2) return null;
  let mass = 0;
  let ev = 0;
  for (let i = 0; i < n; i++) {
    if (!(weights[i]! >= 0) || !Number.isFinite(values[i]!)) return null;
    mass += weights[i]!;
    ev += weights[i]! * values[i]!;
  }
  if (!(mass > 0) || !(ev > 0)) return null;

  // Buffer = argmax input weight, tie → cheapest (the same residual-absorber
  // convention the snap + enforceLossMonotone use). A buffer inside the
  // near-miss band has no rescue shape (the sink must be a dust card).
  let buf = 0;
  for (let i = 1; i < n; i++) {
    if (
      weights[i]! > weights[buf]! ||
      (weights[i]! === weights[buf]! && values[i]! < values[buf]!)
    ) {
      buf = i;
    }
  }
  if (values[buf]! >= nearMissLo) return null;
  const vb = values[buf]!;

  let kNm = 0;
  let nmMass = 0;
  let nmEv = 0;
  let maxNmW = 0;
  let kD = 0;
  let sumVD = 0;
  let sumVChain = 0;
  for (let i = 0; i < n; i++) {
    if (values[i]! >= nearMissLo) {
      kNm += 1;
      nmMass += weights[i]!;
      nmEv += weights[i]! * values[i]!;
      if (weights[i]! > maxNmW) maxNmW = weights[i]!;
      sumVChain += values[i]!;
    } else if (i !== buf) {
      kD += 1;
      sumVD += values[i]!;
      sumVChain += values[i]!;
    }
  }
  if (kNm > 0 && !(nmMass > 0)) return null;

  const accept = (out: number[]): number[] | null => {
    // Hard invariants: exact mass + EV (⇒ edge/win-rate untouched), no
    // negative weight, no NEWLY floor-pinned real-mass card, and the
    // non-buffer chain monotone non-increasing in value (so the later
    // enforceLossMonotone pass is a no-op on this layout).
    let outMass = 0;
    let outEv = 0;
    for (let i = 0; i < n; i++) {
      const w = out[i]!;
      if (!(w >= 0)) return null;
      outMass += w;
      outEv += w * values[i]!;
      if (
        weights[i]! >= DISPERSE_REAL_MASS_FLOOR &&
        w <= DISPERSE_FLOOR_PIN_FRACTION
      ) {
        return null;
      }
    }
    if (
      Math.abs(outMass - mass) > 1e-6 * Math.max(1, mass) ||
      Math.abs(outEv - ev) > 1e-6 * Math.max(1, ev)
    ) {
      return null;
    }
    const chain: { v: number; w: number }[] = [];
    for (let i = 0; i < n; i++) {
      if (i === buf) continue;
      chain.push({ v: values[i]!, w: out[i]! });
    }
    chain.sort((a, b) => a.v - b.v);
    for (let k = 0; k + 1 < chain.length; k++) {
      if (chain[k]!.w < chain[k + 1]!.w - 1e-9) return null;
    }
    // The buffer must remain the argmax (still the residual absorber).
    for (let i = 0; i < n; i++) {
      if (i !== buf && out[i]! > out[buf]! + 1e-9) return null;
    }
    return out;
  };

  // ── 1. FULLY-FUNDED: near-miss weights verbatim, dust re-spread alone ────
  // (kNm === 0 skips straight to the scaled arm: re-spreading the dust alone
  // would just reproduce the affine dispersal the caller is escaping.)
  if (kNm >= 1 && kD >= 1) {
    const dustIdx: number[] = [];
    for (let i = 0; i < n; i++) {
      if (values[i]! < nearMissLo) dustIdx.push(i);
    }
    const dustValues = dustIdx.map((i) => values[i]!);
    const dustW = dustIdx.map((i) => weights[i]!);
    const dustMass = mass - nmMass;
    if (dustMass > 0) {
      const dispersedDust = disperseLossBand(dustValues, dustW, dustMass);
      const out = weights.slice();
      dustIdx.forEach((i, j) => {
        out[i] = dispersedDust[j]!;
      });
      // Monotone across the band boundary: every non-buffer dust card must
      // still carry ≥ the heaviest near-miss card.
      let boundaryOk = true;
      for (const i of dustIdx) {
        if (i !== buf && out[i]! < maxNmW - 1e-9) {
          boundaryOk = false;
          break;
        }
      }
      if (boundaryOk) {
        const accepted = accept(out);
        if (accepted !== null) return accepted;
      }
    }
  }

  // ── 2. SCALED: one shared level x on the whole non-buffer chain ─────────
  const kChain = kNm + kD;
  const denom = sumVChain - kChain * vb;
  if (!(denom > 1e-9)) return null;
  const x = (ev - mass * vb) / denom;
  if (!(x > 0)) return null;
  // Never fund the near-miss band ABOVE its input allocation: when the
  // uniform level would overfund it, keep the near-miss cards' input weights
  // VERBATIM (mass + EV of the band exact) and re-level the dust chain to
  // absorb the freed budget (null when the buffer can no longer stay argmax).
  const xNmFull = kNm >= 1 ? nmMass / kNm : Infinity;
  const out = new Array<number>(n).fill(0);
  if (kNm >= 1 && x > xNmFull + 1e-12 && kD >= 1) {
    const denomD = sumVD - kD * vb;
    if (!(denomD > 1e-9)) return null;
    const y = (ev - nmEv - (mass - nmMass) * vb) / denomD;
    if (!(y >= maxNmW - 1e-12)) return null;
    const wb = mass - nmMass - kD * y;
    if (!(wb >= y - 1e-12)) return null;
    for (let i = 0; i < n; i++) {
      if (i === buf) out[i] = wb;
      else if (values[i]! >= nearMissLo) out[i] = weights[i]!;
      else out[i] = y;
    }
    return accept(out);
  }
  const wb = mass - kChain * x;
  if (!(wb >= x - 1e-12)) return null;
  for (let i = 0; i < n; i++) {
    out[i] = i === buf ? wb : x;
  }
  return accept(out);
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

/**
 * THE LOSS/SUB-PRICE MONOTONICITY INVARIANT (owner rule, universal, 2026-07-03).
 *
 * Among the FREE (non-pinned) cards priced BELOW the pack price — the NEARMISS +
 * DUST loss bands — probability must be MONOTONICALLY NON-INCREASING in card
 * value: the CHEAPEST card always carries the HIGHEST odds, no inversions. This
 * is the invariant the "10% Divine Order" pinned+added-card scramble broke
 * (562.22→20%, 299.99→30%, 111.02→0.001% — a rich loss card likelier than a
 * cheap one). The WIN band (value ≥ price) is DELIBERATELY non-monotone (a cheap
 * featured winner can be rarer) and is NOT touched here.
 *
 * BUFFER EXEMPTION — the ONE residual-absorber card (the argmax loss weight, the
 * engine's mass sink that keeps the total at 100%) is EXEMPT from the monotone
 * chain, exactly as {@link repairSnapMonotonicity} exempts it. This is not a
 * loophole: it is the same design the whole fleet already respects (a survey of
 * every fleet plan shows 0 buffer-exempt violations — the buffer sitting above a
 * cheaper card is the intended residual layout; an ASCENDING NON-BUFFER CHAIN is
 * the actual defect). The invariant asserted here and by the plan-quality gate
 * is: no NON-BUFFER free below-price card is planned with LOWER odds than a
 * strictly-cheaper NON-BUFFER free below-price card.
 *
 * REPAIR (feasible case) — when the non-buffer chain has an inversion, project it
 * onto the monotone-non-increasing cone by a pool-adjacent-violators (PAV) sweep
 * on the value-sorted non-buffer weights (the standard isotonic regression), then
 * fold the mass delta into the BUFFER so the loss band's TOTAL MASS is preserved
 * EXACTLY (an integer re-distribution within the fixed loss-band budget). The
 * caller re-checks edge ≥ target within tolerance after applying — the loss band
 * carries the house edge, so a repair that would push edge below target is
 * treated as INFEASIBLE (see below), never silently shipped off-target.
 *
 * INFEASIBLE case — when no monotone non-buffer layout exists at the required
 * loss mass + EV (e.g. the pins force a loss mean above what any monotone
 * distribution can reach — the Divine Order pool-edit case), the repair cannot
 * hold both the invariant and the edge. `ok: false` is returned so the caller
 * flags it honestly (the pool-edit / degenerate path) instead of shipping the
 * garbage ordering.
 *
 * Pure, dep-free, integer-in / integer-out (operates on the FINAL committed
 * weight vector so it runs on EVERY path — snapped, precise-fallback, dispersed,
 * pinned, tagged). `pinnedIdx` names the owner-pinned cards, which are hard fixed
 * points excluded from the chain (they may sit anywhere the owner set them).
 * Returns `changed: false` (weights byte-identical) when the chain is already
 * monotone — so a healthy plan is never perturbed.
 */
export function enforceLossMonotone(input: {
  values: readonly number[];
  weights: readonly number[];
  price: number;
  pinnedIdx?: ReadonlySet<number>;
}): { ok: boolean; weights: number[]; changed: boolean } {
  const { values, weights, price } = input;
  const pinnedIdx = input.pinnedIdx ?? new Set<number>();
  const n = weights.length;
  const out = weights.slice();
  if (!(price > 0)) return { ok: true, weights: out, changed: false };

  // Free below-price loss cards (non-pinned, positive weight, value in (0, price)).
  const loss: { idx: number; v: number; w: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (pinnedIdx.has(i)) continue;
    const v = values[i]!;
    const w = weights[i]!;
    if (!Number.isFinite(v) || !(v > 0) || v >= price) continue;
    if (!Number.isFinite(w) || !(w > 0)) continue;
    loss.push({ idx: i, v, w });
  }
  if (loss.length < 2) return { ok: true, weights: out, changed: false };

  // Buffer = the single largest-weight loss card (the residual absorber). Ties
  // break to the CHEAPEST card so the exemption never lands on the expensive
  // tail (deterministic — mirrors the snap's argmax-then-cheapest tie-break).
  let bufPos = 0;
  for (let i = 1; i < loss.length; i++) {
    const cur = loss[i]!;
    const best = loss[bufPos]!;
    if (cur.w > best.w || (cur.w === best.w && cur.v < best.v)) bufPos = i;
  }
  const bufferIdx = loss[bufPos]!.idx;

  // The NON-BUFFER chain, sorted by value ASCENDING (cheapest first). The
  // invariant: weight non-increasing as value rises.
  const chain = loss.filter((_, i) => i !== bufPos).sort((a, b) => a.v - b.v);
  if (chain.length < 2) return { ok: true, weights: out, changed: false };

  // Already monotone? → byte-identical no-op (a healthy plan is never perturbed).
  let hasInversion = false;
  for (let k = 0; k + 1 < chain.length; k++) {
    if (chain[k]!.w < chain[k + 1]!.w - 1e-9) {
      hasInversion = true;
      break;
    }
  }
  if (!hasInversion) return { ok: true, weights: out, changed: false };

  // ── PAV (pool-adjacent-violators) isotonic projection ────────────────────
  // Force the value-ascending chain weights non-increasing by averaging adjacent
  // violating blocks. Integer-weighted PAV: each block tracks its integer sum +
  // count; the block's level is the (real) mean, but we lay INTEGER weights back
  // out so the total is preserved to the unit. This preserves total non-buffer
  // mass exactly; the buffer then absorbs any rounding delta so the WHOLE loss
  // band mass is byte-preserved.
  const blocks: { sum: number; count: number; members: number[] }[] = [];
  for (let k = 0; k < chain.length; k++) {
    blocks.push({ sum: chain[k]!.w, count: 1, members: [k] });
    // Merge while the last block's level EXCEEDS the previous (violates
    // non-increasing: a cheaper block must be ≥ a pricier one).
    while (
      blocks.length >= 2 &&
      blocks[blocks.length - 2]!.sum / blocks[blocks.length - 2]!.count <
        blocks[blocks.length - 1]!.sum / blocks[blocks.length - 1]!.count - 1e-12
    ) {
      const b = blocks.pop()!;
      const a = blocks.pop()!;
      blocks.push({
        sum: a.sum + b.sum,
        count: a.count + b.count,
        members: [...a.members, ...b.members],
      });
    }
  }

  // Lay integer weights back out: each member of a block gets floor(level); the
  // block's rounding remainder is dribbled onto its CHEAPEST members first (they
  // may carry ≥, never < a pricier sibling — keeps the chain non-increasing).
  const repairedChainW = new Array<number>(chain.length).fill(0);
  for (const b of blocks) {
    const level = b.sum / b.count;
    const base = Math.max(1, Math.floor(level));
    let rem = b.sum - base * b.count;
    // members are already value-ascending within the block (chain order).
    for (const m of b.members) repairedChainW[m] = base;
    // Dribble the positive remainder onto the cheapest members first.
    let mi = 0;
    while (rem > 0 && mi < b.members.length) {
      repairedChainW[b.members[mi]!] = repairedChainW[b.members[mi]!]! + 1;
      rem -= 1;
      mi += 1;
    }
    // A negative remainder (base·count > sum) can't happen: base = floor(level)
    // and level·count = sum, so base·count ≤ sum. The `max(1, …)` floor could
    // over-allocate only for a block whose level < 1 — guard by trimming from
    // the PRICIEST members down (keeps non-increasing) but never below 1.
    let mj = b.members.length - 1;
    while (rem < 0 && mj >= 0) {
      if (repairedChainW[b.members[mj]!]! > 1) {
        repairedChainW[b.members[mj]!] = repairedChainW[b.members[mj]!]! - 1;
        rem += 1;
      }
      mj -= 1;
      if (mj < 0 && rem < 0) break; // cannot trim below 1 — infeasible on ints
    }
    if (rem < 0) return { ok: false, weights: weights.slice(), changed: false };
  }

  // Verify the repaired chain is genuinely non-increasing in value.
  for (let k = 0; k + 1 < chain.length; k++) {
    if (repairedChainW[k]! < repairedChainW[k + 1]! - 1e-9) {
      return { ok: false, weights: weights.slice(), changed: false };
    }
  }

  // Apply the repaired chain; fold the mass delta into the buffer so the loss
  // band's TOTAL mass is preserved exactly.
  let chainDelta = 0; // new − old on the chain cards
  for (let k = 0; k < chain.length; k++) {
    chainDelta += repairedChainW[k]! - chain[k]!.w;
    out[chain[k]!.idx] = repairedChainW[k]!;
  }
  const newBuffer = out[bufferIdx]! - chainDelta;
  // The buffer must remain the argmax loss card (still the residual absorber)
  // AND stay ≥ 1. If restoring mass would push it below the chain's top weight
  // (it stops being the buffer) or below 1, the monotone layout is infeasible at
  // this mass — flag it.
  if (newBuffer < 1) return { ok: false, weights: weights.slice(), changed: false };
  const chainTop = repairedChainW[0]!; // cheapest non-buffer card (highest chain odds)
  if (newBuffer < chainTop - 1e-9) {
    // The buffer would drop below a non-buffer card — it is no longer the
    // largest, so the exemption is invalid and the layout can't stay monotone.
    return { ok: false, weights: weights.slice(), changed: false };
  }
  out[bufferIdx] = newBuffer;
  return { ok: true, weights: out, changed: true };
}

// ─── LAW M — the owner's monotone odds ladder (Retune V3) ───────────────────
//
// The owner's hard product law for every planned ladder the retune ships:
// reading the pool by card value DESCENDING, planned share may only RISE or
// stay level as value drops — win → near-miss → dust, ACROSS band boundaries
// included. A pricier card being likelier than a cheaper one (a zigzag) is
// forbidden no matter which band it sits in. Exemptions, and only these:
//   • owner-pinned cards (pins are sovereign numbers, carved out exactly);
//   • zero-share cards (cap-dropped / zero-cap rows are not rungs at all);
//   • equal-value cards (the same prize twice carries no order constraint).
// The FREE rows form ONE chain in value order (pins/zeros are skipped, not
// segment-splitters): a free row must respect every free row above it even
// when a pin sits between them.
//
// `monotoneEvWindow` answers the solver's two questions exactly:
//   1. does ANY law-abiding ladder satisfy the mass constraints (win mass,
//      near-miss floor, never-inflate caps)? — `null` when none does;
//   2. which EVs can law-abiding ladders reach? — [evMin, evMax] with witness
//      vectors realizing both extremes. The constraint set is CONVEX (chain
//      inequalities + caps + affine band masses), so the straight line between
//      the witnesses stays feasible and every EV in between is reachable —
//      `monotoneLayoutForEv` is exactly that interpolation.
//
// The window is REAL-valued: quantization to the engine's integer weight grid
// happens downstream (callers compare with tolerances ~1e-7, not exactly).

export type MonotoneEvWindow = {
  evMin: number;
  evMax: number;
  /**
   * Witness shares aligned to the CALLER's `values` order: pinned cards at
   * their pinned share, zero-cap / non-positive-value rows at 0. `minVector`
   * realizes `evMin`, `maxVector` realizes `evMax`; both satisfy every
   * constraint the window was asked for (LAW M chain, caps, win mass,
   * near-miss floor, total mass 1).
   */
  minVector: number[];
  maxVector: number[];
};

/** One forbidden zigzag: a pricier FREE card likelier than a cheaper one. */
export type MonotoneViolation = {
  /** Index (caller order) of the pricier card carrying the higher share. */
  richIdx: number;
  /** Index of the cheaper card it out-weighs (the tightest witness below). */
  poorIdx: number;
  richShare: number;
  poorShare: number;
};

/**
 * LAW M verifier: every zigzag among FREE rows (pins exempt, zero-share rows
 * exempt, equal-value rows unordered). Empty result = the ladder is lawful.
 */
export function findMonotoneViolations(args: {
  values: readonly number[];
  shares: readonly number[];
  pinnedIdx?: ReadonlySet<number>;
  /** Share tolerance below which a zigzag counts as equality. Default 1e-9. */
  tol?: number;
  /** Shares at/below this are "zero" (not a rung). Default 0. */
  zeroTol?: number;
}): MonotoneViolation[] {
  const tol = args.tol ?? 1e-9;
  const zeroTol = args.zeroTol ?? 0;
  const rows: { idx: number; v: number; s: number }[] = [];
  const n = Math.min(args.values.length, args.shares.length);
  for (let i = 0; i < n; i++) {
    if (args.pinnedIdx?.has(i)) continue;
    const v = args.values[i]!;
    const s = args.shares[i]!;
    if (!Number.isFinite(v) || !(v > 0)) continue;
    if (!Number.isFinite(s) || s <= zeroTol) continue;
    rows.push({ idx: i, v, s });
  }
  // Cheap → pricey; a pricier row may never exceed the min share of any
  // STRICTLY cheaper row. Equal values group together (no constraint inside).
  rows.sort((a, b) => a.v - b.v);
  const out: MonotoneViolation[] = [];
  let minCheaper = Infinity;
  let minCheaperIdx = -1;
  let g = 0;
  while (g < rows.length) {
    let h = g;
    while (h < rows.length && rows[h]!.v - rows[g]!.v <= 1e-9) h += 1;
    for (let i = g; i < h; i++) {
      const r = rows[i]!;
      if (r.s > minCheaper + tol) {
        out.push({
          richIdx: r.idx,
          poorIdx: minCheaperIdx,
          richShare: r.s,
          poorShare: minCheaper,
        });
      }
    }
    for (let i = g; i < h; i++) {
      if (rows[i]!.s < minCheaper) {
        minCheaper = rows[i]!.s;
        minCheaperIdx = rows[i]!.idx;
      }
    }
    g = h;
  }
  return out;
}

/**
 * The exact EV window reachable by LAW-M-monotone ladders under the retune's
 * mass constraints, with witness vectors. `null` = NO lawful ladder satisfies
 * the masses at all (e.g. the tag's win mass exceeds what the never-inflate
 * caps can carry under the chain — the "tag doesn't fit this pool" proof).
 *
 * Constraint set (over shares s aligned to `values`):
 *   • LAW M chain over free rows (see {@link findMonotoneViolations});
 *   • Σ s = 1 (pins included at their exact share);
 *   • Σ_{value ≥ price} s = `winMass` (pinned win shares count toward it);
 *   • Σ_{0.5·price ≤ value < price} s ≥ `nearMissMin` (pinned NM counts);
 *   • s_i ≤ winCaps[i] for free WIN rows (never-inflate; loss rows uncapped —
 *     caps passed for loss rows are ignored); a win row capped at ≤ 0 is
 *     excluded from the ladder entirely (share 0, LAW-M-exempt);
 *   • s_i = pinned share for pinned rows (LAW-M-exempt, sovereign).
 *
 * Mechanics (each extreme is a closed-form greedy, O(n log n) total):
 *   • effective caps = running min of `winCaps` from the CHEAP end of the win
 *     band upward — under the chain, a cap on a cheap winner bounds every
 *     pricier winner too;
 *   • max EV = the "level" water-fill of the win band (as even as the caps
 *     allow — this simultaneously has the LOOSEST cross-band boundary) + the
 *     uniform loss spread (loss mass as high up the loss ladder as the chain
 *     permits);
 *   • min EV = cheap-first win fill bounded by a boundary level β + the
 *     floor-and-dump loss layout (everything at the boundary floor, the
 *     near-miss floor topped up on the cheapest NM rows, the excess dumped on
 *     the very cheapest loss card). Both pieces are piecewise-linear in β, so
 *     the joint minimum sits on a breakpoint — evaluated over the full
 *     breakpoint set (caps, W/j concentration points, the NM-floor kink and
 *     per-j feasibility edges).
 */
export function monotoneEvWindow(args: {
  values: readonly number[];
  price: number;
  winMass: number;
  nearMissMin: number;
  winCaps?: readonly (number | null | undefined)[];
  pinnedShares?: readonly ShapeWeightsPinnedShare[] | null;
}): MonotoneEvWindow | null {
  const EPS = 1e-9;
  const { values, price } = args;
  const n = values.length;
  if (!(price > 0) || n === 0) return null;
  if (!Number.isFinite(args.winMass) || args.winMass < -EPS || args.winMass > 1 + EPS) {
    return null;
  }
  const nearMissMin = Number.isFinite(args.nearMissMin) ? Math.max(0, args.nearMissMin) : 0;

  // Pins: exact carve-outs (mass + EV), LAW-M-exempt.
  const pinShare = new Map<number, number>();
  if (args.pinnedShares) {
    for (const p of args.pinnedShares) {
      if (!Number.isInteger(p.index) || p.index < 0 || p.index >= n) return null;
      if (!Number.isFinite(p.share) || p.share <= 0) continue;
      pinShare.set(p.index, (pinShare.get(p.index) ?? 0) + p.share);
    }
  }
  let pinMass = 0;
  let pinEv = 0;
  let pinWinMass = 0;
  let pinNmMass = 0;
  for (const [idx, s] of pinShare) {
    const v = values[idx]!;
    pinMass += s;
    if (Number.isFinite(v) && v > 0) {
      pinEv += s * v;
      if (v >= price) pinWinMass += s;
      else if (v >= 0.5 * price) pinNmMass += s;
    }
  }
  if (pinMass > 1 + EPS) return null;

  // Free rows, value-DESC (stable sort keeps caller order among ties).
  type Row = { idx: number; v: number; cap: number; nm: boolean };
  const win: Row[] = [];
  const loss: Row[] = [];
  for (let i = 0; i < n; i++) {
    if (pinShare.has(i)) continue;
    const v = values[i]!;
    if (!Number.isFinite(v) || !(v > 0)) continue;
    if (v >= price) {
      const raw = args.winCaps?.[i];
      let cap = Infinity;
      if (raw !== null && raw !== undefined && Number.isFinite(raw)) cap = Math.max(0, raw);
      if (cap <= EPS) continue; // zero-cap: forced 0, not a rung
      win.push({ idx: i, v, cap, nm: false });
    } else {
      loss.push({ idx: i, v, cap: Infinity, nm: v >= 0.5 * price });
    }
  }
  win.sort((a, b) => b.v - a.v);
  loss.sort((a, b) => b.v - a.v);

  const W = args.winMass - pinWinMass; // free win mass
  const freeMass = 1 - pinMass;
  const L = freeMass - W; // free loss mass
  if (W < -EPS || L < -EPS) return null;
  if (W > EPS && win.length === 0) return null;
  if (L > EPS && loss.length === 0) return null;
  const nmNeed = Math.max(0, nearMissMin - pinNmMass);
  const nmCount = loss.reduce((a, r) => a + (r.nm ? 1 : 0), 0);
  if (nmNeed > EPS && nmCount === 0) return null;

  const m = win.length;
  const k = loss.length;
  const d = k - nmCount;

  // Effective never-inflate caps under the chain: running min from the cheap
  // end of the win band upward (non-decreasing down-ladder by construction).
  const eff = new Array<number>(m).fill(Infinity);
  {
    let run = Infinity;
    for (let j = m - 1; j >= 0; j--) {
      run = Math.min(run, win[j]!.cap);
      eff[j] = run;
    }
  }
  const capSum = eff.reduce((a, c) => a + Math.min(c, 1), 0);
  if (m > 0 && W > capSum + 1e-7) return null;

  // λ water-fill level: Σ min(eff_j, λ) = mass (the "as even as the caps
  // allow" fill — max win EV AND the loosest cross-band boundary).
  const levelFor = (mass: number): number => {
    if (m === 0 || mass <= EPS) return 0;
    const capsAsc = eff.map((c) => Math.min(c, 1)).sort((a, b) => a - b);
    let sumBelow = 0;
    for (let t = 0; t < capsAsc.length; t++) {
      const cand = (mass - sumBelow) / (capsAsc.length - t);
      if (cand <= capsAsc[t]! + 1e-15) return cand;
      sumBelow += capsAsc[t]!;
    }
    return capsAsc[capsAsc.length - 1]!;
  };
  const lambdaMin = levelFor(W);
  if (k > 0 && lambdaMin > L / k + 1e-9) return null;
  if (k === 0 && L > EPS) return null;
  if (nmNeed > EPS && k > 0 && nmNeed > nmCount * (L / k) + 1e-9) return null;

  // Win fill at level λ (max-EV extreme): s_j = min(eff_j, λ).
  const levelFill = (lambda: number): number[] => {
    const out = new Array<number>(m).fill(0);
    for (let j = 0; j < m; j++) out[j] = Math.min(eff[j]!, lambda);
    return out;
  };
  // Cheap-first win fill bounded by β (min-EV extreme for a given boundary).
  const cheapFirstFill = (mass: number, bound: number): number[] | null => {
    const out = new Array<number>(m).fill(0);
    let rem = mass;
    for (let j = m - 1; j >= 0; j--) {
      const room = Math.min(eff[j]!, bound);
      const take = Math.min(Math.max(0, room), rem);
      out[j] = take;
      rem -= take;
      if (rem <= 1e-12) {
        rem = 0;
        break;
      }
    }
    return rem > 1e-7 ? null : out;
  };
  const evOf = (rows: readonly Row[], shares: readonly number[]): number => {
    let ev = 0;
    for (let j = 0; j < rows.length; j++) ev += rows[j]!.v * shares[j]!;
    return ev;
  };

  // Min-EV loss layout for boundary floor b: everything at b, the NM floor
  // topped up on the j cheapest NM rows (dust floor rises to the NM top
  // level), excess dumped on the cheapest loss card. Exact j-scan: EV is
  // linear between structure breakpoints, so the best j wins outright.
  const lossMinLayout = (b: number): { shares: number[]; ev: number } | null => {
    if (k === 0) return L > 1e-7 ? null : { shares: [], ev: 0 };
    const floor = Math.max(0, b);
    if (k * floor > L + 1e-9) return null;
    const nmShort = Math.max(0, nmNeed - nmCount * floor);
    const build = (levels: number[]): { shares: number[]; ev: number } => {
      const shares = levels.slice();
      let used = 0;
      for (const s of shares) used += s;
      const excess = L - used;
      shares[k - 1] = shares[k - 1]! + excess;
      return { shares, ev: evOf(loss, shares) };
    };
    if (nmShort <= EPS) {
      return build(new Array<number>(k).fill(floor));
    }
    let best: { shares: number[]; ev: number } | null = null;
    for (let j = 1; j <= nmCount; j++) {
      const x = floor + nmShort / j;
      const floorsMass = k * floor + nmShort + d * (x - floor);
      if (floorsMass > L + 1e-9) continue;
      const levels = new Array<number>(k).fill(floor);
      for (let t = nmCount - j; t < nmCount; t++) levels[t] = x; // j cheapest NM rows
      for (let t = nmCount; t < k; t++) levels[t] = x; // dust floor = NM top
      const cand = build(levels);
      if (best === null || cand.ev < best.ev - 1e-12) best = cand;
    }
    return best;
  };

  // ── MAX extreme: level win fill + uniform loss ─────────────────────────
  const maxWin = levelFill(lambdaMin);
  {
    // absorb fp drift so the win mass is exact
    const sum = maxWin.reduce((a, b) => a + b, 0);
    let drift = W - sum;
    for (let j = m - 1; j >= 0 && Math.abs(drift) > 1e-15; j--) {
      const room = drift > 0 ? eff[j]! - maxWin[j]! : maxWin[j]!;
      const take = Math.sign(drift) * Math.min(Math.abs(drift), Math.max(0, room));
      maxWin[j] = maxWin[j]! + take;
      drift -= take;
    }
  }
  const maxLoss = new Array<number>(k).fill(k > 0 ? L / k : 0);

  // ── MIN extreme: joint boundary scan over the breakpoint set ──────────
  const betaHi = Math.min(m > 0 ? eff[m - 1]! : Infinity, k > 0 ? L / k : Infinity, 1);
  const betaLo = Math.min(lambdaMin, betaHi);
  const candidates = new Set<number>([betaLo, betaHi]);
  if (nmCount > 0 && nmNeed > EPS) {
    const kink = nmNeed / nmCount;
    if (kink > betaLo && kink < betaHi) candidates.add(kink);
  }
  for (const c of eff) {
    if (Number.isFinite(c) && c > betaLo && c < betaHi) candidates.add(c);
  }
  for (let j = 1; j <= m; j++) {
    const conc = W / j;
    if (conc > betaLo && conc < betaHi) candidates.add(conc);
  }
  // per-j feasibility edges of the loss layout: k·b + nmShort(b) + d·(x_j(b) − b) = L
  for (let j = 1; j <= nmCount; j++) {
    const denom = k - nmCount - (d * nmCount) / j;
    if (Math.abs(denom) > 1e-12) {
      const bj = (L - nmNeed * (1 + d / j)) / denom;
      if (bj > betaLo && bj < betaHi) candidates.add(bj);
    }
  }
  let minWin: number[] | null = null;
  let minLoss: number[] | null = null;
  let evMin = Infinity;
  for (const beta of candidates) {
    const w = m > 0 ? cheapFirstFill(W, beta) : W > EPS ? null : new Array<number>(0);
    if (w === null) continue;
    const bUsed = m > 0 && W > EPS ? w[m - 1]! : 0;
    const l = lossMinLayout(bUsed);
    if (l === null) continue;
    const ev = evOf(win, w) + l.ev;
    if (ev < evMin - 1e-12) {
      evMin = ev;
      minWin = w;
      minLoss = l.shares;
    }
  }
  if (minWin === null || minLoss === null) return null;

  // ── Assemble in caller order ───────────────────────────────────────────
  const minVector = new Array<number>(n).fill(0);
  const maxVector = new Array<number>(n).fill(0);
  for (const [idx, s] of pinShare) {
    minVector[idx] = s;
    maxVector[idx] = s;
  }
  for (let j = 0; j < m; j++) {
    minVector[win[j]!.idx] = minWin[j]!;
    maxVector[win[j]!.idx] = maxWin[j]!;
  }
  for (let j = 0; j < k; j++) {
    minVector[loss[j]!.idx] = minLoss[j]!;
    maxVector[loss[j]!.idx] = maxLoss[j]!;
  }
  const evMinTotal = evMin + pinEv;
  const evMaxTotal = evOf(win, maxWin) + evOf(loss, maxLoss) + pinEv;
  if (evMinTotal > evMaxTotal + 1e-6) return null; // defensive: never emit an inverted window
  return {
    evMin: evMinTotal,
    evMax: Math.max(evMinTotal, evMaxTotal),
    minVector,
    maxVector,
  };
}

/**
 * A lawful ladder hitting `evTarget` (clamped into the window): the straight
 * interpolation between the window's witnesses — feasible by convexity of the
 * constraint set, EV-exact by linearity.
 */
export function monotoneLayoutForEv(
  window: MonotoneEvWindow,
  evTarget: number,
): number[] {
  const span = window.evMax - window.evMin;
  const t = span > 1e-12 ? Math.min(1, Math.max(0, (evTarget - window.evMin) / span)) : 0;
  return window.minVector.map((lo, i) => lo + t * (window.maxVector[i]! - lo));
}

/**
 * The end-of-solve LAW M gate (Retune V3). Verifies the final committed
 * vector against the owner's full-ladder law; on a zigzag it re-lays the
 * ladder LAWFULLY at the SAME landed win mass / near-miss reality / EV
 * (pins exact, never inflating any winner beyond max(live, landed)); when no
 * lawful ladder can carry the landed EV at this price it reports `refuse`
 * with the lawful window so the caller can emit the typed
 * `monotone-unreachable` limit. Pure — the caller applies the outcome.
 *
 * The re-layout is quantized on the PIN grid (1e9 units — every pin with ≤ 7
 * decimal places of percent stays EXACT), keeps every row the solve kept
 * alive (a 0.0001% floor via same-band micro-transfers — no card silently
 * vanishes), and is re-verified end-to-end (law, caps, win mass, NM floor,
 * EV/edge inside the contract); any failure downgrades to `refuse` — the
 * gate NEVER ships an unverified vector.
 *
 * `evAccept` (the caller's own edge-acceptance window as an EV range) lets
 * the re-layout move WITHIN the already-accepted contract instead of
 * matching the landed EV to the cent — essential when the landed EV sits
 * exactly on the lawful window's edge (the EV-forced pools), where an
 * EV-exact re-layout would be forced to zero rows. Omitted → EV-exact.
 */
/** The LAW M layout grid: 1e9 units (every ≤7-decimal-percent pin exact). */
const LAW_M_SCALE = 1_000_000_000;
/** 0.0001% — the solver's own floor-pin fraction (keep-alive floor). */
const LAW_M_KEEP_ALIVE_UNITS = 1_000;

/**
 * Shared LAW M layout core: compute the lawful EV window at one near-miss
 * floor, pick an EV inside `[evLo, evHi]` (preferring `evPrefer`), lay the
 * witness interpolation, quantize on the pin grid (pins + win-band sum
 * exact), keep every reference-positive row alive (0.0001% same-band
 * micro-transfers, signed-drift-compensated), and fail-closed verify the
 * result. Returns the verified integer vector + risk, or the window alone
 * when no verifiable layout exists (for refusal copy), or `null` when the
 * window itself is infeasible.
 */
function lawfulLadderInWindow(args: {
  values: number[];
  price: number;
  winMass: number;
  nearMissFloor: number;
  winCaps: (number | null)[];
  pins: { index: number; share: number }[] | null;
  pinnedIdx: Set<number> | undefined;
  evLo: number;
  evHi: number;
  evPrefer: number;
  /** TRUE → bias off the high (edge-below-target) boundary + range check;
   *  FALSE → EV-exact mode (|ev − evPrefer| within quantization noise). */
  contractMode: boolean;
  /** Shares reference: rows > 0 here must stay alive in the layout. */
  keepAliveRef: readonly number[] | null;
}): { units: number[]; risk: PackRisk; window: MonotoneEvWindow } | { window: MonotoneEvWindow | null } {
  const { values, price, pinnedIdx } = args;
  const n = values.length;
  const win = monotoneEvWindow({
    values,
    price,
    winMass: args.winMass,
    nearMissMin: args.nearMissFloor,
    winCaps: args.winCaps,
    pinnedShares: args.pins,
  });
  if (win === null) return { window: null };
  let maxV = 0;
  for (const v of values) if (v > maxV) maxV = v;
  const roundSlack = Math.max(1e-6, (n * maxV) / LAW_M_SCALE);
  const lo = Math.max(win.evMin, args.evLo - 1e-6);
  let hi = Math.min(win.evMax, args.evHi + (args.contractMode ? 0 : 1e-6));
  if (lo > hi + 1e-9) return { window: win };
  if (args.contractMode) hi = Math.max(lo, hi - roundSlack);

  let evStar = Math.min(hi, Math.max(lo, args.evPrefer));
  const targetWinUnits = Math.round(args.winMass * LAW_M_SCALE);
  let bigFreeWin = -1;
  let bigFreeLoss = -1;
  const layoutAt = (ev: number): number[] => {
    const layout = monotoneLayoutForEv(win, ev);
    const u = layout.map((s) => Math.round(s * LAW_M_SCALE));
    if (args.pins) {
      for (const p of args.pins) u[p.index] = Math.round(p.share * LAW_M_SCALE);
    }
    let freeWinUnits = 0;
    let pinnedWinUnits = 0;
    bigFreeWin = -1;
    bigFreeLoss = -1;
    for (let i = 0; i < n; i++) {
      const v = values[i]!;
      if (!(v > 0)) continue;
      if (v >= price) {
        if (pinnedIdx?.has(i)) pinnedWinUnits += u[i]!;
        else {
          freeWinUnits += u[i]!;
          if (bigFreeWin < 0 || u[i]! > u[bigFreeWin]!) bigFreeWin = i;
        }
      } else if (!pinnedIdx?.has(i)) {
        if (bigFreeLoss < 0 || u[i]! > u[bigFreeLoss]!) bigFreeLoss = i;
      }
    }
    if (bigFreeWin >= 0) {
      u[bigFreeWin] = u[bigFreeWin]! + (targetWinUnits - pinnedWinUnits - freeWinUnits);
    }
    let totalUnits = 0;
    for (const x of u) totalUnits += x;
    if (bigFreeLoss >= 0) u[bigFreeLoss] = u[bigFreeLoss]! + (LAW_M_SCALE - totalUnits);
    return u;
  };
  const keepAlive = (u: number[]): number => {
    if (!args.keepAliveRef) return 0;
    let drift = 0;
    for (let i = 0; i < n; i++) {
      const v = values[i]!;
      if (!(v > 0) || pinnedIdx?.has(i)) continue;
      if (!(args.keepAliveRef[i]! > 0) || u[i]! > 0) continue;
      if (args.winCaps[i] === 0) continue; // cap-dropped stays dropped
      const donor = v >= price ? bigFreeWin : bigFreeLoss;
      if (donor < 0 || donor === i || u[donor]! <= 2 * LAW_M_KEEP_ALIVE_UNITS) continue;
      u[i] = LAW_M_KEEP_ALIVE_UNITS;
      u[donor] = u[donor]! - LAW_M_KEEP_ALIVE_UNITS;
      drift += (LAW_M_KEEP_ALIVE_UNITS / LAW_M_SCALE) * (v - values[donor]!);
    }
    return drift;
  };
  let units = layoutAt(evStar);
  const plannedDrift = keepAlive(units.slice());
  if (plannedDrift !== 0) {
    evStar = Math.min(hi, Math.max(lo, evStar - plannedDrift));
    units = layoutAt(evStar);
  }
  keepAlive(units);
  if (bigFreeLoss < 0 && units.reduce((a, b) => a + b, 0) !== LAW_M_SCALE) {
    return { window: win };
  }

  // ── Fail-closed verification of the quantized vector ────────────────────
  let ok = true;
  let qWin = 0;
  let qNm = 0;
  for (let i = 0; i < n; i++) {
    const u = units[i]!;
    if (u < 0 || !Number.isInteger(u)) {
      ok = false;
      break;
    }
    const v = values[i]!;
    if (!(v > 0)) continue;
    const cap = args.winCaps[i];
    if (v >= price) {
      qWin += u;
      if (cap !== null && u > Math.round(cap * LAW_M_SCALE) + LAW_M_KEEP_ALIVE_UNITS + 2) ok = false;
    } else if (v >= 0.5 * price) qNm += u;
  }
  if (!ok || qWin !== targetWinUnits) return { window: win };
  if (qNm < Math.round(args.nearMissFloor * LAW_M_SCALE) - 5 - LAW_M_KEEP_ALIVE_UNITS) {
    return { window: win };
  }
  const qShares = units.map((u) => u / LAW_M_SCALE);
  if (
    findMonotoneViolations({
      values,
      shares: qShares,
      pinnedIdx,
      tol: (LAW_M_KEEP_ALIVE_UNITS + 5) / LAW_M_SCALE,
    }).length > 0
  ) {
    return { window: win };
  }
  const risk = computePackRisk({
    cards: values.map((value, i) => ({ value, weight: units[i]! })),
    price,
  });
  if (args.contractMode) {
    if (risk.ev < args.evLo - 2 * roundSlack || risk.ev > args.evHi + 2 * roundSlack) {
      return { window: win };
    }
  } else if (
    Math.abs(risk.ev - args.evPrefer) >
    Math.max(1e-5 * price, 2 * roundSlack + Math.abs(plannedDrift))
  ) {
    return { window: win };
  }
  return { units, risk, window: win };
}

export function enforceMonotoneLadderLawM(input: {
  cards: { value: number }[];
  weights: readonly number[];
  price: number;
  maxWinCap?: number;
  currentWeights?: readonly number[];
  pinnedShares?: ReadonlyMap<number, number> | null;
  /** The requested near-miss floor (TOTAL, pinned NM included). */
  nearMissFloor: number;
  /** EV range the caller already accepts (edge window mapped to EV). */
  evAccept?: { min: number; max: number };
}):
  | { kind: "lawful" }
  | { kind: "relayout"; weights: number[]; risk: PackRisk }
  | {
      kind: "refuse";
      detail: string;
      suggestion: string;
      monotoneEvMin: number | null;
      monotoneEvMax: number | null;
      evTarget: number;
    } {
  const { cards, price } = input;
  const n = cards.length;
  const values = cards.map((c) => c.value);
  let total = 0;
  for (const w of input.weights) total += Number.isFinite(w) && w > 0 ? w : 0;
  if (!(total > 0) || !(price > 0)) return { kind: "lawful" };
  const shares = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const w = input.weights[i]!;
    shares[i] = Number.isFinite(w) && w > 0 ? w / total : 0;
  }
  const pinnedIdx =
    input.pinnedShares && input.pinnedShares.size > 0
      ? new Set(input.pinnedShares.keys())
      : undefined;
  const viols = findMonotoneViolations({ values, shares, pinnedIdx, tol: 1e-9 });
  if (viols.length === 0) return { kind: "lawful" };

  // ── Landed reality ──────────────────────────────────────────────────────
  let landedEv = 0;
  let winShare = 0;
  let landedNm = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    if (!(v > 0)) continue;
    landedEv += shares[i]! * v;
    if (v >= price) winShare += shares[i]!;
    else if (v >= 0.5 * price) landedNm += shares[i]!;
  }

  // Never-inflate caps for the re-layout: a winner may keep what the accepted
  // solve already gave it (flagged inflation stays legal) but may not rise
  // further; max-win-cap-dropped cards stay dropped.
  let curTotal = 0;
  if (input.currentWeights) {
    for (const w of input.currentWeights) {
      if (Number.isFinite(w) && w > 0) curTotal += w;
    }
  }
  const winCaps = new Array<number | null>(n).fill(null);
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    if (!(v > 0) || v < price) continue;
    if (pinnedIdx?.has(i)) continue;
    if (input.maxWinCap !== undefined && v > input.maxWinCap) {
      winCaps[i] = 0;
      continue;
    }
    if (curTotal > 0) {
      const live = input.currentWeights![i];
      const liveShare = Number.isFinite(live) && live! > 0 ? live! / curTotal : 0;
      winCaps[i] = Math.max(liveShare, shares[i]!);
    }
  }
  const pinsArr =
    pinnedIdx !== undefined
      ? Array.from(input.pinnedShares!.entries()).map(([index, share]) => ({ index, share }))
      : null;

  // ── Lawful re-layout inside the accepted contract ───────────────────────
  // EV target: the landed EV clamped into the caller's acceptance window
  // (when given) intersected with the lawful window — so an EV-forced pool
  // whose landed EV sits ON the window edge can still breathe enough to keep
  // every row alive without leaving the accepted edge band.
  const hasAccept = input.evAccept !== undefined;
  const aMin = hasAccept ? Math.min(input.evAccept!.min, input.evAccept!.max) : landedEv;
  const aMax = hasAccept ? Math.max(input.evAccept!.min, input.evAccept!.max) : landedEv;
  const floors = [Math.max(0, input.nearMissFloor)];
  const landedFloor = Math.min(floors[0]!, Math.max(0, landedNm - 1e-9));
  if (landedFloor < floors[0]! - 1e-12) floors.push(landedFloor);
  let lastWindow: MonotoneEvWindow | null = null;
  for (const floor of floors) {
    const laid = lawfulLadderInWindow({
      values,
      price,
      winMass: winShare,
      nearMissFloor: floor,
      winCaps,
      pins: pinsArr,
      pinnedIdx,
      evLo: aMin,
      evHi: aMax,
      evPrefer: landedEv,
      contractMode: hasAccept,
      keepAliveRef: shares,
    });
    if (laid.window !== null) lastWindow = laid.window;
    if ("units" in laid) return { kind: "relayout", weights: laid.units, risk: laid.risk };
  }

  // No lawful layout carries the landed EV at this price.
  const evTarget = landedEv;
  if (lastWindow === null) {
    return {
      kind: "refuse",
      detail: `No lawful odds ladder exists for this pool at $${price.toFixed(2)}: the win mass (${(winShare * 100).toFixed(2)}%) cannot be carried with odds only rising down the value order under the never-inflate caps.`,
      suggestion:
        "Lower the win-rate target (untag or retag the pack) or edit the pool — the tag mass exceeds what this pool's card values can pay on an honest ladder.",
      monotoneEvMin: null,
      monotoneEvMax: null,
      evTarget,
    };
  }
  return {
    kind: "refuse",
    detail: `No lawful odds ladder (odds only rising down the value order) can pay $${evTarget.toFixed(2)} per open at $${price.toFixed(2)}: lawful ladders at this win rate pay $${lastWindow.evMin.toFixed(2)}–$${lastWindow.evMax.toFixed(2)}.`,
    suggestion:
      "The designed win rate doesn't fit this pool's card values at this price — untag/retag the pack, move the price, or edit the pool so a lawful ladder can carry the target.",
    monotoneEvMin: lastWindow.evMin,
    monotoneEvMax: lastWindow.evMax,
    evTarget,
  };
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
 * Whether a probability percentage (in PERCENT units, 0..100] sits ON the
 * clean ladder — i.e. equals a {@link CLEAN_LADDER} rung up to floating-point
 * noise. Uses the SAME log10-distance metric the snap uses to pick rungs
 * (nearest-rung argmin over `|log10(rung) − log10(pct)|`), accepting only a
 * hair's width (1e-9 in log10 space ≈ 2.3e-9 relative) — tight enough that a
 * pct reconstructed from snapped integer weights (`weight / Σweight × 100`)
 * still reads true, while the snap's un-snapped buffer-card residual (or any
 * precise-fallback weight) reads false. Pure + sync — lets the retune
 * workspace flag per-card off-ladder rows (`PackTunePlan.offLadderCards`)
 * without shipping the solver to the client.
 */
export function isOnCleanLadderPct(pct: number): boolean {
  if (!Number.isFinite(pct) || !(pct > 0) || pct > 100) return false;
  const logP = Math.log10(pct);
  let bestDist = Math.abs(Math.log10(CLEAN_LADDER[0]!) - logP);
  for (let k = 1; k < CLEAN_LADDER.length; k++) {
    const d = Math.abs(Math.log10(CLEAN_LADDER[k]!) - logP);
    if (d < bestDist) bestDist = d;
  }
  return bestDist < 1e-9;
}

/**
 * Is a probability (percent units) on the TAGGED per-100k integer grid — an
 * exact integer count of 0.001% rungs? This is what "clean odds" means for a
 * tagged lottery pack (ruleset §1.2 / [fleet HOUSE LADDER]: the owner's
 * hand-tuned pools are integer weights per 100,000 — e.g. '1% 18 PLUS' win
 * band cum EXACTLY 1.0000%), where the log-ladder rungs of
 * {@link isOnCleanLadderPct} are unreachable without breaking the 0.01pp tag.
 * Tolerant of float division noise from reconstructed integer weights.
 */
export function isOnPer100kGridPct(pct: number): boolean {
  if (!Number.isFinite(pct) || !(pct > 0) || pct > 100) return false;
  const units = pct * 1000; // 0.001% rungs
  return Math.abs(units - Math.round(units)) <= 1e-6 * Math.max(1, units);
}

/**
 * HUMAN-NICE mantissas for TAGGED rungs: the {@link CLEAN_LADDER_BASE}
 * mantissa set (1/1.5/2/2.5/3/4/5/7.5) PLUS 3.5 — owner-named ("0.35%",
 * "3.5%") and absent from the log ladder. INTENTIONALLY not added to
 * `CLEAN_LADDER_BASE` itself: extending the untagged ladder would silently
 * shift every untagged snap's nearest-rung mapping and break the pinned
 * untagged goldens ("untagged targets byte-identical"). The two grids diverge
 * by exactly this one mantissa, and the divergence is tagged-only by design.
 */
const NICE_MANTISSAS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 7.5] as const;

/**
 * The tagged HUMAN-NICE rung grid, in per-100k integer units:
 * `{ b · 10^k : b ∈ NICE_MANTISSAS, k ∈ 0..5 } ∩ ℤ ∩ [1, 100000]` — the exact
 * 42-element set of the snap-niceness spec §1.1 (0.001% … 100%). Non-integer
 * combinations (1.5/2.5/3.5/7.5 at k=0) are excluded on purpose: 0.0015% is
 * not representable on the per-100k grid anyway. The round 1-in-N jackpot
 * menu ({@link JACKPOT_MENU_PER_100K}) is a strict subset of this grid
 * (1-in-100 … 1-in-100000), so the menu survives as a tie-break preference
 * inside the nice tiers — no separate grid is needed.
 */
const NICE_UNITS: readonly number[] = (() => {
  const out = new Set<number>();
  for (let k = 0; k <= 5; k++) {
    for (const b of NICE_MANTISSAS) {
      const u = b * Math.pow(10, k);
      if (Number.isInteger(u) && u >= 1 && u <= 100_000) out.add(u);
    }
  }
  return [...out].sort((a, b) => a - b);
})();

/** Module-scope membership set for {@link isOnNiceGridPct} — built once. */
const NICE_UNITS_SET: ReadonlySet<number> = new Set(NICE_UNITS);

/**
 * Human-nice tagged rung: an integer per-100k count that is also a round
 * {1,1.5,2,2.5,3,3.5,4,5,7.5}×10^k number. What the OWNER reads as clean
 * (0.05%, 0.25%, 0.35%, 2.5%, 1-in-N jackpots) — vs
 * {@link isOnPer100kGridPct}, which accepts ANY integer 0.001% count, so
 * 0.047% / 0.234% read "clean" there while a human sees dirty decimals.
 */
export function isOnNiceGridPct(pct: number): boolean {
  if (!Number.isFinite(pct) || !(pct > 0) || pct > 100) return false;
  const units = pct * 1000;
  const u = Math.round(units);
  if (Math.abs(units - u) > 1e-6 * Math.max(1, units)) return false;
  return NICE_UNITS_SET.has(u);
}

/**
 * Count the planned cards OFF the human-nice grid: positive-weight cards,
 * minus the exempt indexes (dust buffer / owner pins / forced single free
 * winner), whose probability fails {@link isOnNiceGridPct}. THE shared
 * definition — the tagged snap's `allNice`, the price search's niceness tier
 * and the plan projection's tagged `offLadderCards` all count with this one
 * grid so they can never disagree.
 */
export function countOffNicePct(
  weights: readonly number[],
  niceExemptIdx?: readonly number[] | null,
): number {
  let total = 0;
  for (const w of weights) if (Number.isFinite(w) && w > 0) total += w;
  if (!(total > 0)) return 0;
  const exempt = new Set(niceExemptIdx ?? []);
  let off = 0;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]!;
    if (!(w > 0) || exempt.has(i)) continue;
    if (!isOnNiceGridPct((w / total) * 100)) off += 1;
  }
  return off;
}

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
  /**
   * Optional LIVE weights aligned to `weights` (owner-lens Pattern 11 — dust
   * tie-break). When two cards tie for the argmax buffer pct (the modal card
   * that absorbs the residual — e.g. two equal-value dust cards the water-fill
   * split evenly), the tie is broken toward the card whose LIVE weight is
   * larger, so the card that was modal in the live pool stays modal instead of
   * flipping to a sibling by array index. Pure tie-break: changes only WHICH of
   * two equal-pct cards is the buffer — never the group total, EV, edge,
   * win-rate, or cleanness. Omit for the legacy index-order tie-break.
   */
  tieBreakWeights?: readonly number[] | null;
}): { weights: number[]; edgeDelta: number } {
  const original = input.weights;
  const price = input.price;
  const tieBreak = input.tieBreakWeights ?? null;

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
  const tieBreakOf = (i: number): number => {
    if (tieBreak === null) return -Infinity;
    const t = tieBreak[i];
    return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : -Infinity;
  };
  for (let i = 0; i < original.length; i++) {
    const w = original[i]!;
    if (!Number.isFinite(w) || w <= 0) continue;
    const p = (w / totalWeight) * 100;
    pcts[i] = p;
    if (p > bufferPct) {
      bufferPct = p;
      bufferIdx = i;
    } else if (
      // Pattern 11 dust tie-break: an argmax TIE (equal buffer pct, e.g. two
      // equal-value cards the water-fill split evenly) resolves toward the
      // higher LIVE weight, so the modal live card stays the buffer instead of
      // flipping by array index. Pure — never changes the group total, EV,
      // edge, win-rate, or cleanness.
      bufferIdx >= 0 &&
      Math.abs(p - bufferPct) <= 1e-9 &&
      tieBreakOf(i) > tieBreakOf(bufferIdx)
    ) {
      bufferIdx = i;
      bufferPct = p;
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
 * Buffer-card rung polish (RC5c). A successful buffer-residual snap leaves
 * exactly ONE off-ladder card: the buffer (argmax mass — typically the
 * dominant dust card), which is also the FIRST number a human reads on the
 * pack page. This post-step tries to move the buffer onto its log-nearest
 * ladder rung too, spreading the (small) residual over the 2–3 largest-mass
 * OTHER dust cards — the least visible numbers on the pack — so the headline
 * card reads clean.
 *
 * Pure. Returns the polished `{weights, risk}` or `null` when the polish is
 * not applicable (no other dust card to host the residual, buffer already on
 * a rung, degenerate masses) or when `accept` rejects the candidate. The
 * CALLER passes `accept` carrying its full acceptance stack (edge window +
 * one-sided-up, win-rate / tag accuracy, grail-not-inflated) so a polish can
 * NEVER be adopted under weaker conditions than the snap itself — and a
 * `null` simply keeps the already-accepted snap: no regression possible.
 *
 * The dust-band monotonicity invariant (within-band: more expensive ⇒ never
 * more likely, buffer exempt — same rule `repairSnapMonotonicity` enforces)
 * is re-verified here on the adjusted dust pcts, because the residual spread
 * moves receivers OFF their rungs and could otherwise invert a pair.
 */
function trySnapBufferToRung(input: {
  weights: number[];
  values: number[];
  price: number;
  accept: (risk: PackRisk, weights: number[]) => boolean;
}): { weights: number[]; risk: PackRisk } | null {
  const { weights, values, price, accept } = input;
  const n = weights.length;
  if (!(price > 0) || n === 0) return null;

  let totalWeight = 0;
  for (const w of weights) {
    if (Number.isFinite(w) && w > 0) totalWeight += w;
  }
  if (!(totalWeight > 0)) return null;

  const nearestRung = (pct: number): number => {
    const logP = Math.log10(pct);
    let best = 0;
    let bestDist = Math.abs(Math.log10(CLEAN_LADDER[0]!) - logP);
    for (let k = 1; k < CLEAN_LADDER.length; k++) {
      const d = Math.abs(Math.log10(CLEAN_LADDER[k]!) - logP);
      if (d < bestDist) {
        bestDist = d;
        best = k;
      }
    }
    return CLEAN_LADDER[best]!;
  };

  // Buffer = argmax mass; every OTHER positive slot is on a rung (the caller
  // only invokes this on an ACCEPTED snap), so reconstruct the exact clean pct
  // vector by re-snapping each non-buffer slot to its rung — this strips the
  // ±1-integer-weight rounding noise instead of compounding it.
  let bufferIdx = -1;
  let bufferRaw = -Infinity;
  for (let i = 0; i < n; i++) {
    const w = weights[i]!;
    if (!Number.isFinite(w) || w <= 0) continue;
    const p = (w / totalWeight) * 100;
    if (p > bufferRaw) {
      bufferRaw = p;
      bufferIdx = i;
    }
  }
  if (bufferIdx < 0) return null;

  const pcts = new Array<number>(n).fill(0);
  let nonBufferSum = 0;
  for (let i = 0; i < n; i++) {
    if (i === bufferIdx) continue;
    const w = weights[i]!;
    if (!Number.isFinite(w) || w <= 0) continue;
    pcts[i] = nearestRung((w / totalWeight) * 100);
    nonBufferSum += pcts[i]!;
  }
  const bufferPct = 100 - nonBufferSum;
  if (!(bufferPct > 0)) return null;

  const bufferRung = nearestRung(bufferPct);
  const residual = bufferPct - bufferRung;
  // Already exactly on a rung — nothing to polish.
  if (residual === 0) return null;

  // Residual receivers: the largest-mass OTHER dust cards (up to 3).
  const receivers: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === bufferIdx) continue;
    if (!(pcts[i]! > 0)) continue;
    const v = values[i]!;
    if (!Number.isFinite(v) || !(v > 0) || v >= 0.5 * price) continue;
    receivers.push(i);
  }
  receivers.sort((a, b) => pcts[b]! - pcts[a]!);
  receivers.length = Math.min(receivers.length, 3);
  if (receivers.length === 0) return null;

  let receiverSum = 0;
  for (const i of receivers) receiverSum += pcts[i]!;
  if (!(receiverSum > 0)) return null;
  for (const i of receivers) {
    const next = pcts[i]! + residual * (pcts[i]! / receiverSum);
    if (!(next > 0)) return null;
    pcts[i] = next;
  }
  pcts[bufferIdx] = bufferRung;

  // Dust-band monotonicity re-check (non-buffer slots): more expensive dust
  // must never be MORE likely than cheaper dust.
  const dustIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === bufferIdx) continue;
    if (!(pcts[i]! > 0)) continue;
    const v = values[i]!;
    if (Number.isFinite(v) && v > 0 && v < 0.5 * price) dustIdx.push(i);
  }
  dustIdx.sort((a, b) => values[b]! - values[a]!); // most-expensive first
  for (let k = 0; k + 1 < dustIdx.length; k++) {
    if (pcts[dustIdx[k]!]! > pcts[dustIdx[k + 1]!]! + 1e-9) return null;
  }

  // Rebuild integer weights (same ×10000 scheme as the snap) + score.
  const MULT = 10000;
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const w = weights[i]!;
    if (!Number.isFinite(w) || w <= 0) continue;
    out[i] = Math.max(1, Math.round(pcts[i]! * MULT));
  }
  const risk = computePackRisk({
    cards: values.map((v, i) => ({ value: v, weight: out[i]! })),
    price,
  });
  if (!accept(risk, out)) return null;
  return { weights: out, risk };
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
  /**
   * TAGGED snap mode (RC5b): when set, a combo is only acceptable if its
   * resulting WIN-band mass (the snapped win-rate) stays within
   * {@link TAGGED_WINRATE_TOLERANCE} (0.01pp) of this tag. Passed by hard-tag
   * runs whose PRECISE solve landed on the tag, so the snap can never trade
   * the tag away for clean rungs (pre-fix: clean odds and tag accuracy were
   * mutually exclusive — the snap only checked win-rate vs the precise result
   * at the soft ±2pp).
   */
  taggedWinRate?: number;
}): { weights: number[]; edge: number; winRate: number } | null {
  const { weights: original, values, price, targetEdge } = input;
  const tolerance = input.tolerance ?? 0.0005;
  const searchTop = input.searchTop ?? 5;
  const searchRadius = input.searchRadius ?? 1;
  const preciseWinRate = input.preciseWinRate;
  const winRateTol = input.winRateTol ?? 0.02;
  const taggedWinRate = input.taggedWinRate;

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
    // RC5b — tagged mode: the snapped WIN-band mass must hold the tag.
    const tagOk =
      taggedWinRate === undefined ||
      Math.abs(risk.winRate - taggedWinRate) <= TAGGED_WINRATE_TOLERANCE + 1e-12;
    if (edgeOk && winRateOk && tagOk && drift < bestDrift) {
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

// ─── Tagged per-100k house-ladder snap (ruleset §1.2 / CLEAN-XOR-TAG fix) ────
//
// The generic clean-ladder snap NEVER passed in tagged mode (fleet: 0/8 — the
// 0.01pp tag gate outranks ladder rungs, so "clean odds" and "tag-accurate"
// were mutually exclusive and every tagged retune shipped dirty precise
// weights). The house's own hand-tuned ladder shows what "clean" means for a
// lottery pack ('1% 18 PLUS' verbatim): INTEGER weights per 100,000 (0.001%
// rungs), the win band summing to EXACTLY tag·100,000, ONE dust card absorbing
// the residual, and the jackpot on a round 1-in-N ticket count. This snap
// targets that ladder DIRECTLY: the tag is held exactly by construction
// (win-band integer sum = round(t·100000)), the dust buffer eats all rounding,
// and the edge is landed inside the acceptance window by an analytic integer
// transfer within the dust band.

/**
 * Round 1-in-N jackpot menu expressed in per-100k weight units (ruleset §1.2:
 * all 147 rain.gg lottery top odds are round ticket counts — 1-in-2000 /
 * 1-in-1000 / 1-in-10000 dominate). 1-in-100 → 1000 units … 1-in-100000 → 1
 * unit (finer rungs are unrepresentable on the per-100k grid).
 */
const JACKPOT_MENU_PER_100K: readonly number[] = [
  1000, 500, 250, 200, 150, 100, 50, 25, 20, 10, 5, 2, 1,
];

/**
 * Per-snap ceiling on the all-nice DFS (tiers N + P share it). Sized (measured,
 * live-anchored fleet sweep 2026-07) so the WINNING all-nice snap of every fleet
 * pack AND every spec fixture (Lucky Pond F1/F2 all-nice pairs, the Chaos wide-
 * probe deep cut) is found within it, while a NON-winning snap gives up here
 * instead of grinding the old 400k. Lowering 400k → 120k made each candidate ~3×
 * cheaper (the waste was non-winning prices exploring the full old cap) with ZERO
 * fixture regressions. A single snap that hits this cap keeps its best-so-far
 * candidate and degrades N → P → G — never grinds. (Was the inline
 * `NODE_CAP = 400_000`.)
 */
const TAGGED_SNAP_NODE_CAP = 120_000;

/**
 * PLAN-WIDE all-nice DFS node budget (perf-incident fix, 2026-07), PER UNIT of
 * requested price band. The actual per-plan budget is this × `maxPriceChangePct`
 * — see {@link tagggedPlanNodeBudget}. Shared across EVERY snap the tagged price
 * search runs for one plan; this — not the per-snap cap — is what bounds a plan's
 * total DFS work.
 *
 * THE INCIDENT: a lottery pack with many win cards used to run the tagged price
 * search at 320 candidate prices, EACH free to spend the full 400k per-snap cap
 * (≈128M nodes ⇒ multi-second plans that, a few concurrent, exhausted the MAIN
 * max:3 pool and timed out the WHOLE admin — the pool-stampede cascade). With the
 * shared budget the WHOLE plan's DFS is capped; once spent, remaining candidates
 * snap via P/G (tag-exact, DFS-free) and only give up round numbers.
 *
 * WHY PER-BAND (not a flat constant): the concurrent-load path is the DEFAULT
 * ±10% retune ({@link RETUNE_PRICE_BUDGET_DEFAULT_PCT}) — that is what stampedes
 * the pool and MUST be tightly bounded (measured: 25M × 0.1 = 2.5M nodes ⇒ fleet
 * max ~0.85s pure, 0 packs > 1.5s). The full ±60% band
 * ({@link RETUNE_MAX_PRICE_CHANGE_PCT}) is only the MANUAL, single-pack SUGGESTION
 * wide-probe (never runs concurrently across the fleet), so it earns a
 * proportionally larger budget (25M × 0.6 = 15M nodes) that lets its deep all-nice
 * / deep-crush search complete — keeping the spec + plan-quality wide-probe
 * fixtures (Lucky Pond F2 +71¢ all-nice, Chaos ±60% → $1.84) green. Tying the
 * compute budget to the search space the CALLER asked for is the principled knob:
 * a narrow band searches a small space fast; a wide manual probe is allowed to
 * work harder because it is rare and not on the stampede path.
 *
 * Deterministic (node count, not wall-clock — reproducible across runs/machines).
 */
const TAGGED_PLAN_NODE_BUDGET_PER_UNIT_BAND = 25_000_000;

/** Floor so a tiny requested band still admits at least one full all-nice snap. */
const TAGGED_PLAN_NODE_BUDGET_FLOOR = 1_000_000;

/**
 * The per-plan tagged-snap DFS node budget for a requested price band
 * (`maxPriceChangePct`, e.g. 0.1 for the ±10% default). Proportional to the band
 * with a floor — see {@link TAGGED_PLAN_NODE_BUDGET_PER_UNIT_BAND}. Exported so
 * the `plan-quality.ts` permanent perf gate can assert every fleet pack's
 * `snapNodesSpent` stays within it (the incident bound) and pin the constant.
 */
export function taggedPlanNodeBudget(maxPriceChangePct: number): number {
  const band = Number.isFinite(maxPriceChangePct) && maxPriceChangePct > 0
    ? maxPriceChangePct
    : RETUNE_PRICE_BUDGET_DEFAULT_PCT;
  return Math.max(
    TAGGED_PLAN_NODE_BUDGET_FLOOR,
    Math.round(TAGGED_PLAN_NODE_BUDGET_PER_UNIT_BAND * band),
  );
}

/**
 * Mutable shared DFS-node budget for ONE plan's tagged price search. `remaining`
 * is decremented by each snap by the nodes it actually spent; when it reaches 0
 * later snaps degrade to the DFS-free P/G tiers. Created by
 * {@link searchBestPriceForCleanSnap} in tagged mode; threaded through
 * {@link shapeWeights} into {@link snapTaggedPer100k}.
 */
export type SnapNodeBudget = { remaining: number };

/**
 * NICE-GRID POST-PASS (Retune V3 wave 7 — the dust-chain nice-grid item):
 * polish an ACCEPTED tier-G tagged snap vector onto the human-nice grid
 * ({@link NICE_UNITS}) one lawful move at a time. Pure + deterministic.
 *
 * WHY: when the all-nice DFS (tiers N/P) fails or the plan-wide node budget
 * is exhausted, tier G ships a per-100k-EXACT copy of the precise vector —
 * tag-exact and inside the edge window, but its decimals are whatever the
 * dispersal/flatten physics produced (38.279% dust, 0.115% grail). Fleet
 * measurement (2026-07-09, 37 tagged lottery packs): 25 land snapped-but-
 * off-nice, 20 of them with the DFS budget exhausted. This post-pass removes
 * the off-nice flag card by card WITHOUT re-running any enumeration.
 *
 * THE MOVES (three families, all mass-conserving by construction):
 *   • DUST single (value < price/2, not the buffer): re-rung to a bracketing
 *     nice rung; the residual BUFFER absorbs the delta (dust↔dust — the win
 *     band and the near-miss band are untouched).
 *   • WIN/GRAIL single (value ≥ price, not the jackpot, not the cheapest free
 *     winner): re-rung to a bracketing nice rung; the CHEAPEST FREE WINNER
 *     absorbs the delta (the same anti-jackpot absorber tier G's win-sum
 *     landing already uses), so the win-band unit sum — the exact tag — is
 *     preserved to the unit. Only strictly improving: when the absorber sat
 *     ON a nice rung (tier G's win-sum landing often leaves it there, e.g.
 *     2.000%), any delta would pollute it and the move is refused — which is
 *     exactly what the pair family exists for.
 *   • WIN/GRAIL EXACT-CANCEL PAIR: two off-nice win cards re-rung in ONE
 *     step with deltas that cancel to zero (Σdelta = 0), so the win sum — and
 *     the nice absorber — are untouched entirely. Fleet-measured to be the
 *     dominant fix (grail neighbors like 0.170%/0.180% pair to 0.150%/0.200%
 *     with a tiny EV shift); distant-value pairs move EV more and the edge
 *     window refuses them honestly.
 *
 * NEVER MOVED: pins (owner-sovereign), the buffer and the cheapest free
 * winner (they ARE the compensators), the jackpot (its 1-in-N menu landing is
 * deliberate styling — and the menu is a strict subset of the nice grid, so a
 * menu-picked jackpot is already nice), and EVERY near-miss card — the
 * near-miss mass stays byte-identical so the LAW M gate's near-miss floor
 * (`lawfulSnapCandidate`) sees exactly the reality it already accepted.
 *
 * PER-MOVE ACCEPTANCE (re-verified move by move — the polish PROPOSES, the
 * existing laws DISPOSE):
 *   • every touched card keeps ≥ 1 unit,
 *   • the win+grail ladder stays monotone (odds non-increasing in value,
 *     pinned winners interleaved as immovable fixed points),
 *   • LAW M ({@link findMonotoneViolations}, pins exempt) never gains a
 *     violation over the input vector (normally 0 → stays 0),
 *   • edge stays inside [targetEdge, targetEdge + edgeTolAbove],
 *   • the win-rate stays within {@link TAGGED_WINRATE_TOLERANCE} of the tag,
 *   • never-inflate on the LIVE basis (`liveCapUnits`, the N/P-tier
 *     semantics): an UP-rung on a non-absorber win/grail card is allowed only
 *     up to its CURRENT advertised odds; the cheapest free winner — the
 *     anti-jackpot absorber — stays exempt, exactly as tiers N and P treat
 *     it. Tier G's own `grailGuard` (precise-based) is deliberately NOT the
 *     polish's guard: tier G ships a COPY of the precise vector, so under
 *     that guard every grail would be frozen down-only and the absorber
 *     (grail on most lottery pools) could absorb nothing — the same
 *     round-number-ask ban the nice tiers already reject (their header:
 *     capping nice rungs at the intermediate precise vector would make the
 *     owner's own round-number ask impossible; house safety is preserved by
 *     the unchanged edge window),
 *   • the plan-wide off-nice count STRICTLY DECREASES (a move that merely
 *     shuffles ugliness is refused).
 *
 * Deterministic order: DUST movers first (their EV-per-unit is tiny, so they
 * bank cosmetic wins with minimal edge-window pressure), then WIN/GRAIL;
 * within a family descending units, ties by ascending index. Per mover the
 * log-nearest bracketing rung is tried first, then the other bracket. Up to
 * `maxPasses` (default 3) full passes or until nothing improves. Bounded
 * small: O(passes · movers · n log n) integer arithmetic — no DFS, no node
 * budget interaction (`snapNodesSpent` is unaffected by design).
 *
 * Returns the improved unit vector, or the input verbatim (copied) when no
 * lawful improving move exists. Total mass and the win-band sum are invariant
 * by construction — the caller re-derives risk/`allNice` from the result.
 */
export function polishTaggedNiceGrid(input: {
  units: readonly number[];
  values: readonly number[];
  price: number;
  tag: number;
  targetEdge: number;
  /** Acceptance ceiling above target (same window the snap accepted with). */
  edgeTolAbove: number;
  /** Total-weight grid (default 100,000; pinned solves pass the PIN grid). */
  scale?: number;
  /** The residual dust buffer index (niceness-exempt, absorbs dust deltas). */
  buffer: number;
  /** Accounting exemptions (buffer + pins + forced single free winner). */
  exemptIdx: readonly number[];
  /** Owner-pinned slots — never moved, LAW-M-exempt, never compensators. */
  pinnedIdx?: ReadonlySet<number>;
  /**
   * Live anchor caps in `scale` units (the N/P never-inflate basis): UP-rungs
   * on non-absorber win/grail cards stay ≤ cap. `Infinity`/absent = uncapped;
   * `null` = no anchor (legacy value-only path — no inflation guard, matching
   * every tier).
   */
  liveCapUnits?: readonly number[] | null;
  maxPasses?: number;
}): number[] {
  const { values, price, tag, targetEdge, edgeTolAbove, buffer } = input;
  const n = values.length;
  const SCALE = input.scale ?? 100_000;
  const RUNG = SCALE / 100_000;
  if (!Number.isInteger(RUNG) || RUNG < 1) return input.units.slice();
  const exempt = new Set(input.exemptIdx);
  const pinned = input.pinnedIdx ?? new Set<number>();
  const rungs: number[] = NICE_UNITS.map((r) => r * RUNG);
  const caps = input.liveCapUnits ?? null;
  const capOf = (i: number): number => {
    if (caps === null) return Infinity;
    const c = caps[i];
    return c === undefined || !Number.isFinite(c) ? Infinity : c;
  };

  let current = input.units.slice();
  let currentOff = countOffNicePct(current, input.exemptIdx);
  if (currentOff === 0) return current;

  const lawViol = (u: readonly number[]): number =>
    findMonotoneViolations({
      values,
      shares: u.map((x) => x / SCALE),
      pinnedIdx: pinned.size > 0 ? pinned : undefined,
      tol: 1e-9,
    }).length;
  const baselineViol = lawViol(current);
  const riskOf = (u: readonly number[]): PackRisk =>
    computePackRisk({
      cards: values.map((v, i) => ({ value: v, weight: u[i]! })),
      price,
    });
  const eLo = targetEdge - 1e-9;
  const eHi = targetEdge + edgeTolAbove + 1e-9;

  // Win ladder geometry: FREE winners value-DESC (stable ties by index) plus
  // the FULL chain with pinned winners interleaved as fixed points.
  const freeWin: number[] = [];
  const fullWin: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!(current[i]! > 0) || !(values[i]! > 0)) continue;
    if (values[i]! < price) continue;
    fullWin.push(i);
    if (!pinned.has(i)) freeWin.push(i);
  }
  fullWin.sort((a, b) => values[b]! - values[a]!);
  freeWin.sort((a, b) => values[b]! - values[a]!);
  const jack = freeWin.length > 0 ? freeWin[0]! : -1;
  const cheapestFree = freeWin.length > 0 ? freeWin[freeWin.length - 1]! : -1;

  const winChainMonotone = (u: readonly number[]): boolean => {
    let prev = 0;
    for (const i of fullWin) {
      if (u[i]! < prev) return false;
      prev = u[i]!;
    }
    return true;
  };

  const isNiceUnits = (x: number): boolean =>
    x % RUNG === 0 && NICE_UNITS_SET.has(x / RUNG);

  // Bracketing nice rungs around x, log-nearest first (ties → the lower rung,
  // matching the nice tiers' nearest-rung convention).
  const bracketRungs = (x: number): number[] => {
    let lower = -1;
    let upper = -1;
    for (const r of rungs) {
      if (r < x) lower = r;
      else if (r > x) {
        upper = r;
        break;
      }
    }
    if (lower === -1 && upper === -1) return [];
    if (lower === -1) return [upper];
    if (upper === -1) return [lower];
    const dLo = Math.abs(Math.log(lower / x));
    const dHi = Math.abs(Math.log(upper / x));
    return dLo <= dHi ? [lower, upper] : [upper, lower];
  };

  const maxPasses = input.maxPasses ?? 3;
  for (let pass = 0; pass < maxPasses; pass++) {
    const movers: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!(current[i]! > 0) || !(values[i]! > 0)) continue;
      if (exempt.has(i) || pinned.has(i) || i === buffer) continue;
      if (isNiceUnits(current[i]!)) continue;
      const v = values[i]!;
      if (v >= price) {
        if (i === jack || i === cheapestFree) continue;
        movers.push(i);
      } else if (v < 0.5 * price) {
        movers.push(i);
      }
      // Near-miss band (price/2 ≤ v < price): never moved — see the header.
    }
    movers.sort((a, b) => {
      const fa = values[a]! < 0.5 * price ? 0 : 1;
      const fb = values[b]! < 0.5 * price ? 0 : 1;
      if (fa !== fb) return fa - fb;
      if (current[b]! !== current[a]!) return current[b]! - current[a]!;
      return a - b;
    });
    // The shared per-candidate acceptance: laws first (cheap integer checks),
    // then the real risk math, then the strict-improvement gate. When a move
    // pushes the edge out of the window, the SAME analytic integer dust
    // transfer tier G's landing uses (EV is linear in a mass shift between
    // the free dust value-extremes; total + win band unchanged) tries to pull
    // it back in — the transfer endpoints' niceness is not protected, the
    // strict plan-wide gate decides honestly.
    const tryAdopt = (proposal: number[]): boolean => {
      const next = proposal;
      if (!winChainMonotone(next)) return false;
      let r = riskOf(next);
      if (r.edge < eLo || r.edge > eHi) {
        const freeDust: number[] = [];
        for (let k = 0; k < n; k++) {
          if (!(next[k]! > 0) || !(values[k]! > 0)) continue;
          if (pinned.has(k)) continue;
          if (values[k]! < 0.5 * price) freeDust.push(k);
        }
        if (freeDust.length < 2) return false;
        freeDust.sort((a, b) => values[a]! - values[b]!);
        const lo = freeDust[0]!;
        const hi = freeDust[freeDust.length - 1]!;
        const spread = values[hi]! - values[lo]!;
        if (!(spread > 0)) return false;
        const evHiBound = price * (1 - targetEdge);
        const evLoBound = price * (1 - targetEdge - edgeTolAbove);
        const xMin = Math.ceil(((r.ev - evHiBound) * SCALE) / spread - 1e-9);
        const xMax = Math.floor(((r.ev - evLoBound) * SCALE) / spread + 1e-9);
        const a = Math.max(xMin, -(next[lo]! - 1));
        const b = Math.min(xMax, next[hi]! - 1);
        if (a > b) return false;
        let x = a <= 0 && 0 <= b ? 0 : Math.abs(a) < Math.abs(b) ? a : b;
        if (x !== 0 && RUNG > 1) {
          x = x > 0 ? Math.ceil(a / RUNG) * RUNG : Math.floor(b / RUNG) * RUNG;
          if (x < a || x > b) return false;
        }
        if (x === 0) return false;
        next[lo] = next[lo]! + x;
        next[hi] = next[hi]! - x;
        r = riskOf(next);
        if (r.edge < eLo || r.edge > eHi) return false;
      }
      if (lawViol(next) > baselineViol) return false;
      if (Math.abs(r.winRate - tag) > TAGGED_WINRATE_TOLERANCE + 1e-12) {
        return false;
      }
      const nextOff = countOffNicePct(next, input.exemptIdx);
      if (nextOff >= currentOff) return false;
      current = next;
      currentOff = nextOff;
      return true;
    };
    // Never-inflate on the LIVE basis for a mover's UP-rung (win/grail only;
    // the absorber is exempt by the N/P rule and is never a mover anyway).
    const rungAllowed = (i: number, rung: number): boolean => {
      if (rung <= current[i]!) return true;
      if (values[i]! < price) return true; // loss side: edge window guards
      return rung <= capOf(i) + 1e-9;
    };

    let improved = false;
    for (const i of movers) {
      if (isNiceUnits(current[i]!)) continue;
      const isWin = values[i]! >= price;
      const comp = isWin ? cheapestFree : buffer;
      if (comp === -1 || comp === i || pinned.has(comp)) continue;
      let moved = false;
      for (const rung of bracketRungs(current[i]!)) {
        const delta = rung - current[i]!;
        if (delta === 0) continue;
        if (!rungAllowed(i, rung)) continue;
        const compNext = current[comp]! - delta;
        if (compNext < 1) continue;
        const next = current.slice();
        next[i] = rung;
        next[comp] = compNext;
        if (tryAdopt(next)) {
          moved = true;
          improved = true;
          break;
        }
      }
      if (moved && currentOff === 0) break;
    }
    // WIN/GRAIL pairs: the single-move family often can't touch a win card —
    // the absorber may sit ON a nice rung (tier G's win-sum landing leaves it
    // there) so a lone delta would pollute it, and on all-grail pools every
    // mover is down-only (live caps) so no single direction helps. A PAIR
    // re-rungs two off-nice win cards in one step; the absorber takes only
    // the pair's residual (zero for exact-cancel pairs), and the strict
    // plan-wide gate (−2 movers, ≤ +1 absorber) decides honestly.
    // Deterministic: movers-order outer/inner, log-nearest rung combos first.
    if (currentOff > 0) {
      const winMovers = movers.filter(
        (i) =>
          values[i]! >= price &&
          !isNiceUnits(current[i]!) &&
          i !== jack &&
          i !== cheapestFree,
      );
      for (const i of winMovers) {
        if (isNiceUnits(current[i]!)) continue;
        let moved = false;
        for (const j of winMovers) {
          if (j === i || isNiceUnits(current[j]!)) continue;
          for (const rungI of bracketRungs(current[i]!)) {
            const deltaI = rungI - current[i]!;
            if (deltaI === 0 || !rungAllowed(i, rungI)) continue;
            for (const rungJ of bracketRungs(current[j]!)) {
              const deltaJ = rungJ - current[j]!;
              if (deltaJ === 0 || !rungAllowed(j, rungJ)) continue;
              if (cheapestFree === -1) continue;
              const compNext = current[cheapestFree]! - (deltaI + deltaJ);
              if (compNext < 1) continue;
              const next = current.slice();
              next[i] = rungI;
              next[j] = rungJ;
              next[cheapestFree] = compNext;
              if (tryAdopt(next)) {
                moved = true;
                improved = true;
                break;
              }
            }
            if (moved) break;
          }
          if (moved) break;
        }
        if (currentOff === 0) break;
      }
    }
    if (!improved || currentOff === 0) break;
  }
  return current;
}

/**
 * Snap a HARD-TAGGED solve onto the per-100k integer house ladder. Pure.
 * Returns the snapped weights + risk, or `null` when the ladder can't hold the
 * acceptance stack (caller falls back to the generic snap → precise weights).
 *
 * THREE-TIER search (snap-niceness spec §2) — first tier that produces an
 * accepted vector wins:
 *   • Tier N — ALL-NICE: bounded DFS placing every FREE win card on a
 *     HUMAN-NICE rung ({@link NICE_UNITS}: 0.05% / 0.25% / 0.35% / 2.5% …),
 *     win-band unit sum EXACTLY `W = round(tag·SCALE)`, monotone across the
 *     FULL ladder (pins interleaved as immovable fixed points), live-basis
 *     never-inflate caps (`liveCapUnits`; the cheapest FREE winner — the
 *     anti-jackpot absorber — is exempt), NM + non-buffer dust on nice rungs
 *     with the largest non-buffer dust rung ENUMERATED (EV freedom), buffer =
 *     exact residual, edge window unchanged. No dust transfer here — the
 *     price sweep supplies that freedom.
 *   • Tier P — PARTIALLY-NICE: same DFS excluding the cheapest FREE winner,
 *     which absorbs `W − Σothers` (any integer); the shipped analytic dust
 *     transfer lands the edge window when the as-is vector misses it.
 *   • Tier G — the shipped per-100k grid snap, byte-identical (nearest-rung
 *     rounding, 1-in-N jackpot down-rounding, cheapest-winner win-sum
 *     adjustment, buffer residual, dust transfer, `grailGuard` vs precise).
 *
 * Guarantees on success (all tiers):
 *   • total weight EXACTLY `SCALE` (every pct is an integer count of rungs),
 *   • win-band (value ≥ price) weight EXACTLY `round(tag·SCALE)`,
 *   • win+grail ladder odds non-increasing in card value,
 *   • ONE FREE dust card (the largest-mass one) carries the residual buffer,
 *   • edge ∈ [targetEdge, targetEdge + edgeTolAbove],
 *   • pins verbatim (never rounded / transferred / buffered / capped),
 *   • `grailGuard` (precise-based anti-inflation) holds on tier G; tiers N/P
 *     enforce the live-cap constraint instead (the owner rule is "never above
 *     CURRENT advertised odds" — capping nice rungs at the intermediate
 *     precise vector would make the owner's own round-number ask impossible;
 *     house safety is preserved by the unchanged edge window).
 *
 * `allNice` reports whether every non-exempt card landed on the nice grid
 * (computed honestly on the final vector, whatever tier produced it);
 * `niceExemptIdx` lists the ACCOUNTING-exempt indexes (buffer, pins, the
 * forced single free winner — the P/G absorber is construction-exempt but
 * counts, since the owner reads its odds too).
 *
 * PLAN-WIDE NODE BUDGET (perf-incident fix): the all-nice DFS (tiers N/P) is a
 * combinatorial rung enumeration whose per-snap ceiling is {@link TAGGED_SNAP_NODE_CAP}
 * nodes. When the tagged price search runs this snap at HUNDREDS of candidate
 * prices (lottery packs with many win cards), the sum of those per-snap caps is
 * the incident — a plan grinds for seconds toward the route timeout. The optional
 * `nodeBudget` is a MUTABLE shared counter (one per plan): each snap's effective
 * DFS ceiling is `min(TAGGED_SNAP_NODE_CAP, budget.remaining)`, and the snap
 * DECREMENTS the shared budget by the nodes it actually spent. Once the budget is
 * exhausted, later snaps get a near-zero DFS ceiling and DEGRADE GRACEFULLY —
 * N (all-nice) → P (cheapest-winner absorbs, still snapped + tag-exact) → G (the
 * legacy O(n) per-100k grid snap, DFS-free, always tag-exact). Niceness is the
 * ONLY thing sacrificed under budget pressure (the honesty banner already reports
 * `allNice=false`); tag-exactness (1e-4), the edge window, never-inflate caps and
 * loss-monotonicity are NEVER relaxed by the budget. The bound is a NODE count
 * (deterministic across runs/machines), not wall-clock — reproducible by design.
 * Omit `nodeBudget` to keep the legacy per-snap-only cap (every existing direct
 * caller / harness fixture is byte-identical).
 */
function snapTaggedPer100k(input: {
  values: readonly number[];
  weights: readonly number[];
  price: number;
  tag: number;
  targetEdge: number;
  /** Acceptance ceiling above target (SNAP window + any one-sided excess). */
  edgeTolAbove: number;
  grailGuard: (cand: number[]) => boolean;
  /**
   * Owner-pinned slots (Retune V2 pins): FROZEN at exactly `units` (on the
   * caller's `scale` grid) — excluded from every ladder/rounding/repair pass
   * and from buffer selection, while their units still count toward the band
   * sums (a pinned WIN card's units are part of the exact tag total). Omit
   * for the legacy per-100k behavior — byte-identical.
   */
  pins?: { index: number; units: number }[];
  /**
   * Total-weight grid (default 100,000 — the per-100k house ladder). Pinned
   * solves pass the finer PIN grid (1e9); the 0.001% rung then spans
   * `scale / 100_000` units so unpinned cards stay ON the house ladder while
   * pins keep their exact sub-rung values.
   */
  scale?: number;
  /**
   * Live anchor caps in the SAME units as `scale`, parallel to `values` —
   * the never-inflate ceiling for nice rungs (§2.1, live basis):
   * `capUnits[i] = (currentWeights[i] / Σ positive currentWeights) · scale`.
   * `Infinity` = uncapped (zero/absent current weight — LAW-6 new cards);
   * `null`/omitted = no anchor (legacy value-only path: no inflation guard,
   * mirroring the shipped rule for the generic snap).
   */
  liveCapUnits?: readonly number[] | null;
  /**
   * Plan-wide shared DFS node budget (perf-incident fix). A MUTABLE counter
   * threaded from the price search so the ALL of a plan's snaps share ONE bound
   * on the combinatorial all-nice enumeration instead of each getting the full
   * per-snap cap. See the header note. Omit for the legacy per-snap-only cap.
   */
  nodeBudget?: SnapNodeBudget;
  /**
   * NICE-GRID POST-PASS (Retune V3 wave 7): when TRUE, an accepted tier-G
   * vector is polished by {@link polishTaggedNiceGrid} — off-nice cards are
   * re-rugged onto the human-nice grid one lawful, strictly-improving move at
   * a time (full acceptance stack re-verified per move; near-miss mass and
   * `snapNodesSpent` byte-unchanged). Tiers N/P are untouched (N is all-nice
   * by construction; P's only counted-off card is the absorber itself — the
   * compensator, unfixable by definition). Omit for the legacy tier-G vector
   * (existing callers byte-identical).
   */
  niceGridPolish?: boolean;
}): {
  weights: number[];
  risk: PackRisk;
  allNice: boolean;
  niceExemptIdx: number[];
} | null {
  const { values, price, tag, targetEdge, edgeTolAbove } = input;
  const n = values.length;
  if (!(price > 0) || !(tag > 0) || tag >= 1) return null;
  let total = 0;
  for (const w of input.weights) if (Number.isFinite(w) && w > 0) total += w;
  if (!(total > 0)) return null;

  const SCALE = input.scale ?? 100_000;
  // Units per 0.001% rung (1 on the legacy per-100k grid).
  const RUNG = SCALE / 100_000;
  if (!Number.isInteger(RUNG) || RUNG < 1) return null;
  const pinnedUnitsByIdx = new Map<number, number>(
    (input.pins ?? []).map((p) => [p.index, p.units]),
  );
  const W = Math.round(tag * SCALE);
  if (W < 1) return null; // tag below the grid resolution — unrepresentable

  const winIdx: number[] = [];
  const nmIdx: number[] = [];
  const dustIdx: number[] = [];
  let pinnedWinUnits = 0;
  for (let i = 0; i < n; i++) {
    const w = input.weights[i]!;
    const v = values[i]!;
    if (!(w > 0) || !(v > 0)) continue; // cap-dropped / zeroed slots stay 0
    if (pinnedUnitsByIdx.has(i)) {
      if (v >= price) pinnedWinUnits += pinnedUnitsByIdx.get(i)!;
      continue; // pinned slots are frozen — never laddered, never the buffer
    }
    if (v >= price) winIdx.push(i);
    else if (v >= 0.5 * price) nmIdx.push(i);
    else dustIdx.push(i);
  }
  // The buffer must be a FREE dust card; the win band needs a FREE winner to
  // absorb the exact tag landing UNLESS pinned winners alone already sit on
  // it (legacy no-pins behavior: an empty win band is always a null).
  if (dustIdx.length === 0) return null;
  if (winIdx.length === 0) {
    if (pinnedUnitsByIdx.size === 0) return null;
    if (Math.abs(pinnedWinUnits - W) > TAGGED_WINRATE_TOLERANCE * SCALE + 1e-9) {
      return null;
    }
  }

  const pctUnits = (i: number): number => (input.weights[i]! / total) * SCALE;
  const u = new Array<number>(n).fill(0);
  for (const [i, units] of pinnedUnitsByIdx) u[i] = units;

  // ─── Shared ladder geometry (all tiers) ────────────────────────────────
  // FREE win ladder value-DESC (stable sort: ties keep index order) and the
  // FULL ladder with pinned winners interleaved — the monotone axis for the
  // nice tiers (pins are immovable fixed points on it).
  const winDesc = [...winIdx].sort((a, b) => values[b]! - values[a]!);
  const pinnedWinIdx: number[] = [];
  for (const [i] of pinnedUnitsByIdx) {
    if (input.weights[i]! > 0 && values[i]! > 0 && values[i]! >= price) {
      pinnedWinIdx.push(i);
    }
  }
  const fullWinDesc = [...winIdx, ...pinnedWinIdx].sort(
    (a, b) => values[b]! - values[a]!,
  );
  // Buffer = the largest PRECISE-mass FREE dust card (same argmax all tiers).
  let buffer = dustIdx[0]!;
  for (const i of dustIdx) {
    if (input.weights[i]! > input.weights[buffer]!) buffer = i;
  }

  const riskOf = (cand: readonly number[]): PackRisk =>
    computePackRisk({
      cards: values.map((v, i) => ({ value: v, weight: cand[i]! })),
      price,
    });

  const eLo = targetEdge - 1e-9;
  const eHi = targetEdge + edgeTolAbove + 1e-9;

  // ─── Tiers N/P — the HUMAN-NICE rung search (snap-niceness spec §2) ─────
  // Tier N places EVERY free win card on a nice rung (all-nice); tier P lets
  // the cheapest free winner absorb the win-band residual (partially-nice).
  // Exactness stays the gate: win sum EXACTLY W by construction, edge window
  // unchanged, live-basis never-inflate caps on every non-absorber free win
  // card. The precise-based `grailGuard` is NOT applied here (it would re-ban
  // the owner's round-number ask); tier G below keeps it verbatim.
  // `dfsNodesSpent` escapes the IIFE so the plan-wide budget can be debited by
  // the exact DFS work this snap did (0 when the nice path is skipped entirely).
  let dfsNodesSpent = 0;
  const nice = ((): {
    weights: number[];
    risk: PackRisk;
    allNice: boolean;
    niceExemptIdx: number[];
  } | null => {
    const caps = input.liveCapUnits ?? null;
    const capOf = (i: number): number => {
      if (caps === null) return Infinity; // legacy value-only path: uncapped
      const c = caps[i];
      return c === undefined || !Number.isFinite(c) ? Infinity : c;
    };

    // Nice rungs in SCALE units, ascending.
    const rungs: number[] = NICE_UNITS.map((r) => r * RUNG);
    // Nearest nice rung by log distance (ties → the smaller rung: the
    // ascending walk keeps the first minimum).
    const niceNearest = (preciseUnits: number): number => {
      const logP = Math.log(Math.max(preciseUnits, 1e-9));
      let best = rungs[0]!;
      let bestDist = Math.abs(Math.log(best) - logP);
      for (let k = 1; k < rungs.length; k++) {
        const d = Math.abs(Math.log(rungs[k]!) - logP);
        if (d < bestDist) {
          bestDist = d;
          best = rungs[k]!;
        }
      }
      return best;
    };

    // FIXED (candidate-independent) assignments: pins verbatim; NM cards on
    // their nearest nice rung (dead-for-tag cards land on the 1-unit grid
    // floor — itself a nice rung); free non-buffer dust beyond the enumerated
    // one on nearest nice rungs.
    const fixedU = new Map<number, number>();
    for (const [i, units] of pinnedUnitsByIdx) fixedU.set(i, units);
    for (const i of nmIdx) {
      fixedU.set(i, Math.max(RUNG, niceNearest(pctUnits(i))));
    }
    // The ENUMERATED non-buffer dust card = the largest PRECISE mass among
    // the remaining free dust (it is EV freedom, not noise — spec §2.1).
    let dustEnum = -1;
    for (const i of dustIdx) {
      if (i === buffer) continue;
      if (dustEnum === -1 || input.weights[i]! > input.weights[dustEnum]!) {
        dustEnum = i;
      }
    }
    for (const i of dustIdx) {
      if (i === buffer || i === dustEnum) continue;
      fixedU.set(i, Math.max(RUNG, niceNearest(pctUnits(i))));
    }
    // Enumerated dust rung options: NICE_UNITS ∩ [1, 60000] per-100k units
    // (sentinel single option when no non-buffer dust card exists).
    const dustOptions: number[] =
      dustEnum === -1 ? [0] : rungs.filter((r) => r <= 60_000 * RUNG);

    let fixedUnits = 0;
    let fixedEvUnits = 0;
    for (const [i, units] of fixedU) {
      fixedUnits += units;
      fixedEvUnits += units * values[i]!;
    }

    const freeWinTarget = W - pinnedWinUnits; // the FREE win band's exact sum
    if (winDesc.length > 0 && freeWinTarget < winDesc.length) return null;
    const vBuffer = values[buffer]!;
    const vDustEnum = dustEnum === -1 ? 0 : values[dustEnum]!;

    // FREE dust transfer endpoints (tier P edge landing — the shipped
    // analytic integer transfer, cheapest-value ↔ most-expensive-value).
    const dustAsc = [...dustIdx].sort((a, b) => values[a]! - values[b]!);
    const dustLo = dustAsc[0]!;
    const dustHi = dustAsc[dustAsc.length - 1]!;
    const dustSpread = values[dustHi]! - values[dustLo]!;

    // Work bound — ONE budget shared across tiers N and P per snap call. On
    // breach each tier keeps the best candidate found so far (if any) and
    // otherwise falls through (N → P → G).
    // NOTE (measured delta vs the spec's 50k): the Lucky Pond fixture's own
    // all-nice enumeration needs ~112k nodes per tier even with the
    // solve-last-card optimization + the strongest sound prune (naive
    // last-level enumeration is ~1.1M) — a 50k cap would starve the spec's
    // own F1/F2 fixtures. 400k covers both tiers with headroom while keeping
    // the per-candidate work bounded (a few ms).
    //
    // PLAN-WIDE BUDGET: when the price search threads a shared `nodeBudget`, this
    // snap's effective ceiling is the SMALLER of the per-snap cap and what the
    // plan has left — so the sum of all a plan's snaps is bounded by
    // TAGGED_PLAN_NODE_BUDGET, not (candidates × per-snap cap). The nodes spent
    // here are charged back to the shared budget after both tiers run. Once the
    // plan budget is spent, `NODE_CAP` here is 0 ⇒ the DFS returns immediately
    // and the snap degrades to the DFS-free P/G tiers (still tag-exact).
    const sharedBudget = input.nodeBudget;
    const NODE_CAP =
      sharedBudget !== undefined
        ? Math.max(0, Math.min(TAGGED_SNAP_NODE_CAP, sharedBudget.remaining))
        : TAGGED_SNAP_NODE_CAP;
    const COMPLETION_CAP = 5_000;
    let nodes = 0;
    let completions = 0;
    // FREE cards remaining at/after each ladder position (incl. current) —
    // powers the strong partial-sum prune (monotone ⇒ every remaining free
    // card, absorber included, needs ≥ the current rung).
    const freeLeftAt: number[] = new Array<number>(fullWinDesc.length + 1).fill(0);
    for (let k = fullWinDesc.length - 1; k >= 0; k--) {
      freeLeftAt[k] =
        freeLeftAt[k + 1]! +
        (pinnedUnitsByIdx.has(fullWinDesc[k]!) ? 0 : 1);
    }

    const jack = winDesc.length > 0 ? winDesc[0]! : -1;
    const cheapestFree =
      winDesc.length > 0 ? winDesc[winDesc.length - 1]! : -1;
    // A single free winner is FORCED (= W − Σ pinned wins): zero freedom, so
    // it is niceness-exempt in EVERY tier (spec §1.3).
    const forcedSingle = winDesc.length === 1;

    type NiceCand = {
      dist: number;
      jackOff: number;
      edgeExcess: number;
      lex: number[];
      u: number[];
    };
    // Owner pins are LAW-M-exempt (sovereign) in the in-DFS law check.
    const lawPinnedIdx: ReadonlySet<number> | undefined =
      pinnedUnitsByIdx.size > 0 ? new Set(pinnedUnitsByIdx.keys()) : undefined;
    // Deterministic total order (spec §2.2): shape distance → jackpot on the
    // 1-in-N menu → smallest house-favorable edge excess → lexicographically
    // smallest (win units value-DESC…, dust rung).
    const betterCand = (a: NiceCand, b: NiceCand): boolean => {
      if (a.dist < b.dist - 1e-12) return true;
      if (a.dist > b.dist + 1e-12) return false;
      if (a.jackOff !== b.jackOff) return a.jackOff < b.jackOff;
      if (a.edgeExcess < b.edgeExcess - 1e-12) return true;
      if (a.edgeExcess > b.edgeExcess + 1e-12) return false;
      for (let k = 0; k < a.lex.length; k++) {
        if (a.lex[k]! !== b.lex[k]!) return a.lex[k]! < b.lex[k]!;
      }
      return false;
    };

    const runTier = (tier: "N" | "P"): NiceCand | null => {
      let best: NiceCand | null = null;
      // Which free win cards enumerate nice rungs: tier N = all free winners
      // (a single free winner is forced at the residual instead); tier P =
      // all but the cheapest free winner (the absorber).
      const absorb = tier === "P" || forcedSingle;
      const winU = new Map<number, number>();

      // Assemble the full unit vector for one (win assignment, dust rung).
      const assemble = (dustRung: number): number[] | null => {
        const cand = new Array<number>(n).fill(0);
        for (const [i, units] of fixedU) cand[i] = units;
        for (const [i, units] of winU) cand[i] = units;
        if (dustEnum !== -1) cand[dustEnum] = dustRung;
        let nonBuffer = 0;
        for (let i = 0; i < n; i++) if (i !== buffer) nonBuffer += cand[i]!;
        const residual = SCALE - nonBuffer;
        if (residual < 1) return null;
        cand[buffer] = residual;
        return cand;
      };

      // One completed win assignment × the enumerated dust rungs.
      const complete = (
        freeSum: number,
        dist: number,
        winEvUnits: number,
      ): void => {
        completions += 1;
        for (const dustRung of dustOptions) {
          const nonBufferUnits =
            fixedUnits + freeSum + (dustEnum === -1 ? 0 : dustRung);
          const residual = SCALE - nonBufferUnits;
          if (residual < 1) continue;
          const evUnits =
            fixedEvUnits +
            winEvUnits +
            (dustEnum === -1 ? 0 : dustRung * vDustEnum) +
            residual * vBuffer;
          let ev = evUnits / SCALE;
          let edge = 1 - ev / price;
          let transferX = 0;
          if (edge < eLo || edge > eHi) {
            // Tier N never transfers (a transfer would knock a nice dust
            // card off its rung — the price sweep supplies that freedom);
            // tier P applies the SHIPPED analytic integer dust transfer.
            if (tier === "N" || !(dustSpread > 0)) continue;
            const evHiBound = price * (1 - targetEdge);
            const evLoBound = price * (1 - targetEdge - edgeTolAbove);
            const xMin = Math.ceil(((ev - evHiBound) * SCALE) / dustSpread - 1e-9);
            const xMax = Math.floor(((ev - evLoBound) * SCALE) / dustSpread + 1e-9);
            const loUnits =
              dustLo === buffer
                ? residual
                : dustLo === dustEnum
                  ? dustRung
                  : fixedU.get(dustLo)!;
            const hiUnits =
              dustHi === buffer
                ? residual
                : dustHi === dustEnum
                  ? dustRung
                  : fixedU.get(dustHi)!;
            const xFloor = -(loUnits - 1);
            const xCeil = hiUnits - 1;
            const a = Math.max(xMin, xFloor);
            const b = Math.min(xMax, xCeil);
            if (a > b) continue;
            let x = a <= 0 && 0 <= b ? 0 : Math.abs(a) < Math.abs(b) ? a : b;
            if (x !== 0 && RUNG > 1) {
              x = x > 0 ? Math.ceil(a / RUNG) * RUNG : Math.floor(b / RUNG) * RUNG;
              if (x < a || x > b) continue;
            }
            transferX = x;
            ev = ev - (x * dustSpread) / SCALE;
            edge = 1 - ev / price;
            if (edge < eLo || edge > eHi) continue;
          }
          const jackRung = jack === -1 ? 0 : (winU.get(jack) ?? 0);
          const jackOff =
            jack === -1 || JACKPOT_MENU_PER_100K.includes(jackRung / RUNG)
              ? 0
              : 1;
          const lex: number[] = [];
          for (const i of winDesc) lex.push(winU.get(i) ?? 0);
          lex.push(dustEnum === -1 ? 0 : dustRung);
          const cand: NiceCand = {
            dist,
            jackOff,
            edgeExcess: edge - targetEdge,
            lex,
            u: [],
          };
          if (best === null || betterCand(cand, best)) {
            const assembled = assemble(dustRung);
            if (assembled === null) continue;
            if (transferX !== 0) {
              assembled[dustLo] = assembled[dustLo]! + transferX;
              assembled[dustHi] = assembled[dustHi]! - transferX;
            }
            // LAW M inside the DFS (Retune V3): adopt only candidates the
            // boundary gate would accept — same predicate, same tolerance.
            // An unlawful "nicer" layout must lose to a lawful one, not win
            // the tier and burn a gate re-lay (which forfeits the snap).
            const candShares = assembled.map((u) => u / SCALE);
            if (
              findMonotoneViolations({
                values,
                shares: candShares,
                pinnedIdx: lawPinnedIdx,
                tol: 1e-9,
              }).length > 0
            ) {
              continue;
            }
            cand.u = assembled;
            best = cand;
          }
        }
      };

      // DFS over the FULL win ladder (value-DESC): pinned entries are fixed
      // points (monotone-checked, never enumerated); free entries walk the
      // nice rungs ascending with monotone / live-cap / partial-sum pruning.
      // The LAST free card (the cheapest — the absorber slot) is SOLVED
      // exactly rather than enumerated: tier P (and the forced single) takes
      // any integer residual; tier N requires the solved residual to sit ON
      // a nice rung. Semantically identical to enumerating it (the DFS only
      // ever accepted the exact-sum completion) at 1/28th the node count.
      const walk = (
        pos: number,
        prevUnits: number,
        freeSum: number,
        dist: number,
        winEvUnits: number,
      ): void => {
        if (nodes >= NODE_CAP || completions >= COMPLETION_CAP) return;
        nodes += 1;
        if (pos === fullWinDesc.length) {
          // Completion: the FREE win sum landed EXACTLY (tag by
          // construction — the solved absorber slot guarantees it). With no
          // free winners the pinned sum already passed the tolerance gate.
          complete(freeSum, dist, winEvUnits);
          return;
        }
        const i = fullWinDesc[pos]!;
        const pinnedHere = pinnedUnitsByIdx.get(i);
        if (pinnedHere !== undefined) {
          // Immovable fixed point: a candidate that cannot satisfy
          // monotonicity around a pin dies here.
          if (pinnedHere < prevUnits) return;
          walk(pos + 1, pinnedHere, freeSum, dist, winEvUnits);
          return;
        }
        if (i === cheapestFree) {
          // The solved slot: exact residual so the win sum is EXACTLY W.
          const units = freeWinTarget - freeSum;
          if (units < Math.max(1, prevUnits)) return;
          if (!absorb) {
            // Tier N: the cheapest free winner must ITSELF be nice (that is
            // the whole point of N; it stays live-cap-exempt).
            if (units % RUNG !== 0 || !NICE_UNITS_SET.has(units / RUNG)) return;
            const precise = Math.max(pctUnits(i), 1e-9);
            dist += Math.abs(Math.log(units / precise));
          }
          winU.set(i, units);
          walk(pos + 1, units, freeSum + units, dist, winEvUnits + units * values[i]!);
          winU.delete(i);
          return;
        }
        // The cheapest free winner is exempt from the live cap (the
        // anti-jackpot — the card the shipped snap already lets absorb
        // above live); every other free win card is capped.
        const cap = capOf(i);
        const precise = Math.max(pctUnits(i), 1e-9);
        const freeRemaining = freeLeftAt[pos]!;
        for (const rung of rungs) {
          if (rung < prevUnits) continue;
          if (rung > cap + 1e-9) break;
          // Strong partial-sum prune: monotone ⇒ every remaining free card
          // (absorber included) needs ≥ this rung; ascending rungs ⇒ break.
          if (freeSum + rung * freeRemaining > freeWinTarget) break;
          winU.set(i, rung);
          walk(
            pos + 1,
            rung,
            freeSum + rung,
            dist + Math.abs(Math.log(rung / precise)),
            winEvUnits + rung * values[i]!,
          );
          if (nodes >= NODE_CAP || completions >= COMPLETION_CAP) {
            winU.delete(i);
            return;
          }
        }
        winU.delete(i);
      };

      walk(0, 0, 0, 0, 0);
      return best;
    };

    // Verify the selected candidate on the REAL risk math (float-safety: the
    // per-candidate edge is analytic; the acceptance stack is re-asserted on
    // `computePackRisk` before adoption — a miss falls through, never ships).
    const finish = (
      cand: NiceCand | null,
      exempt: number[],
    ): {
      weights: number[];
      risk: PackRisk;
      allNice: boolean;
      niceExemptIdx: number[];
    } | null => {
      if (cand === null || cand.u.length === 0) return null;
      const r = riskOf(cand.u);
      if (r.edge < eLo || r.edge > eHi) return null;
      if (Math.abs(r.winRate - tag) > TAGGED_WINRATE_TOLERANCE + 1e-12) {
        return null;
      }
      return {
        weights: cand.u.slice(),
        risk: r,
        allNice: countOffNicePct(cand.u, exempt) === 0,
        niceExemptIdx: exempt,
      };
    };

    // Niceness-ACCOUNTING exemptions: the dust buffer, owner pins and a
    // FORCED single free winner (zero freedom — its units are the tag
    // arithmetic itself). The P-tier absorber is construction-exempt (the
    // DFS never requires it nice) but COUNTS toward `allNice`/off-nice —
    // the owner reads its odds too (his complaint screenshot included the
    // 3.476% absorber), and fixture F4's honesty banner + the
    // `allNice === (offLadderCards.length === 0)` consistency pin both
    // require the absorber to be counted.
    const exemptAcct = forcedSingle
      ? [buffer, ...pinnedUnitsByIdx.keys(), cheapestFree]
      : [buffer, ...pinnedUnitsByIdx.keys()];
    // Tier N first; only run tier P if N produced nothing (the shipped order).
    // `nodes` accumulates across both `runTier` calls (shared closure counter);
    // publish it to `dfsNodesSpent` before every return so the plan-wide budget
    // is debited by the exact DFS work this snap performed.
    const nCand = runTier("N");
    const nRes = finish(nCand, exemptAcct);
    if (nRes !== null) {
      dfsNodesSpent = nodes;
      return nRes;
    }
    const pRes = finish(runTier("P"), exemptAcct);
    dfsNodesSpent = nodes;
    return pRes;
  })();
  // Charge this snap's DFS work to the shared plan budget (perf-incident fix).
  // `dfsNodesSpent` is set inside the IIFE via the closure; when no shared
  // budget is threaded this is inert.
  if (input.nodeBudget !== undefined) {
    input.nodeBudget.remaining = Math.max(
      0,
      input.nodeBudget.remaining - dfsNodesSpent,
    );
  }
  if (nice !== null) return nice;

  // ── Tier G — the shipped per-100k grid snap (byte-identical fallback) ──
  // ── Win ladder (value-DESC, FREE winners): jackpot on the 1-in-N menu,
  //    others rounded to the rung grid, odds non-increasing in value. ──
  if (winDesc.length > 0) {
    const jack = winDesc[0]!;
    // The menu styles the HEADLINE jackpot — only when no pinned win card is
    // pricier (a pinned pricier card IS the headline, owner-styled already).
    const jackIsHeadline = ![...pinnedUnitsByIdx.keys()].some(
      (i) =>
        input.weights[i]! > 0 &&
        values[i]! >= price &&
        values[i]! > values[jack]!,
    );
    const p = pctUnits(jack);
    // Prefer the largest 1-in-N menu rung that does NOT exceed the precise
    // share (the snap may round the jackpot DOWN to a round ticket count,
    // never up) — but ONLY in the rare-jackpot regime (≤ 1%, where the rain
    // menu lives) and only when the rung keeps ≥ 70% of the precise odds
    // (never silently halve an advertised jackpot). Else the plain grid
    // round; the grid minimum (one rung) applies last.
    let pick = Math.max(RUNG, Math.round(p / RUNG) * RUNG);
    if (jackIsHeadline && p <= 1000 * RUNG) {
      let menuPick = 0;
      for (const m of JACKPOT_MENU_PER_100K) {
        const scaled = m * RUNG;
        if (scaled <= p + 1e-9 && scaled > menuPick) menuPick = scaled;
      }
      if (menuPick >= 0.7 * p) pick = menuPick;
      else if (menuPick === 0) pick = Math.max(RUNG, Math.floor(p / RUNG) * RUNG);
    }
    u[jack] = pick;
    for (let k = 1; k < winDesc.length; k++) {
      const i = winDesc[k]!;
      u[i] = Math.max(RUNG, Math.round(pctUnits(i) / RUNG) * RUNG);
      const prev = winDesc[k - 1]!;
      if (u[i]! < u[prev]!) u[i] = u[prev]!; // repair: cheaper never rarer
    }
    // Land the win-band sum EXACTLY on W via the cheapest FREE winner (the
    // anti-jackpot — the same card the solver's RC4 knob privileges). Pinned
    // win units are part of the sum, so an off-rung pin makes this absorber
    // carry the off-grid residual — the tag stays exact either way.
    const cheapest = winDesc[winDesc.length - 1]!;
    let sumWin = pinnedWinUnits;
    for (const i of winIdx) sumWin += u[i]!;
    const adjusted = u[cheapest]! + (W - sumWin);
    const floorForCheapest =
      winDesc.length >= 2 ? u[winDesc[winDesc.length - 2]!]! : 1;
    if (adjusted < Math.max(1, floorForCheapest)) return null;
    u[cheapest] = adjusted;
  }

  // ── Near-miss band: rounded verbatim (dead-for-tag cards keep the one-rung
  //    grid minimum — 0.001%, the "~zero mass" the ruleset assigns them). ──
  for (const i of nmIdx) u[i] = Math.max(RUNG, Math.round(pctUnits(i) / RUNG) * RUNG);

  // ── Dust: the largest-mass FREE dust card is THE residual buffer
  //    (`buffer` — the shared argmax hoisted above). ──
  for (const i of dustIdx) {
    if (i !== buffer) u[i] = Math.max(RUNG, Math.round(pctUnits(i) / RUNG) * RUNG);
  }
  let nonBuffer = 0;
  for (let i = 0; i < n; i++) if (i !== buffer) nonBuffer += u[i]!;
  const residual = SCALE - nonBuffer;
  if (residual < 1) return null;
  u[buffer] = residual;

  // ── Edge landing: analytic integer transfer inside the FREE dust band. ──
  // EV is linear in a mass transfer x between two dust values (total + win
  // band unchanged): moving x units from the most expensive dust card to the
  // cheapest lowers EV by x·(v_hi − v_lo)/SCALE ⇒ raises edge. Solve the
  // integer x landing edge ∈ [target, target + tol]; pools with a single dust
  // value have zero freedom (accept only if already inside the window). The
  // transfer moves whole RUNGs so both endpoints stay on the house ladder
  // (identical to the legacy unit transfer on the per-100k grid).
  let cand = u;
  let r = riskOf(cand);
  if (r.edge < eLo || r.edge > eHi) {
    const dustAsc = [...dustIdx].sort((a, b) => values[a]! - values[b]!);
    const lo = dustAsc[0]!;
    const hi = dustAsc[dustAsc.length - 1]!;
    const spread = values[hi]! - values[lo]!;
    if (!(spread > 0)) return null;
    // Current EV → the transfer window [xMin, xMax] in integer units.
    const evHiBound = price * (1 - targetEdge); // EV must be ≤ this (edge ≥ target)
    const evLoBound = price * (1 - targetEdge - edgeTolAbove); // and ≥ this
    const xMin = Math.ceil(((r.ev - evHiBound) * SCALE) / spread - 1e-9);
    const xMax = Math.floor(((r.ev - evLoBound) * SCALE) / spread + 1e-9);
    // Keep both cards on the grid (≥ 1 unit).
    const xFloor = -(cand[lo]! - 1);
    const xCeil = cand[hi]! - 1;
    const a = Math.max(xMin, xFloor);
    const b = Math.min(xMax, xCeil);
    if (a > b) return null;
    let x = a <= 0 && 0 <= b ? 0 : Math.abs(a) < Math.abs(b) ? a : b;
    // Rung-align the chosen endpoint INWARD (no-op on the legacy grid where
    // RUNG = 1); an empty rung-aligned window falls back to precise weights.
    if (x !== 0 && RUNG > 1) {
      x = x > 0 ? Math.ceil(a / RUNG) * RUNG : Math.floor(b / RUNG) * RUNG;
      if (x < a || x > b) return null;
    }
    if (x !== 0) {
      const next = cand.slice();
      next[lo] = next[lo]! + x;
      next[hi] = next[hi]! - x;
      cand = next;
      r = riskOf(cand);
    }
    if (r.edge < eLo || r.edge > eHi) return null;
  }

  // ── Final acceptance stack. ──
  if (Math.abs(r.winRate - tag) > TAGGED_WINRATE_TOLERANCE + 1e-12) return null;
  if (!input.grailGuard(cand as number[])) return null;
  // Niceness verdict on the G vector, honestly computed (a grid snap CAN
  // land all-nice by luck). Accounting exemptions = buffer + pins + a
  // FORCED single free winner; the cheapest-winner absorber COUNTS (same
  // accounting as tiers N/P — see the note there).
  const exemptG = [buffer, ...pinnedUnitsByIdx.keys()];
  if (winDesc.length === 1) exemptG.push(winDesc[0]!);
  // NICE-GRID POST-PASS (wave 7, opt-in): re-rung the accepted G vector's
  // off-nice cards onto the human-nice grid, one strictly-improving lawful
  // move at a time. The polish re-verifies the acceptance stack per move
  // (edge window, exact tag, win-ladder + LAW M monotonicity, live-basis
  // never-inflate caps — the N/P semantics, NOT the precise-based grailGuard
  // this G vector already passed, which would freeze a precise-copy vector
  // down-only; see the polish header). On zero improvement the vector ships
  // byte-identical to the legacy G snap.
  if (input.niceGridPolish === true && countOffNicePct(cand, exemptG) > 0) {
    const polished = polishTaggedNiceGrid({
      units: cand,
      values,
      price,
      tag,
      targetEdge,
      edgeTolAbove,
      scale: SCALE,
      buffer,
      exemptIdx: exemptG,
      ...(pinnedUnitsByIdx.size > 0
        ? { pinnedIdx: new Set(pinnedUnitsByIdx.keys()) }
        : {}),
      liveCapUnits: input.liveCapUnits ?? null,
    });
    cand = polished;
    r = riskOf(cand);
  }
  return {
    weights: cand.slice(),
    risk: r,
    allNice: countOffNicePct(cand, exemptG) === 0,
    niceExemptIdx: exemptG,
  };
}

/**
 * Pin-aware clean-ladder snap for UNTAGGED (or off-tag) pinned pools. Works on
 * the PIN grid (`scale` units total): every FREE slot except the largest-mass
 * free BUFFER is snapped to its log-nearest {@link CLEAN_LADDER} rung (every
 * rung is an integer number of units on the pin grid by construction), the
 * within-band monotonicity invariants are repaired among FREE slots only
 * (pins are owner-chosen numbers — never moved, never compared), and the free
 * buffer absorbs the residual so the total stays exactly `scale`. Returns the
 * candidate weight vector or `null` when the ladder can't hold it (the caller
 * keeps the precise weights — no regression possible). The CALLER runs the
 * full acceptance stack (edge window, win-rate tolerance, tag gate, grail
 * guard) before adopting.
 */
function snapPinnedFreeToCleanLadder(input: {
  weights: readonly number[];
  values: readonly number[];
  price: number;
  pinnedIdx: ReadonlySet<number>;
  scale: number;
}): number[] | null {
  const { values, price, pinnedIdx, scale } = input;
  const n = values.length;
  if (!(price > 0) || !(scale > 0)) return null;
  const unitsPerPct = scale / 100;

  let pinnedUnits = 0;
  const freeIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    const w = input.weights[i]!;
    if (!(w > 0)) continue;
    if (pinnedIdx.has(i)) {
      pinnedUnits += w;
      continue;
    }
    freeIdx.push(i);
  }
  if (freeIdx.length === 0) return null;

  // Buffer = the largest-mass FREE slot (typically the dust card).
  let buffer = freeIdx[0]!;
  for (const i of freeIdx) {
    if (input.weights[i]! > input.weights[buffer]!) buffer = i;
  }

  const nearestRungIdx = (pct: number): number => {
    const logP = Math.log10(pct);
    let best = 0;
    let bestDist = Math.abs(Math.log10(CLEAN_LADDER[0]!) - logP);
    for (let k = 1; k < CLEAN_LADDER.length; k++) {
      const d = Math.abs(Math.log10(CLEAN_LADDER[k]!) - logP);
      if (d < bestDist) {
        bestDist = d;
        best = k;
      }
    }
    return best;
  };

  // Rung assignment for every free non-buffer slot.
  const rungIdx = new Array<number>(n).fill(-1);
  for (const i of freeIdx) {
    if (i === buffer) continue;
    const pct = (input.weights[i]! / scale) * 100;
    if (!(pct > 0)) continue;
    rungIdx[i] = nearestRungIdx(pct);
  }

  // Within-band monotonicity repair among FREE non-buffer slots (the same
  // owner invariants `repairSnapMonotonicity` enforces): as value descends,
  // probability never decreases; demote the pricier violator.
  const grail: number[] = [];
  const win: number[] = [];
  const nearMiss: number[] = [];
  const dustBand: number[] = [];
  for (const i of freeIdx) {
    if (i === buffer || rungIdx[i]! < 0) continue;
    const v = values[i]!;
    if (!(v > 0) || !Number.isFinite(v)) continue;
    if (v >= 5 * price) grail.push(i);
    else if (v >= price) win.push(i);
    else if (v >= 0.5 * price) nearMiss.push(i);
    else dustBand.push(i);
  }
  const byValueDesc = (a: number, b: number) => values[b]! - values[a]!;
  grail.sort(byValueDesc);
  win.sort(byValueDesc);
  nearMiss.sort(byValueDesc);
  dustBand.sort(byValueDesc);
  for (const band of [grail, win, nearMiss, dustBand]) {
    for (let i = band.length - 2; i >= 0; i--) {
      const expensive = band[i]!;
      const cheaper = band[i + 1]!;
      while (rungIdx[expensive]! > rungIdx[cheaper]!) {
        if (rungIdx[expensive]! === 0) return null;
        rungIdx[expensive] = rungIdx[expensive]! - 1;
      }
    }
  }
  // Strict rarity at the grail top — ONLY when the two most-expensive grails
  // are both free (a pinned top is the owner's number, exempt).
  if (grail.length >= 2) {
    const top = grail[0]!;
    const second = grail[1]!;
    const pinnedPricierGrail = [...pinnedIdx].some(
      (i) => input.weights[i]! > 0 && values[i]! > values[top]!,
    );
    if (!pinnedPricierGrail) {
      while (rungIdx[top]! >= rungIdx[second]!) {
        if (rungIdx[top]! === 0) return null;
        rungIdx[top] = rungIdx[top]! - 1;
      }
    }
  }

  // Assemble: pins verbatim, free non-buffer on rungs, buffer = residual.
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (pinnedIdx.has(i) && input.weights[i]! > 0) out[i] = input.weights[i]!;
  }
  let nonBufferSum = pinnedUnits;
  for (const i of freeIdx) {
    if (i === buffer) continue;
    if (rungIdx[i]! < 0) {
      out[i] = input.weights[i]!; // zero-pct defensive carry-over
      nonBufferSum += out[i]!;
      continue;
    }
    out[i] = Math.max(1, Math.round(CLEAN_LADDER[rungIdx[i]!]! * unitsPerPct));
    nonBufferSum += out[i]!;
  }
  const residual = scale - nonBufferSum;
  if (residual < 1) return null;
  out[buffer] = residual;
  return out;
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
/**
 * Shared construction of the LAW M environment (values, never-inflate caps
 * from the LIVE shares, pins, pinned near-miss mass) used by the lawful
 * rescue, the tag-fit verdict AND the guidance's fit window (compose seam),
 * so none of them can ever disagree about what "the lawful envelope" means.
 * Over-cap win rows are zero-capped (excluded as rungs) unless pinned — pins
 * are sovereign. Returns null on malformed input (same validations the
 * rescue always applied).
 */
export function buildLawEnv(input: {
  cards: { value: number }[];
  price: number;
  maxWinCap?: number;
  currentWeights?: number[];
  pinnedShares?: ShapeWeightsPinnedShare[];
}): {
  values: number[];
  pins: { index: number; share: number }[] | null;
  pinnedIdx: Set<number> | undefined;
  pinnedNm: number;
  winCaps: (number | null)[];
  liveShares: number[];
  curTotal: number;
} | null {
  const price = input.price;
  const n = input.cards.length;
  if (!(price > 0) || n === 0) return null;
  const values = input.cards.map((c) => c.value);
  const pinsIn = input.pinnedShares ?? [];
  const pinnedIdx = pinsIn.length > 0 ? new Set(pinsIn.map((p) => p.index)) : undefined;
  let pinnedNm = 0;
  for (const p of pinsIn) {
    if (!Number.isInteger(p.index) || p.index < 0 || p.index >= n) return null;
    if (!Number.isFinite(p.share) || !(p.share > 0) || p.share > 1) return null;
    const v = values[p.index]!;
    if (v >= 0.5 * price && v < price) pinnedNm += p.share;
  }
  let curTotal = 0;
  if (input.currentWeights) {
    for (const w of input.currentWeights) {
      if (Number.isFinite(w) && w > 0) curTotal += w;
    }
  }
  const liveShares = new Array<number>(n).fill(0);
  if (curTotal > 0) {
    for (let i = 0; i < n; i++) {
      const w = input.currentWeights![i];
      liveShares[i] = Number.isFinite(w) && w! > 0 ? w! / curTotal : 0;
    }
  }
  const winCaps = new Array<number | null>(n).fill(null);
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    if (!(v > 0) || v < price) continue;
    if (pinnedIdx?.has(i)) continue;
    if (input.maxWinCap !== undefined && v > input.maxWinCap) {
      winCaps[i] = 0;
      continue;
    }
    if (curTotal > 0) winCaps[i] = liveShares[i]!;
  }
  return {
    values,
    pins: pinsIn.length > 0 ? pinsIn.map((p) => ({ index: p.index, share: p.share })) : null,
    pinnedIdx,
    pinnedNm,
    winCaps,
    liveShares,
    curTotal,
  };
}

/**
 * LAW T fit range (Retune V3 stage 3): the interval of win-rate TAGS this
 * pool can lawfully host at ONE price — i.e. the tags whose LAW M window
 * (never-inflate caps from the live shares, pins sovereign, near-miss floor
 * at its unrelaxable minimum = the pinned NM mass) intersects the accepted
 * one-sided edge contract `[targetEdge, targetEdge + edgeExcessTol]`.
 *
 * This is the engine's PROOF for the tag-fit verdict: `maxFit` is the
 * largest tag that fits ("retag at or below this"), `minFit` the smallest
 * (a pool can also be too poor to hold a tiny tag inside the contract —
 * the window's EV tops out below the accepted band). `null` = NO tag fits
 * at this price under the pool's lawful envelope.
 *
 * The near-miss floor is deliberately taken at its HARD minimum (pins only):
 * the engine's NM-floor honesty pass relaxes the free floor before refusing,
 * so a fit claim here must not depend on relaxable mass. Feasibility over the
 * tag axis need not be one interval in pathological pools; the scan returns
 * the outer bounds (0.05pp grid + boundary bisection), which is exactly what
 * the verdict copy needs.
 */
export function lawfulTagFitRange(input: {
  cards: { value: number }[];
  price: number;
  targetEdge?: number;
  maxWinCap?: number;
  currentWeights?: number[];
  pinnedShares?: ShapeWeightsPinnedShare[];
  /** One-sided edge acceptance above target. Default {@link ONE_SIDED_EDGE_EXCESS_TOL}. */
  edgeExcessTol?: number;
}): { minFit: number; maxFit: number } | null {
  const price = input.price;
  const targetEdge = input.targetEdge ?? TARGET_HOUSE_EDGE;
  if (!(price > 0) || !(targetEdge > 0) || targetEdge >= 1) return null;
  const env = buildLawEnv(input);
  if (env === null) return null;
  const excess = input.edgeExcessTol ?? ONE_SIDED_EDGE_EXCESS_TOL;
  const evLo = price * (1 - (targetEdge + excess));
  const evHi = price * (1 - targetEdge);
  const fits = (tag: number): boolean => {
    if (!(tag >= 0) || tag >= 1) return false;
    const win = monotoneEvWindow({
      values: env.values,
      price,
      winMass: tag,
      nearMissMin: env.pinnedNm,
      winCaps: env.winCaps,
      pinnedShares: env.pins,
    });
    if (win === null) return false;
    return win.evMin <= evHi + 1e-9 && win.evMax >= evLo - 1e-9;
  };
  const STEP = 0.0005;
  let first = -1;
  let last = -1;
  for (let t = 0; t <= 1 - STEP / 2; t += STEP) {
    if (fits(t)) {
      if (first < 0) first = t;
      last = t;
    }
  }
  if (first < 0) return null;
  // Bisect the outer boundaries to ~1e-7 tag precision.
  let minFit = first;
  {
    let lo = Math.max(0, first - STEP);
    let hi = first;
    if (!fits(lo)) {
      for (let it = 0; it < 24; it++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) hi = mid;
        else lo = mid;
      }
      minFit = hi;
    } else {
      minFit = lo;
    }
  }
  let maxFit = last;
  {
    let lo = last;
    let hi = Math.min(1 - 1e-9, last + STEP);
    if (fits(hi)) {
      maxFit = hi;
    } else {
      for (let it = 0; it < 24; it++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      maxFit = lo;
    }
  }
  return { minFit, maxFit };
}

/**
 * LAW M RESCUE (Retune V3, search third pass): the core's band split treats
 * the near-miss floor as an EXACT allocation, so a pool that must carry MORE
 * near-miss mass to reach the edge target refuses `ev-unreachable-for-split`
 * — and the old soft float "solved" it by inflating a cheap winner into a
 * zigzag instead (under-cap fixture: $4.2 at 24.8% over a 10% near-miss at
 * −26% price). The lawful window treats the floor as a FLOOR: when a LAW-M
 * ladder inside the accepted edge band exists at the requested win rate, lay
 * it directly (win mass / pins exact, never-inflate caps, every live row
 * kept alive). Verified fail-closed; returns null when no lawful ladder
 * exists. Runs ONLY as {@link searchBestPriceForCleanSnap}'s last resort so
 * snapped/nice plans and the remedy engine's stricter verification keep
 * priority.
 *
 * NM-FLOOR HONESTY (stage 3): when the requested near-miss floor itself is
 * what empties the lawful window (the pool physically cannot carry that much
 * near-miss mass inside the edge contract), the rescue does not give the
 * plan up — it bisects to the MAXIMUM floor the window can fund (never below
 * the pinned NM mass, which is sovereign), lays there, and reports the gap
 * as an explicit `nearMiss` relaxation. Win mass / pins stay EXACT — only
 * the soft feel dial relaxes, and never silently.
 */
function lawfulWindowRescue(input: ShapeWeightsInput): ShapeWeightsSuccess | null {
  const price = input.price;
  const targetEdge = input.targetEdge ?? TARGET_HOUSE_EDGE;
  const winMass = input.targetWinRate;
  if (!(price > 0) || !Number.isFinite(winMass) || winMass < 0 || winMass >= 1) return null;
  if (!(targetEdge > 0) || targetEdge >= 1) return null;
  const env = buildLawEnv(input);
  if (env === null) return null;
  const { values, pins, pinnedIdx, pinnedNm, winCaps, liveShares, curTotal } = env;
  const requestedFloor = Math.max(0, input.nearMissMin ?? 0.1) + pinnedNm;
  const layAt = (
    floor: number,
  ): { units: number[]; risk: PackRisk } | null => {
    const laid = lawfulLadderInWindow({
      values,
      price,
      winMass,
      nearMissFloor: floor,
      winCaps,
      pins,
      pinnedIdx,
      evLo: price * (1 - (targetEdge + 0.001)),
      evHi: price * (1 - targetEdge),
      // Prefer the exact-edge end of the accepted band.
      evPrefer: price * (1 - targetEdge),
      contractMode: true,
      keepAliveRef: curTotal > 0 ? liveShares : null,
    });
    if (!("units" in laid)) return null;
    if (Math.abs(laid.risk.winRate - winMass) > 1e-6) return null;
    return { units: laid.units, risk: laid.risk };
  };
  let laid = layAt(requestedFloor);
  let relaxed = false;
  if (laid === null && requestedFloor > pinnedNm + 1e-9) {
    // The floor may be the blocker. Only relax when the HARD minimum floor
    // (pins only) admits a lawful in-contract ladder — otherwise the refusal
    // is structural and stays a refusal.
    if (layAt(pinnedNm) !== null) {
      let lo = pinnedNm; // feasible
      let hi = requestedFloor; // infeasible
      for (let it = 0; it < 24; it++) {
        const mid = (lo + hi) / 2;
        if (layAt(mid) !== null) lo = mid;
        else hi = mid;
      }
      laid = layAt(lo);
      relaxed = laid !== null;
    }
  }
  if (laid === null) return null;
  const relaxations: ShapeWeightsRelaxation[] = relaxed
    ? [
        {
          lever: "nearMiss",
          requested: requestedFloor,
          applied: laid.risk.nearMiss,
          reason: `LAW M window at $${price.toFixed(2)} cannot fund the ${(requestedFloor * 100).toFixed(1)}% near-miss floor inside the edge contract — laid at the lawful maximum ${(laid.risk.nearMiss * 100).toFixed(2)}%.`,
        },
      ]
    : [];
  return {
    weights: laid.units,
    risk: laid.risk,
    ev: laid.risk.ev,
    edge: laid.risk.edge,
    relaxations,
    snapped: false,
    lotterySkewApplied: false,
    topInflationUnavoidable: false,
  };
}

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

  const winRateIsHard = input.winRateIsHard === true;
  // WIN-RATE HOLD — HARD (untagged retune spike fix): pin the win-rate at design
  // (no float) AND cap the cheapest winner (drop its EV exemption). No-op for a
  // tagged pack (it already pins the rate). See `holdWinRateHard` on the input.
  const holdWinRateHard = input.holdWinRateHard === true && !winRateIsHard;
  // WIN-RATE HOLD (owner-lens item 4): opt-in on the untagged RETUNE path only.
  // No-op for a tagged pack (it never floats) and for every legacy direct caller
  // that doesn't set the flag (behavior byte-identical). The HARD hold is a
  // strict superset (pin at design, cheapest capped) — it drives the SAME soft
  // snap-ceiling paths (`winHoldCeil` / `softWinRateCeil`), so fold it in here so
  // the ceilings bind; the pin (no float) + cheapest-cap are gated separately.
  const holdWinRate =
    (input.holdWinRate === true || holdWinRateHard) && !winRateIsHard;
  // LOSS-MASS DISPERSION (owner-lens item 10): opt-in on the RETUNE path. Pure
  // shape improvement at fixed band mass + EV; legacy direct callers (flag unset)
  // keep the single-β loss layout byte-identical.
  const disperseLoss = input.disperseLoss === true;

  // ── Owner-pinned per-card odds (Retune V2 pins) ─────────────────────────
  // Validated FIRST, fail-closed AS DATA: every refusal is the structured
  // `pins-infeasible` limit so the workspace renders plain-words copy + a fix
  // instead of an error boundary. A pin is an owner-chosen number — it is
  // held EXACTLY through solve, quantize and snap (see the pinned integer
  // grid below), and it is exempt from clean-ladder membership.
  //
  // PIN_SCALE — the pinned integer grid: 1 unit = 1e-7 % of the pool. Chosen
  // so (a) any pin typed with ≤ 7 decimal places of percent is EXACT, (b)
  // every CLEAN_LADDER rung (smallest 1e-6 %, finest base step 1.5e-6 %) is
  // an integer number of units, and (c) the largest possible weight (< 1e9)
  // stays under the int4 `pack_cards.weight` column bound.
  const PIN_SCALE = 1_000_000_000;
  const pinsIn = input.pinnedShares ?? [];
  const hasPins = pinsIn.length > 0;
  const pinsRefusal = (detail: string, suggestion: string): ShapeWeightsError => ({
    error: `Pinned odds are infeasible: ${detail}`,
    limit: { kind: "pins-infeasible", detail, suggestion },
  });
  // Honest refusal when the loss/sub-price monotonicity invariant (cheapest
  // carries the highest odds, buffer exempt) cannot hold at the required loss
  // mass — the pins / added cards force a rich loss card likelier than a cheaper
  // one and no re-ordering of the fixed loss budget fixes it (the pool-edit
  // case). Never ship the garbage ordering; surface the pool edit instead.
  const lossMonotoneRefusal = (p: number): ShapeWeightsError => ({
    error:
      "Loss-band odds can't be laid out cleanly: a cheaper card would end up rarer than a pricier one and no re-ordering fixes it at this price.",
    limit: {
      kind: "loss-nonmonotone",
      detail: `With these pins / added cards, the sub-$${p.toFixed(2)} (loss) cards can't be ordered so the cheapest carries the highest odds — the required loss average sits too high for any monotone layout. Shipping it would put a pricier loss card above a cheaper one.`,
      suggestion:
        "Edit the pool — add a cheaper loss card (or lower a pinned chance / drop an expensive added card) so the sub-price band can carry the loss mass with the cheapest card the most likely.",
    },
  });
  const pinnedShareByIdx = new Map<number, number>();
  if (hasPins) {
    for (const p of pinsIn) {
      if (
        !Number.isInteger(p.index) ||
        p.index < 0 ||
        p.index >= input.cards.length
      ) {
        return pinsRefusal(
          `a pin references card index ${String(p.index)}, outside this ${input.cards.length}-card pool.`,
          "Clear the stale pin and re-plan.",
        );
      }
      if (pinnedShareByIdx.has(p.index)) {
        return pinsRefusal(
          `card ${p.index + 1} carries two pinned values.`,
          "Keep one pinned value per card.",
        );
      }
      if (!Number.isFinite(p.share) || !(p.share > 0) || p.share > 1) {
        return pinsRefusal(
          `a pinned chance must sit between 0% and 100% (got ${String(
            Number.isFinite(p.share) ? p.share * 100 : p.share,
          )}%).`,
          "Type a chance above 0% and at most 100%, or clear the pin.",
        );
      }
      if (Math.round(p.share * PIN_SCALE) < 1) {
        return pinsRefusal(
          `a pinned chance of ${(p.share * 100).toExponential(2)}% is below the representable minimum (0.0000001%).`,
          "Pin at least 0.0000001%, or clear the pin.",
        );
      }
      const v = input.cards[p.index]!.value;
      if (!(v > 0)) {
        return pinsRefusal(
          "the pinned card has no positive value, so it can never carry odds.",
          "Clear the pin — the card is dropped from the solve either way.",
        );
      }
      if (maxWinCap !== undefined && v > maxWinCap) {
        // The cap pre-filter below would DROP this card before any odds are
        // assigned — refused as data, carrying the SAME raise-cap remedy the
        // no-win-cards cap arm suggests.
        return pinsRefusal(
          `the pinned $${v.toFixed(2)} card exceeds the $${maxWinCap.toFixed(2)} max-win cap — the cap filter drops it before any odds are assigned.`,
          `Raise the pack's max-win cap above $${v.toFixed(2)} so the pinned card can stay, or clear the pin.`,
        );
      }
      pinnedShareByIdx.set(p.index, p.share);
    }
  }
  let pinnedMass = 0;
  let pinnedEv = 0;
  let pinnedWinShare = 0;
  let pinnedNearMissShare = 0;
  for (const [idx, share] of pinnedShareByIdx) {
    const v = input.cards[idx]!.value;
    pinnedMass += share;
    pinnedEv += share * v;
    if (v >= price) pinnedWinShare += share;
    else if (v >= 0.5 * price) pinnedNearMissShare += share;
  }
  if (pinnedMass > 1 + 1e-9) {
    return pinsRefusal(
      `the pinned chances add up to ${(pinnedMass * 100).toFixed(4)}% — more than 100%.`,
      "Lower the pinned values so they sum to at most 100%.",
    );
  }
  // A hard tag is an exact promise about the WIN share — pins alone must not
  // exceed it (the remaining win cards can only ADD win mass, never subtract).
  if (winRateIsHard && pinnedWinShare > requestedWinRate + 1e-9) {
    return pinsRefusal(
      `the pinned win-card chances sum to ${(pinnedWinShare * 100).toFixed(4)}%, exceeding the ${(requestedWinRate * 100).toFixed(2)}% tag by ${((pinnedWinShare - requestedWinRate) * 100).toFixed(4)}pp — the tag is exact.`,
      "Lower the pinned win-card chances so they fit inside the tag, or clear a pin.",
    );
  }
  const freeMass = hasPins ? Math.max(0, 1 - pinnedMass) : 1;

  // ── Fully-pinned pool: the pins ARE the plan (no residual solve) ─────────
  // Accepted when the edge the pins produce lands in the accepted band
  // [target, target + ONE_SIDED_EDGE_EXCESS_TOL]; refused honestly below the
  // target (deliberate below-target pools live in the Drafts flow) or above
  // the band. Nothing is snapped — every number is owner-chosen.
  if (hasPins && freeMass <= 1e-9) {
    const unpinnedEligible = input.cards.reduce((n, c, idx) => {
      if (pinnedShareByIdx.has(idx)) return n;
      if (!(c.value > 0)) return n;
      if (maxWinCap !== undefined && c.value > maxWinCap) return n;
      return n + 1;
    }, 0);
    if (unpinnedEligible > 0) {
      return pinsRefusal(
        `the pins allocate 100% of the odds but ${unpinnedEligible} unpinned card(s) remain — they would get zero odds.`,
        "Lower a pinned chance to leave room, pin the remaining cards explicitly, or remove them from the pool.",
      );
    }
    const fullWeights = new Array<number>(input.cards.length).fill(0);
    let unitSum = 0;
    let largestIdx = -1;
    for (const [idx, share] of pinnedShareByIdx) {
      const u = Math.round(share * PIN_SCALE);
      fullWeights[idx] = u;
      unitSum += u;
      if (largestIdx < 0 || u > fullWeights[largestIdx]!) largestIdx = idx;
    }
    // Float-rounding residual (a few units at most, ≤ ~1e-9 of mass each)
    // folds into the largest pin — under the pin-hold contract's tolerance.
    const residualUnits = PIN_SCALE - unitSum;
    if (largestIdx < 0 || fullWeights[largestIdx]! + residualUnits < 1) {
      return pinsRefusal(
        "the pinned chances could not be laid out on the odds grid.",
        "Re-check the pinned values, or clear a pin.",
      );
    }
    fullWeights[largestIdx] = fullWeights[largestIdx]! + residualUnits;
    let pinnedRisk = computePackRisk({
      cards: input.cards.map((c, i) => ({ value: c.value, weight: fullWeights[i]! })),
      price,
    });
    if (pinnedRisk.edge < targetEdge - 1e-9) {
      return pinsRefusal(
        `the pinned odds land the house edge at ${(pinnedRisk.edge * 100).toFixed(3)}% — ${((targetEdge - pinnedRisk.edge) * 100).toFixed(3)}pp below the ${(targetEdge * 100).toFixed(2)}% target. A plan never ships below its curve target.`,
        "Shift pinned chance from winners toward cheaper cards or raise the price — deliberate below-target experiments live in the Drafts flow (hand-typed odds).",
      );
    }
    if (pinnedRisk.edge > targetEdge + ONE_SIDED_EDGE_EXCESS_TOL + 1e-9) {
      return pinsRefusal(
        `the pinned odds land the house edge at ${(pinnedRisk.edge * 100).toFixed(3)}% — ${((pinnedRisk.edge - targetEdge) * 100).toFixed(3)}pp above the ${(targetEdge * 100).toFixed(2)}% target (accepted band +${(ONE_SIDED_EDGE_EXCESS_TOL * 100).toFixed(2)}pp).`,
        "Shift pinned chance toward winners or lower the price.",
      );
    }
    const pinnedRelaxations: ShapeWeightsRelaxation[] = [];
    if (winRateIsHard) {
      if (
        Math.abs(pinnedRisk.winRate - requestedWinRate) >
        TAGGED_WINRATE_TOLERANCE + 1e-12
      ) {
        return pinsRefusal(
          `the pinned odds produce a ${(pinnedRisk.winRate * 100).toFixed(4)}% win-rate — off the exact ${(requestedWinRate * 100).toFixed(2)}% tag by ${(Math.abs(pinnedRisk.winRate - requestedWinRate) * 100).toFixed(4)}pp.`,
          "Adjust the pinned win-card chances so they total exactly the tag.",
        );
      }
    } else if (Math.abs(pinnedRisk.winRate - requestedWinRate) > winRateTol) {
      pinnedRelaxations.push({
        lever: "winRate",
        requested: requestedWinRate,
        applied: pinnedRisk.winRate,
        reason: `Every card is pinned — the win-rate is whatever the pinned odds produce (${(pinnedRisk.winRate * 100).toFixed(2)}%).`,
      });
    }
    // gcd-reduce (ratios — and therefore the pinned shares — are unchanged).
    const present = fullWeights.filter((w) => w > 0);
    if (present.length > 0) {
      let g = present[0]!;
      for (let i = 1; i < present.length; i++) g = gcd(g, present[i]!);
      if (g > 1) {
        for (let i = 0; i < fullWeights.length; i++) {
          if (fullWeights[i]! > 0) fullWeights[i] = Math.round(fullWeights[i]! / g);
        }
        pinnedRisk = computePackRisk({
          cards: input.cards.map((c, i) => ({ value: c.value, weight: fullWeights[i]! })),
          price,
        });
      }
    }
    const pinnedExcess = pinnedRisk.edge - targetEdge;
    return {
      weights: fullWeights,
      risk: pinnedRisk,
      ev: pinnedRisk.ev,
      edge: pinnedRisk.edge,
      relaxations: pinnedRelaxations,
      // Owner-chosen numbers everywhere — nothing unpinned remains to snap.
      snapped: true,
      lotterySkewApplied: false,
      topInflationUnavoidable: false,
      ...(pinnedExcess > 1e-9 ? { oneSidedEdgeExcess: pinnedExcess } : {}),
    };
  }

  // Index-preserving pool: drop value ≤ 0 and (if capped) value > cap.
  // Pinned cards are HELD VERBATIM — they are not part of the free solve, so
  // they never enter the band lists / water-fills / snap below.
  type Slot = { idx: number; value: number; band: Band };
  const slots: Slot[] = [];
  input.cards.forEach((c, idx) => {
    if (pinnedShareByIdx.has(idx)) return;
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

  if (slots.length === 0 && hasPins) {
    // Pins hold less than 100% but no unpinned card survives to carry the
    // rest — the residual mass has nowhere to sit.
    return pinsRefusal(
      `the pins leave ${(freeMass * 100).toFixed(4)}% of the odds with no unpinned card to carry it.`,
      "Pin every card explicitly (the pins must then total exactly 100%), or clear a pin.",
    );
  }
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

  // ── Pin-adjusted residual targets ────────────────────────────────────
  // The FREE (unpinned) pool solves to the residual of every target: pinned
  // WIN-band shares count toward the requested win-rate (on a hard tag they
  // count toward the tag sum — the free winners absorb only the remainder),
  // pinned near-miss shares count toward the near-miss floor, and the pinned
  // EV is subtracted from the EV budget. With no pins every value below is
  // byte-identical to the legacy quantities (freeMass 1, pinned* 0).
  let freeWinTarget = hasPins
    ? Math.max(0, requestedWinRate - pinnedWinShare)
    : requestedWinRate;
  const evTargetFree = evTarget - pinnedEv;

  // ── Pins EV-bounds refusal (checked FIRST — before the band-structure
  // errors, whose legacy kinds would mis-name a budget the PINS blew) ──────
  // The free pool can only contribute `freeMass · [minValue, maxValue]` of
  // EV; when the pin-adjusted budget falls outside that, no band structure
  // could ever help — the pins over/under-shoot the EV budget and the
  // refusal quantifies by how much.
  if (
    hasPins &&
    (evTargetFree < freeMass * minValue - tol ||
      evTargetFree > freeMass * maxValue + tol)
  ) {
    const tooLowFree = evTargetFree < freeMass * minValue;
    const missEv = tooLowFree
      ? freeMass * minValue - evTargetFree
      : evTargetFree - freeMass * maxValue;
    const missPp = (missEv / price) * 100;
    return tooLowFree
      ? pinsRefusal(
          `the pins put too much value in the pool: even the cheapest layout of the unpinned cards leaves EV $${missEv.toFixed(4)} (≈${missPp.toFixed(3)}pp of edge) ABOVE the budget — the edge would land below the ${(targetEdge * 100).toFixed(2)}% target.`,
          `Lower a pinned win-card chance (free ~$${missEv.toFixed(4)} of EV), raise the price — or build the below-target experiment deliberately in Drafts.`,
        )
      : pinsRefusal(
          `the pins leave EV $${missEv.toFixed(4)} (≈${missPp.toFixed(3)}pp of edge) SHORT of the budget — the plan would land beyond the accepted margin above the ${(targetEdge * 100).toFixed(2)}% edge target.`,
          `Shift ~$${missEv.toFixed(4)} of EV into the pins (raise a pinned winner's chance or lower a pinned dust chance), or lower the price.`,
        );
  }

  // ── HARD limit 1: need at least one win/grail card to make ANY win-rate ──
  if (grail.length + win.length === 0 && hasPins && pinnedWinShare > tol) {
    // The pins carry win mass, so the pack DOES have winners — the legacy
    // "no winners" hard error would be wrong. If the pins already cover the
    // whole win target, nothing is missing; otherwise a SOFT win-rate relaxes
    // down to the pinned share, while a HARD tag refuses (the tag is exact
    // and no unpinned winner remains to absorb the shortfall).
    if (freeWinTarget > tol) {
      if (winRateIsHard) {
        return pinsRefusal(
          `the pinned winners carry only ${(pinnedWinShare * 100).toFixed(4)}% of the ${(requestedWinRate * 100).toFixed(2)}% tag and no unpinned winner remains to absorb the other ${(freeWinTarget * 100).toFixed(4)}pp.`,
          "Raise a pinned win-card chance (the win pins must total the tag), clear a win pin, or add a win-band card.",
        );
      }
      relaxations.push({
        lever: "winRate",
        requested: requestedWinRate,
        applied: pinnedWinShare,
        reason: `Every winner is pinned — the win-rate is the pinned ${(pinnedWinShare * 100).toFixed(2)}% (no unpinned winner left to host more).`,
      });
      freeWinTarget = 0;
    }
  } else if (grail.length + win.length === 0) {
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
    // FREE-pool quantities (legacy-identical without pins): the free win mass
    // on the cheapest free grail + the rest of the FREE mass on the cheapest
    // free non-grail, compared against the pin-adjusted EV budget.
    const minEvAtWinRate =
      freeWinTarget * cheapestGrail + (freeMass - freeWinTarget) * cheapestOther;
    if (minEvAtWinRate > evTargetFree + tol) {
      const exampleA = Math.max(price, 2 * price);
      const exampleB = Math.max(price, 4 * price);
      return {
        error: `No WIN-band card: ${grail.length} jackpot card(s) ≥ $${winHi.toFixed(2)} but none in $${winLo.toFixed(2)}–$${winHi.toFixed(2)}. At ${(freeWinTarget * 100).toFixed(2)}% win-rate the min EV $${minEvAtWinRate.toFixed(2)} exceeds the target EV $${evTargetFree.toFixed(2)}.`,
        feasibility: { ...feasibility, minEvAtWinRate, cheapestGrail, cheapestOther },
        limit: {
          kind: "no-win-band-card",
          detail: `Pool has ${grail.length} jackpot card(s) ≥ $${winHi.toFixed(2)} but no small-win card in $${winLo.toFixed(2)}–$${winHi.toFixed(2)}. With a ${(freeWinTarget * 100).toFixed(2)}% target win-rate, the math can't simultaneously hit the target edge ${(targetEdge * 100).toFixed(2)}% — even the cheapest jackpot (≈$${cheapestGrail.toFixed(2)}) carries too much value for the ${(freeWinTarget * 100).toFixed(2)}% win-rate.`,
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
  // With pins this can no longer be reached — the pin-adjusted bound check
  // above already returned the pins-infeasible arm — so the legacy error
  // below stays verbatim (freeMass 1, evTargetFree = evTarget without pins).
  if (
    evTargetFree < freeMass * minValue - tol ||
    evTargetFree > freeMass * maxValue + tol
  ) {
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
  // Pinned near-miss shares count toward the floor — the free pool only owes
  // the remainder (legacy-identical without pins).
  let nearMissMin = hasPins
    ? Math.max(0, requestedNearMissMin - pinnedNearMissShare)
    : requestedNearMissMin;
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
    // Price-independent variant (§Rule Set fix): a dust card demands
    // `price > 2·minValue` while a winner demands `price ≤ maxValue` — when
    // `2·minValue ≥ maxValue` the two demands are disjoint at EVERY price, so
    // no price move can ever clear this limit. Only a pool edit fixes it.
    const priceFree = 2 * minValue >= maxValue;
    return {
      error: "No dust cards (value < 0.5·price): nothing to carry the losing mass / EV slack.",
      feasibility,
      limit: {
        kind: "no-dust-cards",
        detail: priceFree
          ? `Pool has no DUST card (< $${dustHi.toFixed(2)}, half the $${price.toFixed(2)} price) — and no price can create one: the cheapest card ($${minValue.toFixed(2)}) is worth more than half the priciest ($${maxValue.toFixed(2)}), so every price either strips all winners or leaves no losers. Only a pool edit fixes this.`
          : `Pool has no DUST card (< $${dustHi.toFixed(2)}, half the $${price.toFixed(2)} price). The losing mass has nowhere to sit, so the house edge can't be shaped.`,
        suggestion: `Add one or more low-value cards priced under $${dustHi.toFixed(2)} (Builder/card editor) so the house edge has somewhere to sit.`,
        suggestedRange: { min: 0, max: dustHi },
        ...(priceFree ? { priceIndependent: true } : {}),
      },
    };
  }

  // ── SOFT relaxation: win-rate vs the available mass budget ──────────
  // A pack always needs SOME losing (dust) mass to carry the house edge. If win
  // + near-miss would consume (nearly) all the probability mass, the win-rate is
  // too high for this split — relax it DOWN to leave a small dust margin rather
  // than erroring.
  // The margin scales with the FREE mass (2% of it) so a nearly-fully-pinned
  // pool isn't forced to reserve more dust than the remainder even holds —
  // with no pins freeMass is 1 and this is the legacy 2% verbatim.
  const MIN_DUST_MARGIN = 0.02 * freeMass; // keep ≥2% (of the free mass) dust for the edge
  const winMassCeiling = freeMass - nearMissMin - MIN_DUST_MARGIN;
  // From here on `targetWinRate` is the FREE pool's win target (the pinned win
  // share rides on top; without pins it IS the requested target verbatim).
  let targetWinRate = freeWinTarget;
  if (targetWinRate > winMassCeiling) {
    const applied = Math.max(0, winMassCeiling);
    relaxations.push({
      lever: "winRate",
      requested: requestedWinRate,
      applied: applied + pinnedWinShare,
      reason: `Win-rate ${requestedWinRate} + near-miss ${nearMissMin} leave no dust mass for the house edge; relaxed to ${(applied + pinnedWinShare).toFixed(4)}.`,
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
      // Pin-adjusted linear bound over the FREE mass:
      //   evMinFree(wr) = wr·winCheap + nm·nmCheap + (freeMass−wr−nm)·dustCheap
      // solved against the pin-adjusted budget (legacy-identical without pins).
      const wrMaxForEv =
        (evTargetFree - nmMassForBound * nmCheap - (freeMass - nmMassForBound) * dustCheap) / denom;
      // Clamp into the valid range; the mass-budget ceiling already applied above.
      const wrCap = Math.max(0, Math.min(targetWinRate, wrMaxForEv));
      if (targetWinRate > wrCap + tol) {
        const existing = relaxations.find((r) => r.lever === "winRate");
        if (existing) {
          existing.applied = wrCap + pinnedWinShare;
          existing.reason = `Win-rate relaxed to ${(wrCap + pinnedWinShare).toFixed(4)} (requested ${requestedWinRate}); a higher win mass would pin EV above the ${(targetEdge * 100).toFixed(2)}% edge target.`;
        } else {
          relaxations.push({
            lever: "winRate",
            requested: requestedWinRate,
            applied: wrCap + pinnedWinShare,
            reason: `Win-rate relaxed to ${(wrCap + pinnedWinShare).toFixed(4)}; a higher win mass would pin EV above the ${(targetEdge * 100).toFixed(2)}% edge target.`,
          });
        }
        targetWinRate = wrCap;
      }
    }
  }

  // ── Band mass allocation ────────────────────────────────────────────
  // `winMass` and `dustMass` are NOT final here: the EV solve below may FLOAT
  // the win-rate UP (shifting mass from dust → win) when the target EV can't be
  // reached without it — the owner-mandated alternative to inflating jackpot
  // odds (owner rule #2). `nearMissMass` stays fixed (it's a feel dial).
  let winMass = targetWinRate;
  const nearMissMass = nearMiss.length > 0 ? nearMissMin : 0;
  let dustMass = freeMass - winMass - nearMissMass;
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
  // value ≥ price). The GRAIL/WIN split still exists for banding/labels; it just
  // doesn't fragment the win mass. UNLIKE the legacy solver, the win pool's β is
  // FLOORED at a positive value (`BETA_WIN_FLOOR`) so the within-win distribution
  // is always strictly DECREASING in value — the jackpot can never be inflated to
  // hit a high EV target (owner rule #1). `winMassTotal` tracks the (possibly
  // floated-up) win mass.
  const winPoolSlots = [...grail, ...win];
  const winPoolValues = winPoolSlots.map((s) => s.value);
  const nearMissValues = nearMiss.map((s) => s.value);
  const dustValues = dust.map((s) => s.value);
  const dustMin = Math.min(...dustValues);
  const dustMax = Math.max(...dustValues);

  // ── EV solve: ONE shared beta across the LOSS bands, win-pool beta FLOORED ──
  //
  // Each band lays out its probability MASS by value^(−β). The loss bands
  // (NEARMISS + free DUST) share β directly; the WIN+GRAIL pool uses
  // `max(β, BETA_WIN_FLOOR)` so its template is ALWAYS strictly decreasing in
  // value (β ≥ floor > 0 ⇒ the jackpot is the rarest pull, never inflated).
  // Each band mean is monotone DECREASING in β, and clamping the win β at a
  // floor only flattens its term BELOW the floor — so total EV is still monotone
  // non-increasing in β. We bisect β over [BETA_LO, BETA_HI].
  //
  // Owner rule #2 — when the FLOORED win pool can't reach a HIGH evTarget even
  // at β = BETA_LO (the win mass is too small to lift EV without skewing the
  // jackpot expensive, which we now forbid), we FLOAT THE WIN-RATE UP (shift
  // mass dust → win) rather than inflate jackpot odds. More winners ⇒ higher EV.
  // The float-up is computed up-front below (it changes the band masses the
  // floor reservation + the β solve operate on).

  // ── Win-pool distribution: steep base decay + per-card anti-inflation caps ──
  //
  // The win pool lays its mass out by a steep base power-law `value^(−BETA_WIN_FLOOR)`
  // (β ≥ 1.5 ⇒ strictly decreasing in value ⇒ the jackpot is the rarest winner —
  // owner rule #1's structural baseline). On top of that, when the caller supplies
  // `currentWeights`, EACH win/grail card is CAPPED at its CURRENT odds: a card
  // whose base-power-law share would EXCEED its live odds is held DOWN to the live
  // odds, and the freed mass WATER-FILLS onto the still-uncapped (cheaper) winners.
  // This is what a single β can't do: keep ultra-rare hand-tuned jackpots rare
  // AND let the generous mid-tier winners carry the win mass (e.g. the $20.50 pack
  // — Charizard pinned at ≤ 0.15%, the $46/$24/$20 winners absorb the rest). The
  // result is a strictly-decreasing, never-inflating distribution that ISN'T a
  // power law.
  //
  // EV is reached by FLOATING THE WIN-RATE UP (owner rule #2): more cheap winners
  // raise EV without ever enlarging a jackpot's odds. We never skew the jackpot
  // expensive to hit EV — that knob is gone.
  // Scaled by the FREE mass (legacy-identical without pins) — see MIN_DUST_MARGIN.
  const MIN_DUST_MASS_FLOAT = 0.02 * freeMass; // never float win mass past leaving 2% dust
  const structuralCeil = freeMass - nearMissMass - MIN_DUST_MASS_FLOAT;

  const cur = input.currentWeights;
  let curTotal = 0;
  if (cur && cur.length === input.cards.length) {
    for (const w of cur) if (Number.isFinite(w) && w > 0) curTotal += w;
  }
  const anchorActive = curTotal > 0 && winPoolSlots.length >= 1;
  // CURRENT odds (fraction of the WHOLE pool) per win-pool card. The per-card
  // cap: a win card's final pool-odds must not exceed this.
  //
  // NEW-CARD ANCHOR EXEMPTION ([math LAW 6]): a card with ZERO/absent current
  // weight — a card being staged INTO the pool — has no advertised odds to
  // protect, so it enters UNCAPPED (`Infinity`), not capped at 0. The old
  // `: 0` made "add a win/grail card" a structural no-op under a hard tag
  // (the new card's cap pinned it at zero mass — verified D3). Never-inflate
  // still protects every EXISTING card verbatim, and the grail monotone
  // running-min below still bounds a NEW grail at the next-cheaper EXISTING
  // grail's odds (an `Infinity` never tightens a neighbor).
  const beforeOddsWin = anchorActive
    ? winPoolSlots.map((slot) => {
        const w = cur![slot.idx];
        return Number.isFinite(w) && w! > 0 ? w! / curTotal : Infinity;
      })
    : winPoolSlots.map(() => Infinity); // no anchor ⇒ no caps

  // MONOTONE caps on the EXPENSIVE TAIL (owner rule #1). The owner's hard rule
  // targets the JACKPOT / expensive tail: "raising the edge must only TRIM the
  // expensive tail, never inflate it; the top card's odds must not increase." So
  // we enforce a strictly-DECREASING, never-inflating cap profile on the GRAIL
  // band (value ≥ 5·price — the jackpot tail): walking those cards value-ascending,
  // `monoCap_i = min(beforeOdds_i, monoCap_of_next_cheaper_grail)`, a non-increasing
  // profile so the water-fill can't invert the tail. The WIN band (price ≤ value
  // < 5·price) keeps its OWN per-card before-odds cap WITHOUT the monotone tighten:
  // real packs are deliberately NON-monotone there (e.g. the $20.50 pack — the
  // cheap $20.53 winner rarer than the pricier, more-featured $24.43), and forcing
  // strict monotonicity across the whole win band would discard the mid-tier EV
  // those cards carry and make a third of the catalog infeasible. Every win card
  // still never exceeds its own current odds (owner rule #1's "never inflate"),
  // and the jackpot tail stays strictly rare — the actual flaw being fixed.
  const grailThreshold = 5 * price;
  const grailAsc = winPoolSlots
    .map((s, i) => ({ i, v: s.value }))
    .filter((x) => x.v >= grailThreshold)
    .sort((a, b) => a.v - b.v);
  const monoCap = beforeOddsWin.slice();
  if (anchorActive && grailAsc.length > 0) {
    let runningMin = Infinity;
    for (const { i } of grailAsc) {
      runningMin = Math.min(runningMin, beforeOddsWin[i]!);
      monoCap[i] = runningMin;
    }
  }

  // EV-BALANCE exemption for the CHEAPEST winner (SOFT-win-rate packs only).
  // The never-inflate caps target the jackpot / expensive tail. The single
  // CHEAPEST win/grail card is the OPPOSITE of a jackpot — making it more common
  // LOWERS variance, never raises the house's drawdown — so it is the natural
  // sink for the EV-balancing mass AND for the win-rate float-up. Capping it at
  // its (possibly tiny) current odds is what made low-EV packs infeasible. We
  // exempt it (its odds may rise) so the solver can concentrate win mass there to
  // reach evTarget — keeping the expensive tail strictly rare and never-inflated.
  //
  // GATED on `winRateIsHard === false`: for a TAGGED pack the win-rate IS the
  // designed hit-rate (the "X%" tag) and must NOT drift — its big jackpots carry
  // the EV at the tag rate, so the live (capped) distribution is the right answer
  // and the float-up must stay off. Exempting + floating there would push a "5% …"
  // pack to ~25% wins. So tagged packs keep ALL caps (no exemption) and do NOT
  // float (see the float-up gate below). Owner-safe either way: the top card and
  // every pricier card stay capped. (`winRateIsHard` is hoisted above the pin
  // validation — the tag-overshoot refusal needs it before the slot pass.)
  //
  // ALSO gated OFF under `holdWinRateHard` (untagged retune spike fix): exempting
  // the cheapest winner makes it an UNCAPPED SINK, and with the win-rate pinned at
  // design the solver dumps win mass onto that one card — the mid-pool spike. With
  // the exemption skipped the cheapest winner keeps its own current-odds cap; EV is
  // reached by `winBeta` steepening within the caps + `disperseLoss`, giving a
  // clean monotonic ladder. (Soft `holdWinRate` KEEPS the exemption — it needs the
  // sink to float toward the +5pp band; only the HARD hold removes it.)
  //
  // LAW M (Retune V3): the sink stays a legal LEVER here — it often lands a
  // perfectly lawful ladder (the cheapest winner rises but stays under the
  // near-miss share: Three Blades, Captive's crush). What it may no longer do
  // on the retune path is SHIP a zigzag: the end-of-solve
  // `enforceMonotoneLadderLawM` gate re-lays any sink overshoot at the same
  // landed EV/mass, or refuses typed (`monotone-unreachable`) when no lawful
  // ladder exists (Love Cycle's 30%-over-10% shape). Legality is enforced at
  // the boundary, not by removing the lever.
  if (
    anchorActive &&
    winPoolSlots.length > 0 &&
    !winRateIsHard &&
    !holdWinRateHard
  ) {
    let cheapestWinIdx = 0;
    let cheapestWinVal = Infinity;
    for (let i = 0; i < winPoolSlots.length; i++) {
      if (winPoolSlots[i]!.value < cheapestWinVal) {
        cheapestWinVal = winPoolSlots[i]!.value;
        cheapestWinIdx = i;
      }
    }
    monoCap[cheapestWinIdx] = Infinity;
  }

  // SATURATION ceiling: the most win mass that fits UNDER the (monotone) per-card
  // caps is their sum — beyond it, some card MUST inflate above its current odds.
  // When anchored, the float-up is capped at this saturation point (clamped into
  // the structural dust-margin ceiling, never below the requested win mass) so
  // the float never runs away into the residual-spill (which would re-inflate the
  // jackpot AND blow up win EV). Unanchored ⇒ the structural ceiling (legacy).
  let capSum = 0;
  if (anchorActive) for (const c of monoCap) capSum += c;
  // POST-SOLVE WIN-RATE HOLD (owner-lens item 4): for a SOFT (untagged) anchored
  // pack the cheapest winner is EV-exempt (`monoCap` Infinity), so `capSum` is
  // Infinity and the float ceiling collapses to the structural dust margin — the
  // win-rate floats far above the pack's live-anchored design (30%→37.5% on Three
  // Blades). Cap the float ceiling at `targetWinRate + WINRATE_HOLD_BAND` (+5pp)
  // so the shaped win mass holds within the band of the design. Never below
  // `winMass` (the requested target stays the FLOOR — the float can still rise
  // toward the band to reach the edge). TAGGED packs (`winRateIsHard`) don't
  // float, so the hold is a no-op there; the clamp only ever LOWERS the ceiling.
  //
  // FEASIBILITY-SAFE via the price search, NOT a per-price yield: at a single
  // price a pool may need MORE than `band` winners to hit the edge (Three Blades
  // at $113.52 needs 37.5% — the 28% near-miss band on the cheap $80.72 card
  // starves the EV). Holding there makes the edge unreachable ⇒ the solve
  // errors at THAT price. `searchBestPriceForCleanSnap` then moves the ticket a
  // few cents (Three Blades → $108.83, held 34.3%) where the band-held win-rate
  // DOES reach the edge — a clean plan. When NO in-budget price admits a
  // band-held solve (Trash / Echoes / Snack Time — the loss side is a single
  // near-zero carrier), every candidate errors and the pack surfaces as the
  // wide-probe price-move / pool-edit path (owner-lens item 4's "coherent
  // pool-edit path" for a truly-infeasible dead-end) — never a floated-up plan.
  const winHoldCeil =
    anchorActive && holdWinRate
      ? Math.max(winMass, targetWinRate + WINRATE_HOLD_BAND)
      : Infinity;
  const winMassCeil = anchorActive
    ? Math.min(structuralCeil, Math.max(winMass, capSum), winHoldCeil)
    : Math.max(winMass, structuralCeil);

  // The win pool's steepness β. Baseline `BETA_WIN_FLOOR`; the EV solve may
  // STEEPEN it (raise β) to LOWER the win-pool EV when the fixed capped EV
  // overshoots a low evTarget. Steepening only ever makes the jackpot RARER
  // (more mass on the cheapest winners), so it never violates owner rule #1 —
  // it's the one EV knob that's safe to keep. The cap on how steep: the
  // module-level BETA_WIN_MAX (shared with the tag-guidance interval).
  let winBeta = BETA_WIN_FLOOR;

  // Distribute `wm` (the win mass) across the win pool by a value^(−β) power-law
  // (β = `betaArg`), capping each card at its monotone cap (absolute pool-odds)
  // and WATER-FILLING the overflow onto uncapped cards (module-level
  // `waterFillBandProbs` — shared with the tag-guidance interval). Any residual
  // that can't fit under the caps is reported via `placed < wm` so the caller
  // can flag unavoidable spillover.
  let topInflationUnavoidable = false;
  const winPoolProbsForBeta = (
    wm: number,
    betaArg: number,
  ): { probs: number[]; placed: number } =>
    waterFillBandProbs(winPoolValues, monoCap, wm, betaArg);
  const winPoolProbsFor = (wm: number) => winPoolProbsForBeta(wm, winBeta);

  // EV from the win pool at win mass `wm` and steepness `winBeta`.
  const winPoolEvAt = (wm: number): number => {
    const { probs } = winPoolProbsFor(wm);
    let ev = 0;
    for (let i = 0; i < winPoolValues.length; i++) ev += probs[i]! * winPoolValues[i]!;
    return ev;
  };

  // MAX EV the pool can produce at a given win mass without inflating the
  // jackpot: win pool capped-distributed + loss bands skewed EXPENSIVE (BETA_LO).
  const maxEvAtWinMass = (wm: number): number => {
    const dm = freeMass - wm - nearMissMass;
    return (
      winPoolEvAt(wm) +
      nearMissMass * bandEvForBeta(nearMissValues, BETA_LO) +
      Math.max(0, dm) * bandEvForBeta(dustValues, BETA_LO)
    );
  };

  // Float the win-rate UP until the max (non-inflating) EV reaches the FREE
  // pool's budget (`evTargetFree` — legacy-identical to evTarget without pins).
  // EV is monotone increasing in win mass (winners pay ≥ price > the dust they
  // displace), so bisect. Capped at `winMassCeil` (2% dust margin, and — for a
  // SOFT anchored pack — the WIN-RATE HOLD band; see `winHoldCeil`). ONLY on the
  // ANCHORED path (`anchorActive`) and when the win-rate is SOFT — the legacy
  // value-only path keeps the original single-β solve (no float-up); tagged packs
  // hit EV via their big jackpots at the tag rate, never by adding winners.
  // ALSO gated OFF under `holdWinRateHard` (untagged retune spike fix): the win
  // mass stays PINNED at design `targetWinRate` — no float at all. EV is instead
  // reached by the (unconditional) `winBeta` steepening below, within the
  // anti-inflation caps + `disperseLoss`. (Soft `holdWinRate` still floats, up to
  // the +5pp `winMassCeil` band.)
  if (
    anchorActive &&
    !winRateIsHard &&
    !holdWinRateHard &&
    maxEvAtWinMass(winMass) < evTargetFree - 1e-9 &&
    winMassCeil > winMass
  ) {
    if (maxEvAtWinMass(winMassCeil) < evTargetFree - 1e-9) {
      winMass = winMassCeil; // best effort; downstream feasibility check surfaces it
    } else {
      let wmLo = winMass;
      let wmHi = winMassCeil;
      for (let i = 0; i < 60; i++) {
        const mid = (wmLo + wmHi) / 2;
        if (maxEvAtWinMass(mid) < evTargetFree) wmLo = mid;
        else wmHi = mid;
      }
      winMass = wmHi;
    }
  }
  dustMass = freeMass - winMass - nearMissMass;
  if (winMass > targetWinRate + 1e-9) {
    relaxations.push({
      lever: "winRate",
      requested: requestedWinRate,
      applied: winMass + pinnedWinShare,
      reason: `Win-rate floated UP to ${((winMass + pinnedWinShare) * 100).toFixed(2)}% so the edge target is met by adding cheap winners instead of inflating jackpot odds (owner rule: keep the expensive tail rare).`,
    });
  }

  // STEEPEN the win pool to LOWER its EV when the fixed capped EV overshoots a
  // low evTarget. The win-pool EV is otherwise fixed (no β knob), so on a pool
  // whose loss bands have little spread (e.g. a lottery pack with one dust card)
  // the MINIMUM total EV — win-pool EV + loss bands skewed cheap (BETA_HI) — can
  // sit just ABOVE evTarget, making it infeasible by a hair. Raising `winBeta`
  // shifts win mass onto the CHEAPEST winners, lowering the win-pool EV (and
  // making the jackpot even rarer — fully owner-rule-#1-safe). Bisect winBeta in
  // [BETA_WIN_FLOOR, BETA_WIN_MAX] so the minimum total EV reaches evTarget.
  const minTotalEvAt = (): number =>
    winPoolEvAt(winMass) +
    nearMissMass * bandEvForBeta(nearMissValues, BETA_HI) +
    Math.max(0, dustMass) * bandEvForBeta(dustValues, BETA_HI);
  if (anchorActive && minTotalEvAt() > evTargetFree + 1e-9) {
    // winPoolEvAt is monotone DECREASING in winBeta (steeper ⇒ cheaper winners).
    let bLo = BETA_WIN_FLOOR;
    let bHi = BETA_WIN_MAX;
    const evAtBeta = (b: number): number => {
      winBeta = b;
      return minTotalEvAt();
    };
    if (evAtBeta(BETA_WIN_MAX) <= evTargetFree + 1e-9) {
      for (let i = 0; i < 60; i++) {
        const mid = (bLo + bHi) / 2;
        if (evAtBeta(mid) > evTargetFree) bLo = mid;
        else bHi = mid;
      }
      winBeta = bHi; // steepest needed to bring min EV down to target (from above)
    } else {
      winBeta = BETA_WIN_MAX; // even the steepest can't reach — best effort
    }
  }

  // Final win-pool probabilities at the chosen win mass + steepness + flag any
  // spillover the per-card caps couldn't absorb (mathematically-unavoidable
  // inflation).
  const winSolved = winPoolProbsFor(winMass);
  if (winSolved.placed < winMass - 1e-9) {
    // The caps couldn't hold the whole win mass — some card MUST rise above its
    // current odds. Spill the residual proportionally onto the win pool by the
    // (current-steepness) power-law (keeps it strictly decreasing) and flag it.
    topInflationUnavoidable = true;
    const residual = winMass - winSolved.placed;
    const spillRaw = winPoolValues.map((v) => Math.pow(v, -winBeta));
    const rawSum = spillRaw.reduce((a, b) => a + b, 0);
    if (rawSum > 0) {
      for (let i = 0; i < winSolved.probs.length; i++) {
        winSolved.probs[i] = winSolved.probs[i]! + (spillRaw[i]! / rawSum) * residual;
      }
    }
  }
  // Per-card win-pool FRACTIONAL weights (absolute pool-prob), used directly in
  // the stitch below instead of a single-β power-law layout.
  const winPoolProbs = winSolved.probs;

  const winMassTotal = winMass;

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

  // EV total for a shared loss-band beta, INCLUDING the reserved floor card's
  // fixed share.
  //
  // ANCHORED path (`currentWeights` supplied): the WIN+GRAIL pool's EV is FIXED
  // by the per-card-capped distribution above (it is no longer a β knob — that's
  // how the jackpot stays rare regardless of the EV target); only the loss bands
  // move with β. LEGACY value-only path (`!anchorActive`): the win pool laid out
  // by the SAME shared β as the loss bands (the original behavior) — there are no
  // current odds to protect, so the single-β solve is preserved unchanged for the
  // scenario builder / harness. Loss-band (and, in the legacy case, win-pool)
  // means are monotone DECREASING in β, so the total is monotone and the
  // bisection below is valid.
  let winPoolEvFixed = (() => {
    let ev = 0;
    for (let i = 0; i < winPoolValues.length; i++) ev += winPoolProbs[i]! * winPoolValues[i]!;
    return ev;
  })();
  const floorEvFixed = floorSlot ? floorMass * floorSlot.value : 0;
  // `pinnedEv` rides on top (0 without pins): evMin/evMax and the bisection
  // below therefore operate on FULL-pool EV, so every downstream comparison
  // against `evTarget` (the RC4 knob, the one-sided-up acceptance, the
  // ev-unreachable window) is pin-aware without further changes.
  const totalEvForBeta = (beta: number): number =>
    pinnedEv +
    (anchorActive
      ? winPoolEvFixed
      : winMassTotal * bandEvForBeta(winPoolValues, beta)) +
    nearMissMass * bandEvForBeta(nearMissValues, beta) +
    freeDustMass * bandEvForBeta(freeDustValues, beta) +
    floorEvFixed;

  let evMax = totalEvForBeta(BETA_LO);
  let evMin = totalEvForBeta(BETA_HI);

  // ── Saturated hard-tag EV knob (RC4) ────────────────────────────────
  // ANCHORED + HARD-TAG pools have (near) zero EV freedom: every winner is
  // capped at its current odds (never-inflate), the tag pins the win mass, no
  // float-up — so on a typical lottery pool (no near-miss band, little dust
  // spread) the reachable EV collapses to a point and the audit measured 28/37
  // tagged packs erroring here for a miss of fractions of a cent.
  //
  // The ONE EV knob that cannot inflate the expensive tail: interpolate the
  // capped win distribution toward "all tag mass on the CHEAPEST winner".
  // For t ∈ [0,1]: every non-cheapest winner keeps t·(its capped share) and
  // the remainder concentrates on the cheapest winner, so
  //   • total win mass stays pinned at the tag (win-rate unchanged),
  //   • every jackpot / non-cheapest winner's odds only ever DROP (t ≤ 1),
  //   • the grail tail keeps its strictly-decreasing profile (uniform scale,
  //     and the extra mass lands on the pool's cheapest card),
  //   • the cheapest winner — the anti-jackpot, the same card the SOFT path's
  //     cap exemption already privileges — is the only card that rises.
  // Win-pool EV is LINEAR in t, so solve directly for the t that puts the
  // reachable minimum exactly at evTarget (loss bands then sit at their
  // cheapest skew; the β bisection below converges to that point). Only runs
  // on the previously-hard-erroring side (evTarget below the reachable min);
  // if even t=0 (the whole tag mass on the cheapest winner) leaves EV above
  // target, the honest ev-unreachable error below still fires.
  if (
    anchorActive &&
    winRateIsHard &&
    evTarget < evMin - 1e-6 &&
    winPoolValues.length > 1 &&
    winMassTotal > 0
  ) {
    let cheapIdx = 0;
    for (let i = 1; i < winPoolValues.length; i++) {
      if (winPoolValues[i]! < winPoolValues[cheapIdx]!) cheapIdx = i;
    }
    const lossEvMin = evMin - winPoolEvFixed; // loss bands + floor at their cheapest skew
    const winEvNeeded = evTarget - lossEvMin; // win-pool EV that puts the reachable min AT target
    const winEvAtT0 = winMassTotal * winPoolValues[cheapIdx]!; // all win mass on the cheapest winner
    const winEvAtT1 = winPoolEvFixed;
    if (winEvNeeded >= winEvAtT0 - 1e-9 && winEvAtT1 - winEvAtT0 > 1e-12) {
      const t = Math.min(
        1,
        Math.max(0, (winEvNeeded - winEvAtT0) / (winEvAtT1 - winEvAtT0)),
      );
      let others = 0;
      for (let i = 0; i < winPoolProbs.length; i++) {
        if (i === cheapIdx) continue;
        winPoolProbs[i] = winPoolProbs[i]! * t;
        others += winPoolProbs[i]!;
      }
      winPoolProbs[cheapIdx] = Math.max(0, winMassTotal - others);
      let ev = 0;
      for (let i = 0; i < winPoolValues.length; i++) {
        ev += winPoolProbs[i]! * winPoolValues[i]!;
      }
      winPoolEvFixed = ev;
      evMax = totalEvForBeta(BETA_LO);
      evMin = totalEvForBeta(BETA_HI);
    }
  }

  // ── One-sided-UP acceptance (hard tags only — kills the RC4 error wall) ──
  // `evTarget > evMax` means the pool's reachable EV tops out BELOW the target
  // EV, i.e. the achieved edge at β = BETA_LO lands ABOVE the target — the
  // HOUSE-FAVORABLE side. For an anchored hard-tag pool (caps + tag pin the EV
  // to nearly a point) this was a hard error even when the miss was fractions
  // of a cent. Accept it when the edge excess is within
  // {@link ONE_SIDED_EDGE_EXCESS_TOL} (0.25pp): the β bisection below then
  // converges to BETA_LO (EV = evMax), the bump loop has nothing to do (edge
  // already ≥ target), and the excess is reported on the success result. The
  // `evTarget < evMin` side (edge would land BELOW target) still errors — the
  // floor is sacred.
  const oneSidedEdgeExcess =
    winRateIsHard && evTarget > evMax + 1e-6 && evMax > 0
      ? 1 - evMax / price - targetEdge
      : null;
  const oneSidedAccepted =
    oneSidedEdgeExcess !== null &&
    oneSidedEdgeExcess <= ONE_SIDED_EDGE_EXCESS_TOL + 1e-12;

  if ((evTarget < evMin - 1e-6 || evTarget > evMax + 1e-6) && !oneSidedAccepted) {
    if (hasPins) {
      // Pins arm (ruleset: every pin error carries a computable suggestion —
      // how much the pins over/under-shoot EV, in $ AND pp of edge).
      const tooHigh = evTarget < evMin; // reachable EV floor sits ABOVE budget
      const missEv = tooHigh ? evMin - evTarget : evTarget - evMax;
      const missPp = (missEv / price) * 100;
      return {
        error: `Pinned odds are infeasible: with the pins held, this pool reaches EV $${evMin.toFixed(4)}–$${evMax.toFixed(4)} but the ${(targetEdge * 100).toFixed(2)}% edge target needs EV $${evTarget.toFixed(4)}.`,
        feasibility: {
          ...feasibility,
          evReachable: { min: evMin, max: evMax },
          bands: { winMass: winMassTotal, nearMissMass, dustMass, floorMass },
          pinned: { pinnedMass, pinnedEv, pinnedWinShare },
          dustMin,
          dustMax,
        },
        limit: {
          kind: "pins-infeasible",
          detail: tooHigh
            ? `The pins put too much chance on expensive cards: even the cheapest layout of the unpinned cards leaves EV $${missEv.toFixed(4)} (≈${missPp.toFixed(3)}pp of edge) above the budget — the edge would land BELOW the ${(targetEdge * 100).toFixed(2)}% target.`
            : `The pins leave EV $${missEv.toFixed(4)} (≈${missPp.toFixed(3)}pp of edge) short of the budget — the plan would land beyond the accepted margin ABOVE the ${(targetEdge * 100).toFixed(2)}% edge target.`,
          suggestion: tooHigh
            ? `Lower a pinned win-card chance (free ~$${missEv.toFixed(4)} of EV), raise the price — or build the below-target experiment deliberately in Drafts.`
            : `Shift ~$${missEv.toFixed(4)} of EV into the pins (raise a pinned winner's chance or lower a pinned dust chance), or lower the price.`,
        },
      };
    }
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
          anchorActive && winRateIsHard
            ? // Saturated anchored+hard-tag pools: the win pool is pinned at
              // current odds (never-inflate) and the tag pins the win mass.
              // The RC4 EV knob above already tried concentrating the tag mass
              // on the cheapest winner — reaching here means even THAT leaves
              // EV out of range, so the honest remedies are a cheaper WIN-band
              // card (lowers the concentration floor), a price move (the
              // retune price search sweeps the ±60% band automatically) or a
              // different edge target.
              evTarget < evMin
              ? `Even concentrating the whole ${(requestedWinRate * 100).toFixed(2)}% tag mass on the cheapest winner leaves EV above the target — this pool's winners are too expensive for the tag at this price. Add a cheap WIN-band card just above $${winLo.toFixed(2)}, let the retune price search pick a different price, or adjust the edge target.`
              : `The win pool is capped at its current odds (never-inflate) and the tag fixes the win mass, so EV cannot be lifted to the target at this price. Let the retune price search pick a lower price, or adjust the edge target.`
            : evTarget > evMax
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

  // Win pool layout. ANCHORED: the PER-CARD-CAPPED distribution (strictly
  // decreasing, jackpot rarest, never above current odds) — NOT a single-β power
  // law. LEGACY value-only: the original single-β power law (`sharedBeta`). Loss
  // bands always use the raw shared beta from the EV solve.
  const winPoolW = anchorActive
    ? winPoolProbs
    : bandWeights(winPoolValues, sharedBeta, winMassTotal);
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

  // ── LOSS-MASS DISPERSION (owner-lens item 10) ───────────────────────────
  // The single-β loss layout hits the exact EV but is indifferent between a
  // live-like spread and a one-carrier crush: on ~60 fleet packs it parks a
  // live-≥5% loss card at the quantization floor while one carrier absorbs
  // (nearly) all the loss mass. Re-spread the WHOLE loss band — every card BELOW
  // price (near-miss + free dust + the reserved floor modal) — at the SAME
  // combined mass + EV: `disperseLossBand` returns the min-L2 (affine-in-value)
  // vector, the flattest layout keeping those two invariants.
  //
  // WHY the WHOLE band (not per-band): the crush routinely spans the near-miss /
  // dust boundary (a live-≥5% near-miss card starved while the dust carrier
  // absorbs, and vice versa), so a per-band spread leaves 24 of the 25 fixable
  // crushes untouched. Dispersing the whole loss band at once is what actually
  // loosens them.
  //
  // EDGE + WIN-RATE ARE PRESERVED: the loss band's TOTAL mass AND TOTAL EV are
  // held exactly, so at a FIXED price the pack's EV — and therefore its edge —
  // is unchanged, and the WIN mass (win-rate) is untouched (only loss cards
  // move). The downstream integer quantize + one-sided-up edge bump may re-land
  // the edge a hair differently (always ≥ target, within the snap tolerance) and
  // the price search may then pick a different — but equally valid, edge ≥ target
  // AND ≥ live-slack — clean price; both are the existing acceptance envelope,
  // not a new skew. Where the loss average is EV-forced near the band max
  // (Captive), the affine solution clamps to the same one-carrier shape and this
  // is a no-op — the pool-edit path owns that case. Opt-in (`disperseLoss`); every
  // legacy direct caller stays byte-identical.
  if (disperseLoss) {
    const lossSlots: Slot[] = [];
    for (const s of slots) {
      if (s.value > 0 && s.value < price && frac[slotPos.get(s)!]! > 0) {
        lossSlots.push(s);
      }
    }
    if (lossSlots.length >= 2) {
      const lossValues = lossSlots.map((s) => s.value);
      const lossW = lossSlots.map((s) => frac[slotPos.get(s)!]!);
      let lossMassSum = 0;
      for (const w of lossW) lossMassSum += w;
      let adopted = disperseLossBand(lossValues, lossW, lossMassSum);
      // NEAR-MISS PRESERVATION (owner incident "Tails?", 2026-07-06): the
      // affine dispersal is near-miss-blind — on a pool whose loss mean sits
      // low it DRAINS the designed near-miss band into the dust (live-10%
      // near-miss card planned at 4%, no diagnostic). When the dispersed
      // near-miss band lands materially below its allocated input mass, try
      // the near-miss-preserving layout instead (same exact mass + EV ⇒
      // edge/win-rate/tag untouched; monotone by construction so the later
      // enforceLossMonotone pass has nothing to pull down). Adopted only when
      // it genuinely rescues near-miss mass; any residual shortfall is
      // reported as a `nearMiss` relaxation at the end of the solve.
      const nmLo = 0.5 * price;
      let inputNm = 0;
      let dispersedNm = 0;
      for (let i = 0; i < lossSlots.length; i++) {
        if (lossValues[i]! >= nmLo) {
          inputNm += lossW[i]!;
          dispersedNm += adopted[i]!;
        }
      }
      if (inputNm > 0 && dispersedNm < inputNm - NEARMISS_PRESERVE_TOL) {
        const rescued = preserveNearMissLossLayout({
          values: lossValues,
          weights: lossW,
          nearMissLo: nmLo,
        });
        if (rescued !== null) {
          let rescuedNm = 0;
          for (let i = 0; i < lossSlots.length; i++) {
            if (lossValues[i]! >= nmLo) rescuedNm += rescued[i]!;
          }
          if (rescuedNm > dispersedNm + NEARMISS_PRESERVE_TOL) {
            adopted = rescued;
          }
        }
      }
      // LADDER-SANDWICH FLATTEN (owner incident "OG Set", 2026-07-06): on a
      // tight loss-EV budget the affine dispersal starves the MOST EXPENSIVE
      // loss card relative to the cheaper chain (win-bottom 15% → dust 5% →
      // 20% → 34.5%: the 5% reads as a hole in the ladder). When the loss
      // chain's top card lands materially below the cheapest planned card of
      // the band above it, try the uniform-level layout — the closed-form
      // MAXIMUM that top card can carry at fixed mass + EV with a monotone
      // chain — and adopt it when it materially raises the top. Same hard
      // invariants as the near-miss rescue (exact mass + EV, monotone,
      // buffer argmax, no new floor-pins); if the rescue already ran, the
      // layouts coincide and this is a no-op.
      {
        let aboveBottom = 0;
        let aboveValue = Infinity;
        for (const s of slots) {
          const f = frac[slotPos.get(s)!]!;
          if (s.value >= price && f > 0 && s.value < aboveValue) {
            aboveValue = s.value;
            aboveBottom = f;
          }
        }
        let buf = 0;
        for (let i = 1; i < lossSlots.length; i++) {
          if (
            lossW[i]! > lossW[buf]! ||
            (lossW[i]! === lossW[buf]! && lossValues[i]! < lossValues[buf]!)
          ) {
            buf = i;
          }
        }
        let top = -1;
        for (let i = 0; i < lossSlots.length; i++) {
          if (i === buf) continue;
          if (top === -1 || lossValues[i]! > lossValues[top]!) top = i;
        }
        if (
          Number.isFinite(aboveValue) &&
          top !== -1 &&
          adopted[top]! + LOSS_FLATTEN_DIP_TOL < aboveBottom
        ) {
          const flattened = preserveNearMissLossLayout({
            values: lossValues,
            weights: lossW,
            nearMissLo: nmLo,
          });
          if (
            flattened !== null &&
            flattened[top]! > adopted[top]! + NEARMISS_PRESERVE_TOL
          ) {
            // NEAR-MISS GUARD: the flatten caps the near-miss band at its
            // INPUT allocation, but the affine dispersal it replaces may have
            // (blindly) overfunded that band ABOVE the requested floor — and
            // that overfunding can be what keeps the pack on its ask (fleet:
            // "Bright Water" 20.1% → 15.0% vs ask 16.6%). Aesthetics never
            // outrank the near-miss dial: adopt only when the flatten does
            // not materially reduce the near-miss mass the dispersal landed.
            let flatNm = 0;
            let adoptedNm = 0;
            for (let i = 0; i < lossSlots.length; i++) {
              if (lossValues[i]! >= nmLo) {
                flatNm += flattened[i]!;
                adoptedNm += adopted[i]!;
              }
            }
            if (flatNm >= adoptedNm - NEARMISS_PRESERVE_TOL) {
              adopted = flattened;
            }
          }
        }
      }
      lossSlots.forEach((s, i) => {
        frac[slotPos.get(s)!] = adopted[i]!;
      });
    }
  }

  const weights = new Array<number>(input.cards.length).fill(0);
  const cardsForRisk = (): CardLite[] =>
    input.cards.map((c, i) => ({ value: c.value, weight: weights[i]! }));
  let risk: PackRisk;

  if (!hasPins) {
    // ── Integer quantize (legacy, no pins) ──────────────────────────────
    // Scale ×1e6 (not ×1e4) so every weight is large: this makes the +1 edge-
    // correction bump below a TINY relative step, so the one-sided-up loop can
    // land the edge just above target without overshooting past target+0.001. A
    // single +1 on a small pool would otherwise be a coarse jump. We gcd-reduce
    // only at the very END (after bumping) to keep weights minimal.
    const QUANT = 1_000_000;
    slots.forEach((s, i) => {
      weights[s.idx] = Math.max(1, Math.round(frac[i]! * QUANT));
    });

    // ── One-sided-UP edge enforcement ───────────────────────────────────
    // Quantization can nudge EV up (edge below target). Bumping the CHEAPEST dust
    // card's weight is monotone: more mass on a cheap card lowers EV → raises edge.
    // We step by an adaptive amount (halving on overshoot risk) so we converge to
    // edge ∈ [target, target+0.001] quickly, capped at MAX_BUMPS iterations.
    const cheapestDustIdx = dust.reduce(
      (best, s) => (s.value < input.cards[best]!.value ? s.idx : best),
      dust[0]!.idx,
    );

    risk = computePackRisk({ cards: cardsForRisk(), price });
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
  } else {
    // ── Pinned integer grid (PIN_SCALE = 1e9, total EXACTLY PIN_SCALE) ───
    // Pins are laid down as EXACT integer units; the free solve's fractional
    // vector fills the remaining units, with the LARGEST free slot absorbing
    // the rounding so the total stays exactly PIN_SCALE — a pinned share can
    // therefore never drift (weight_i / Σweights ≡ share_i). The legacy bump
    // loop would grow the total and dilute the pins, so edge landing happens
    // via an integer mass TRANSFER inside the FREE dust band instead (the
    // same analytic move the tagged per-100k snap uses): total, win mass and
    // near-miss mass all stay fixed while EV moves by x·(vHi−vLo)/PIN_SCALE.
    for (const [idx, share] of pinnedShareByIdx) {
      weights[idx] = Math.round(share * PIN_SCALE);
    }
    let pinnedUnitsTotal = 0;
    for (const [idx] of pinnedShareByIdx) pinnedUnitsTotal += weights[idx]!;
    const freeUnitsTarget = PIN_SCALE - pinnedUnitsTotal;
    let freeSum = 0;
    let bufIdx = -1;
    slots.forEach((s, i) => {
      const u = Math.max(1, Math.round(frac[i]! * PIN_SCALE));
      weights[s.idx] = u;
      freeSum += u;
      if (bufIdx < 0 || u > weights[bufIdx]!) bufIdx = s.idx;
    });
    const bufAdjusted = bufIdx >= 0 ? weights[bufIdx]! + (freeUnitsTarget - freeSum) : 0;
    if (bufIdx < 0 || bufAdjusted < 1) {
      return pinsRefusal(
        `the pins leave too little room (${(freeMass * 100).toFixed(6)}%) for the ${slots.length} unpinned card(s) to keep non-zero odds.`,
        "Lower a pinned chance, or clear a pin.",
      );
    }
    weights[bufIdx] = bufAdjusted;
    risk = computePackRisk({ cards: cardsForRisk(), price });

    // Accepted landing window: the same [target, target+0.001] the legacy bump
    // targets, extended by the one-sided-up excess when that acceptance fired.
    const eLo = targetEdge - 1e-9;
    const eHi =
      targetEdge +
      0.001 +
      (oneSidedAccepted && oneSidedEdgeExcess !== null ? oneSidedEdgeExcess : 0);
    if (risk.edge < eLo || risk.edge > eHi + 1e-9) {
      const dustIdxAsc = dust
        .map((s) => s.idx)
        .sort((a, b) => input.cards[a]!.value - input.cards[b]!.value);
      let landed = false;
      if (dustIdxAsc.length >= 2) {
        const loI = dustIdxAsc[0]!;
        const hiI = dustIdxAsc[dustIdxAsc.length - 1]!;
        const spread = input.cards[hiI]!.value - input.cards[loI]!.value;
        if (spread > 0) {
          // Transfer x units hi→lo lowers EV by x·spread/PIN_SCALE (negative x
          // raises it); solve the window, keep both cards ≥ 1 unit.
          const evHiBound = price * (1 - targetEdge);
          const evLoBound = price * (1 - eHi);
          const xMin = Math.ceil(((risk.ev - evHiBound) * PIN_SCALE) / spread - 1e-9);
          const xMax = Math.floor(((risk.ev - evLoBound) * PIN_SCALE) / spread + 1e-9);
          const a = Math.max(xMin, -(weights[loI]! - 1));
          const b = Math.min(xMax, weights[hiI]! - 1);
          if (a <= b) {
            const x = a <= 0 && 0 <= b ? 0 : Math.abs(a) < Math.abs(b) ? a : b;
            if (x !== 0) {
              weights[loI] = weights[loI]! + x;
              weights[hiI] = weights[hiI]! - x;
              risk = computePackRisk({ cards: cardsForRisk(), price });
            }
            landed = risk.edge >= eLo && risk.edge <= eHi + 1e-9;
          }
        }
      }
      if (!landed) {
        return risk.edge < targetEdge
          ? pinsRefusal(
              `with the pins held, the closest landing puts the edge at ${(risk.edge * 100).toFixed(3)}% — ${((targetEdge - risk.edge) * 100).toFixed(3)}pp below the ${(targetEdge * 100).toFixed(2)}% target.`,
              "Lower a pinned win-card chance, raise the price — or build the below-target experiment deliberately in Drafts.",
            )
          : pinsRefusal(
              `with the pins held, the closest landing puts the edge at ${(risk.edge * 100).toFixed(3)}% — ${((risk.edge - targetEdge) * 100).toFixed(3)}pp above the ${(targetEdge * 100).toFixed(2)}% target (accepted band +${((eHi - targetEdge) * 100).toFixed(2)}pp).`,
              "Raise a pinned winner's chance or lower a pinned dust chance, or lower the price.",
            );
      }
    }
  }

  // ── Win-rate re-check (after all integer adjustments) ───────────────
  // Win-rate is a TARGET within tol — but if the pool genuinely could not land
  // on it (the edge bumps moved mass around to keep edge ≥ target, or the pool
  // can't host the requested win mass), we RELAX to the achieved value and
  // record it rather than erroring. Edge ≥ target is already guaranteed above,
  // so the result is still a valid, edge-correct pack. The comparison target is
  // the TOTAL win share (free target + pinned win share — legacy-identical
  // without pins).
  const totalWinTarget = Math.min(1, targetWinRate + pinnedWinShare);
  if (Math.abs(risk.winRate - totalWinTarget) > winRateTol) {
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
        reason: `Pool could not land win-rate ${(totalWinTarget * 100).toFixed(2)}% within ±${(winRateTol * 100).toFixed(2)}% while keeping edge ≥ target; relaxed to the achievable ${(risk.winRate * 100).toFixed(2)}%.`,
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
  //
  // GATED on the LEGACY value-only path (no `currentWeights`): when the
  // anti-inflation anchor is active, the core solver ALREADY lays the grail band
  // out strictly-decreasing AND never above each card's current odds. Re-running
  // the β=2 skew on top would re-INFLATE the rarest jackpots (their hand-tuned
  // current odds are far below a value^(-2) curve), violating owner rule #1. So
  // the skew only runs when there's no current-odds anchor to honor. ALSO
  // gated off whenever pins exist: the skew redistributes the grail band and
  // could move a pinned grail — pins are owner-chosen numbers, never moved.
  let lotterySkewApplied = false;
  const lottery = anchorActive || hasPins
    ? { weights, applied: false }
    : applyLotterySkew({
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

  // ── Tagged snap mode (RC5b) ──────────────────────────────────────────
  // For a HARD-tag run whose PRECISE solve landed ON the tag, a snap may only
  // be accepted if it KEEPS the tag: the snapped WIN-band mass (win-rate) must
  // stay within TAGGED_WINRATE_TOLERANCE (0.01pp) of the tag. Pre-fix the snap
  // only checked win-rate vs the PRECISE result at the soft ±2pp, so snapping
  // routinely traded the tag away and "clean odds" and "tag-accurate" were
  // mutually exclusive (audit RC5: 0/36 tagged pools achieved both). When the
  // precise solve is itself off-tag (the tag was relaxed as unreachable at
  // this price), the legacy soft check applies unchanged — constraining the
  // snap to an already-missed tag would only force dirty odds on top.
  const snapTagTarget =
    winRateIsHard &&
    Math.abs(preciseWinRate - requestedWinRate) <=
      TAGGED_WINRATE_TOLERANCE + 1e-12
      ? requestedWinRate
      : undefined;
  const snapKeepsTag = (wr: number): boolean =>
    snapTagTarget === undefined ||
    Math.abs(wr - snapTagTarget) <= TAGGED_WINRATE_TOLERANCE + 1e-12;

  // ── Soft win-rate HOLD on the snap (owner-lens item 4 companion) ──────
  // The float ceiling above holds the PRE-SNAP win mass within
  // `WINRATE_HOLD_BAND` of the live-anchored design WHEN the edge is reachable
  // there; the clean-ladder snap can still round the win-band mass UP a hair
  // past that. So a soft (untagged) anchored solve additionally requires every
  // accepted snap candidate to keep the achieved win-rate at/below the snap
  // ceiling. The ceiling is the LARGER of the design band and the PRECISE
  // pre-snap win-rate (+ the soft `winRateTol` the snap already allows vs
  // precise): when the float legitimately ran PAST the band to reach the edge
  // (Charizard-class), the precise rate is above the band and the snap must be
  // allowed to match it — the hold only ever prevents the snap ROUNDING from
  // pushing the win-rate ABOVE what the precise (feasibility-respecting) solve
  // produced, never blocks a solve the pool genuinely needs. This is one-sided
  // (the snap may lower the win-rate freely). When no clean snap fits under the
  // ceiling the precise weights survive, so the SHIPPED number never exceeds it.
  // No-op for tagged packs (the tight `snapKeepsTag` binds) and the legacy
  // value-only path (no anchor ⇒ no float ⇒ nothing to hold).
  const softWinRateHoldBand = Math.min(1, requestedWinRate + WINRATE_HOLD_BAND);
  const softWinRateCeil =
    anchorActive && holdWinRate
      ? // Held within the band → the band is the ceiling (no snap drift past it).
        // Legitimately floated PAST the band (edge needed it) → allow the snap to
        // match the precise rate (+ the tol the snap already allows vs precise).
        preciseWinRate > softWinRateHoldBand + 1e-9
        ? preciseWinRate + winRateTol
        : softWinRateHoldBand
      : Infinity;
  const snapHoldsWinRate = (wr: number): boolean => wr <= softWinRateCeil + 1e-9;

  // ── Snap anti-inflation guard (expensive tail) ───────────────────────
  // The precise solver weights never inflate a grail card above its current
  // odds. The clean-ladder snap, however, rounds each card to the NEAREST rung —
  // which can round a grail's odds UP (e.g. 0.35% → 0.50%), re-inflating the
  // jackpot the solver kept rare. So a snap candidate is only acceptable if it
  // keeps every GRAIL card's odds at/below its PRECISE (pre-snap) odds (a small
  // epsilon for integer quantization). This makes "clean odds" yield to "never
  // inflate the tail" — the snap may round a grail DOWN to a clean rung, never UP.
  const preciseTotalW = weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  // Snapshotted BEFORE any snap mutates `weights`: the never-inflate reference
  // must stay the precise solve even when the snap stack re-runs on the LAW M
  // re-laid vector (post-gate retry), where `weights` no longer holds it.
  const precisePcts = weights.map((w) =>
    preciseTotalW > 0 && w > 0 ? (w / preciseTotalW) * 100 : 0,
  );
  const precisePctOf = (i: number): number => precisePcts[i]!;
  const grailIdxForGuard: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (weights[i]! > 0 && values[i]! >= 5 * price) grailIdxForGuard.push(i);
  }
  const snapGrailNotInflated = (cand: number[]): boolean => {
    // Only the ANCHORED path protects current odds; the legacy value-only path
    // keeps the original snap acceptance (no grail-inflation guard) so the
    // scenario builder / harness snap behavior is unchanged.
    if (!anchorActive) return true;
    if (grailIdxForGuard.length === 0) return true;
    let total = 0;
    for (const w of cand) total += w > 0 ? w : 0;
    if (!(total > 0)) return true;
    for (const i of grailIdxForGuard) {
      const candPct = (cand[i]! / total) * 100;
      // Allow a hair (0.002pp) for integer-quantization noise; otherwise the snap
      // must not raise a grail above its precise odds.
      if (candPct > precisePctOf(i) + 0.002) return false;
    }
    return true;
  };

  // Snap acceptance window vs the target edge: the SAME [target, target+0.001]
  // window the PRECISE result itself lands in (the one-sided-up bump stops
  // inside it) — a snap the precise path would have accepted must not be
  // rejected for cleanliness. Was 0.0005 (HALF the precise window): the audit
  // measured 9/21 basic snaps rejected purely for edge drift in
  // (0.05pp, 0.1pp] — the owner got dirty odds for no protective reason.
  const SNAP_EDGE_TOLERANCE = 0.001;
  // When the one-sided-up acceptance fired, the PRECISE result itself sits up
  // to `oneSidedEdgeExcess` above target — the snap window extends by exactly
  // that much so a clean ladder near the accepted landing isn't rejected for a
  // drift the precise result already carries. Byte-identical otherwise.
  const snapEdgeTol =
    oneSidedAccepted && oneSidedEdgeExcess !== null
      ? SNAP_EDGE_TOLERANCE + oneSidedEdgeExcess
      : SNAP_EDGE_TOLERANCE;

  // ── Tagged per-100k house-ladder snap (tried FIRST for on-tag solves) ────
  // The generic rung snap never passes the 0.01pp tag gate (CLEAN-XOR-TAG:
  // 0/8 on the live fleet) — for a hard-tag solve that landed ON the tag, snap
  // onto the integer per-100k ladder instead: win band EXACTLY round(t·1e5),
  // dust buffer absorbs the residual, jackpot on the 1-in-N menu.
  //
  // PINNED pools run the SAME snaps in pin-aware mode: a pinned card NEVER
  // moves (owner-chosen number, exempt from ladder membership), buffers are
  // chosen among unpinned cards, and pinned win-band units count toward the
  // exact tag sum. The pinned grid (PIN_SCALE) hosts both — every per-100k
  // rung and every clean-ladder rung is an integer number of its units.
  let taggedSnapApplied = false;
  let taggedSnapAllNice: boolean | undefined;
  let taggedSnapNiceExemptIdx: number[] | undefined;
  // LAW M acceptance for the POST-GATE snap retry: a retry candidate must keep
  // the FULL ladder lawful (pins exempt, same predicate the gate verifies) and
  // hold the near-miss reality the re-layout carried — within the same
  // snap-rung jitter the NM shortfall diagnostic treats as noise. Never
  // consulted on the primary (pre-gate) pass.
  const lawfulSnapCandidate = (
    cand: readonly number[],
    candRisk: PackRisk,
  ): boolean => {
    let candTotal = 0;
    for (const w of cand) candTotal += Number.isFinite(w) && w > 0 ? w : 0;
    if (!(candTotal > 0)) return false;
    const candShares = Array.from(cand, (w) =>
      Number.isFinite(w) && w > 0 ? w / candTotal : 0,
    );
    if (
      findMonotoneViolations({
        values,
        shares: candShares,
        pinnedIdx: hasPins ? new Set(pinnedShareByIdx.keys()) : undefined,
        tol: 1e-9,
      }).length > 0
    ) {
      return false;
    }
    const expectedNm = nearMissMass + pinnedNearMissShare;
    const nmRef = Math.min(expectedNm, risk.nearMiss);
    return (
      candRisk.nearMiss >=
      nmRef - Math.min(0.02, 0.5 * Math.max(expectedNm, 1e-9)) - 1e-9
    );
  };
  // The FULL snap stack (tagged per-100k / pinned clean-ladder / untagged
  // 3-tier + buffer polish), wrapped so the LAW M gate can RETRY it on the
  // lawfully re-laid vector: with `lawCheck` every acceptance additionally
  // requires `lawfulSnapCandidate` — law over rungs, but rungs whenever the
  // law allows them. `lawCheck=false` is byte-identical to the pre-wrap block.
  const attemptSnapStack = (lawCheck: boolean): void => {
    if (snapTagTarget !== undefined) {
      // §niceness live-basis never-inflate caps: current odds on the snap grid
      // (the owner rule is "never above CURRENT advertised odds" — the precise
      // vector is an intermediate artifact and capping nice rungs at it would
      // make the owner's own round-number ask impossible). Zero/absent current
      // weight ⇒ uncapped (LAW-6 new cards); no anchor ⇒ null (the legacy
      // value-only path keeps no inflation guard, mirroring the generic snap).
      const snapScale = hasPins ? PIN_SCALE : 100_000;
      const curForCaps = cur;
      const liveCapUnits =
        anchorActive && curForCaps !== undefined
          ? values.map((_, i) => {
              const cw = curForCaps[i];
              return cw !== undefined && Number.isFinite(cw) && cw > 0
                ? (cw / curTotal) * snapScale
                : Infinity;
            })
          : null;
      const taggedSnap = snapTaggedPer100k({
        values,
        weights,
        price,
        tag: snapTagTarget,
        targetEdge,
        edgeTolAbove: snapEdgeTol,
        grailGuard: snapGrailNotInflated,
        liveCapUnits,
        // Plan-wide DFS budget (perf-incident fix): shared across every candidate
        // price the tagged search evaluates so the all-nice enumeration can't grind.
        ...(input.nodeBudget !== undefined ? { nodeBudget: input.nodeBudget } : {}),
        ...(input.niceGridPolish === true ? { niceGridPolish: true } : {}),
        ...(hasPins
          ? {
              pins: [...pinnedShareByIdx.keys()].map((index) => ({
                index,
                units: weights[index]!,
              })),
              scale: PIN_SCALE,
            }
          : {}),
      });
      if (
        taggedSnap !== null &&
        (!lawCheck || lawfulSnapCandidate(taggedSnap.weights, taggedSnap.risk))
      ) {
        for (let i = 0; i < weights.length; i++) weights[i] = taggedSnap.weights[i]!;
        risk = taggedSnap.risk;
        snapped = true;
        taggedSnapApplied = true;
        taggedSnapAllNice = taggedSnap.allNice;
        taggedSnapNiceExemptIdx = taggedSnap.niceExemptIdx;
      }
    }

    if (!taggedSnapApplied && hasPins) {
      // Pinned clean-ladder snap (untagged / off-tag pinned pools): snap the
      // FREE slots onto the ladder, buffer = largest FREE mass, pins verbatim.
      // Acceptance stack identical to the unpinned tier-1; on failure the
      // precise weights stay (dirty odds surface honestly — no local search /
      // buffer polish for pinned pools, the pins constrain the space anyway).
      const pinnedSnap = snapPinnedFreeToCleanLadder({
        weights,
        values,
        price,
        pinnedIdx: new Set(pinnedShareByIdx.keys()),
        scale: PIN_SCALE,
      });
      if (pinnedSnap !== null) {
        const candRisk = computePackRisk({
          cards: input.cards.map((c, i) => ({ value: c.value, weight: pinnedSnap[i]! })),
          price,
        });
        if (
          Math.abs(candRisk.edge - targetEdge) <= snapEdgeTol &&
          candRisk.edge >= targetEdge - 1e-9 &&
          Math.abs(candRisk.winRate - preciseWinRate) <= winRateTol + 1e-9 &&
          snapKeepsTag(candRisk.winRate) &&
          snapHoldsWinRate(candRisk.winRate) &&
          snapGrailNotInflated(pinnedSnap) &&
          (!lawCheck || lawfulSnapCandidate(pinnedSnap, candRisk))
        ) {
          for (let i = 0; i < weights.length; i++) weights[i] = pinnedSnap[i]!;
          risk = candRisk;
          snapped = true;
        }
      }
    } else if (!taggedSnapApplied) {
      // Pattern 11: pass the live weights so the buffer tie-break keeps the modal
      // live card modal among equal-value dust (deterministic, EV-preserving).
      const snap = snapWeightsToCleanLadder({
        weights,
        price,
        tieBreakWeights: input.currentWeights ?? null,
      });
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
      // +0.1pp of target AND ≥ target (one-sided-up invariant) AND win-rate
      // stays within the soft tolerance of the precise solver's win-rate AND the
      // monotonicity repair succeeded.
      if (
        snapRepaired.ok &&
        snapDrift <= snapEdgeTol &&
        snapCandidateRisk.edge >= targetEdge - 1e-9 &&
        snapWinRateDrift <= winRateTol + 1e-9 &&
        snapKeepsTag(snapCandidateRisk.winRate) &&
        snapHoldsWinRate(snapCandidateRisk.winRate) &&
        snapGrailNotInflated(snapCandidate) &&
        (!lawCheck || lawfulSnapCandidate(snapCandidate, snapCandidateRisk))
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
          tolerance: snapEdgeTol,
          searchTop: 5,
          searchRadius: 1,
          preciseWinRate,
          winRateTol,
          taggedWinRate: snapTagTarget,
        });
        if (refined === null) {
          refined = snapLocalSearchRefine({
            weights,
            values,
            price,
            targetEdge,
            tolerance: snapEdgeTol,
            searchTop: 4,
            searchRadius: 2,
            preciseWinRate,
            winRateTol,
            taggedWinRate: snapTagTarget,
          });
        }
        if (refined === null) {
          refined = snapLocalSearchRefine({
            weights,
            values,
            price,
            targetEdge,
            tolerance: snapEdgeTol,
            searchTop: 7,
            searchRadius: 1,
            preciseWinRate,
            winRateTol,
            taggedWinRate: snapTagTarget,
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
              refinedDrift <= snapEdgeTol &&
              refinedRisk.edge >= targetEdge - 1e-9 &&
              refinedWinRateDrift <= winRateTol + 1e-9 &&
              snapKeepsTag(refinedRisk.winRate) &&
              snapHoldsWinRate(refinedRisk.winRate) &&
              snapGrailNotInflated(refinedRepaired.weights) &&
              (!lawCheck ||
                lawfulSnapCandidate(refinedRepaired.weights, refinedRisk))
            ) {
              for (let i = 0; i < weights.length; i++) weights[i] = refinedRepaired.weights[i]!;
              risk = refinedRisk;
              snapped = true;
            }
          }
        }
      }
    }

    // ── Buffer-card rung polish (RC5c) ───────────────────────────────────
    // An accepted snap leaves the buffer (argmax — the pack page's headline
    // number) off-ladder by design. Try to land IT on a rung too, spreading the
    // residual over the 2–3 largest OTHER dust cards. Adopt ONLY when the full
    // acceptance stack still holds — otherwise keep the accepted snap unchanged
    // (this step can never regress a result). SKIPPED after the tagged per-100k
    // snap: there the buffer IS on the grid by construction, and re-spreading it
    // over generic rungs would break the exact win-band tag sum. ALSO skipped
    // for pinned pools — the polish spreads residual over dust cards without
    // knowing about pins and could move a pinned card.
    if (snapped && !taggedSnapApplied && !hasPins) {
      const polished = trySnapBufferToRung({
        weights,
        values,
        price,
        accept: (r, cand) =>
          Math.abs(r.edge - targetEdge) <= snapEdgeTol &&
          r.edge >= targetEdge - 1e-9 &&
          Math.abs(r.winRate - preciseWinRate) <= winRateTol + 1e-9 &&
          snapKeepsTag(r.winRate) &&
          snapHoldsWinRate(r.winRate) &&
          snapGrailNotInflated(cand) &&
          (!lawCheck || lawfulSnapCandidate(cand, r)),
      });
      if (polished !== null) {
        for (let i = 0; i < weights.length; i++) weights[i] = polished.weights[i]!;
        risk = polished.risk;
      }
    }
  };
  attemptSnapStack(false);

  // ── Flag any UNAVOIDABLE jackpot inflation (anti-inflation anchor) ────
  // If the anchor pass couldn't cap a win/grail card at its current odds even
  // at the steepest allowed decay, the inflation is mathematically unavoidable
  // for this pool — record it as a winRate-lever relaxation so the proposal
  // surfaces it (never silent). Only emitted when `currentWeights` was supplied.
  if (topInflationUnavoidable) {
    relaxations.push({
      lever: "winRate",
      requested: requestedWinRate,
      applied: risk.winRate,
      reason:
        "A win/grail card's current odds are so rare that no feasible decay matches them; its odds had to rise slightly (unavoidable for this pool).",
    });
  }

  // ── LOSS/SUB-PRICE MONOTONICITY INVARIANT (owner rule, universal) ────────
  // The single-β loss layout, the affine dispersion AND the snap can all leave
  // an INVERSION in the free below-price loss band — a rich loss card planned
  // likelier than a cheaper one (the "10% Divine Order" pinned+added-card
  // scramble: 562.22→20%, 299.99→30%, 111.02→0.001%). The owner rule is
  // universal: among the FREE (non-pinned) cards priced BELOW the pack price,
  // probability must be NON-INCREASING in value (the cheapest carries the
  // highest odds), with the single residual-buffer card exempt (the same
  // exemption `repairSnapMonotonicity` uses). This runs on the FINAL committed
  // vector so EVERY path is covered — snapped, precise-fallback, dispersed,
  // pinned, tagged. Gated on the RETUNE path (`disperseLoss`); legacy direct
  // callers (scenario builder, anti-inflation / niceness harnesses) stay
  // byte-identical.
  //
  // When the non-buffer chain is already monotone the enforce is a byte-for-byte
  // no-op (a healthy plan is never perturbed). When it repairs, the loss band's
  // total mass is preserved exactly (an integer re-distribution within the fixed
  // budget); we then re-check edge ≥ target within the snap tolerance — the loss
  // band carries the house edge, so a repair that would drop edge below target
  // (or a pool where no monotone layout exists at the required loss mean — the
  // pins/added cards force it, the pool-edit case) is treated as INFEASIBLE and
  // surfaced HONESTLY as the `loss-nonmonotone` limit instead of shipping the
  // garbage ordering.
  if (disperseLoss) {
    const pinnedIdxSet = hasPins ? new Set(pinnedShareByIdx.keys()) : undefined;
    const mono = enforceLossMonotone({
      values: input.cards.map((c) => c.value),
      weights,
      price,
      pinnedIdx: pinnedIdxSet,
    });
    if (!mono.ok) {
      return lossMonotoneRefusal(price);
    }
    if (mono.changed) {
      const monoRisk = computePackRisk({
        cards: input.cards.map((c, i) => ({ value: c.value, weight: mono.weights[i]! })),
        price,
      });
      // The repair holds the loss band's mass; edge may shift a hair. Accept it
      // only when edge stays ≥ target within the SAME window the snap accepts
      // (extended by any one-sided-up excess the precise result already carried).
      const monoEdgeHi =
        targetEdge +
        0.001 +
        (oneSidedAccepted && oneSidedEdgeExcess !== null ? oneSidedEdgeExcess : 0);
      if (monoRisk.edge >= targetEdge - 1e-9 && monoRisk.edge <= monoEdgeHi + 1e-9) {
        for (let i = 0; i < weights.length; i++) weights[i] = mono.weights[i]!;
        risk = monoRisk;
      } else {
        // The only monotone layout the repair could build drops edge off the
        // accepted window — the invariant and the edge are jointly infeasible at
        // this mass/price. Refuse honestly rather than ship the inversion.
        return lossMonotoneRefusal(price);
      }
    }
  }

  // ── gcd-reduce the pinned grid (ratios — and pins — are unchanged) ────
  // The legacy path gcd-reduced before its snap; the pinned path works on the
  // fixed PIN_SCALE total throughout (transfers + snaps), so the reduction
  // runs once at the very end. Runs AFTER the monotone enforce so its integer
  // re-distribution is reduced too (ratios — and the invariant — are unchanged).
  if (hasPins) {
    const presentPinned = weights.filter((w) => w > 0);
    if (presentPinned.length > 0) {
      let g = presentPinned[0]!;
      for (let i = 1; i < presentPinned.length; i++) g = gcd(g, presentPinned[i]!);
      if (g > 1) {
        for (let i = 0; i < weights.length; i++) {
          if (weights[i]! > 0) weights[i] = Math.round(weights[i]! / g);
        }
        risk = computePackRisk({ cards: cardsForRisk(), price });
      }
    }
  }

  // ── LAW M — the FULL-ladder monotone gate (Retune V3, retune path only) ──
  // `enforceLossMonotone` above orders the free BELOW-price band, but the
  // owner's law spans the WHOLE ladder — including the win→near-miss boundary
  // the soft float's sink used to break (Love Cycle: 30% on the cheapest
  // winner over a 10% near-miss). Verify the final committed vector; on a
  // zigzag, re-lay the ladder lawfully at the SAME landed win mass / EV /
  // pins (LAW over nice rungs — `snapped` drops to false, honestly); when no
  // lawful ladder can carry the landed EV at this price, refuse with the
  // typed `monotone-unreachable` limit so the price search keeps sweeping
  // and guidance can say what WOULD fit. Gated on `disperseLoss` so every
  // legacy direct caller stays byte-identical.
  if (disperseLoss) {
    // The contract this solve already accepted, as an EV range: edge may sit
    // in [target, target + snap tol (+ any one-sided excess already taken)].
    const gateEdgeHi =
      targetEdge +
      0.001 +
      (oneSidedAccepted && oneSidedEdgeExcess !== null ? oneSidedEdgeExcess : 0);
    const gate = enforceMonotoneLadderLawM({
      cards: input.cards,
      weights,
      price,
      maxWinCap,
      currentWeights: input.currentWeights,
      pinnedShares: hasPins ? pinnedShareByIdx : null,
      nearMissFloor: nearMissMass + pinnedNearMissShare,
      evAccept: {
        min: price * (1 - gateEdgeHi),
        max: price * (1 - targetEdge),
      },
    });
    if (gate.kind === "refuse") {
      return {
        error:
          "No lawful odds ladder (odds only rising down the value order) can carry this plan at this price.",
        limit: {
          kind: "monotone-unreachable",
          detail: gate.detail,
          suggestion: gate.suggestion,
        },
      };
    }
    if (gate.kind === "relayout") {
      for (let i = 0; i < weights.length; i++) weights[i] = gate.weights[i]!;
      risk = gate.risk;
      // The re-laid ladder is EV/tag-exact but sits on precise (not nice)
      // rungs, and any per-card niceness verdict computed on the old vector
      // is stale — reset both, then RETRY the full snap stack on the LAWFUL
      // vector (wave 3): every retry acceptance additionally requires
      // `lawfulSnapCandidate` (full-ladder law + NM reality), so the retune
      // recovers clean odds whenever a lawful snapped layout exists and keeps
      // the honest unsnapped re-layout when none does.
      snapped = false;
      taggedSnapApplied = false;
      taggedSnapAllNice = undefined;
      taggedSnapNiceExemptIdx = undefined;
      attemptSnapStack(true);
    }
  }

  // ── NEAR-MISS shortfall diagnostic (retune path only) ────────────────────
  // The dispersal rescue above preserves the near-miss band where the pool's
  // physics allow — but when the edge target + the cheapest-carries-most loss
  // ordering genuinely leave no room (the EV-feasible ceiling sits below the
  // allocated floor), the FINAL vector lands under the ask. That shortfall
  // used to ship SILENTLY (owner incident "Tails?": near-miss target 10%,
  // planned 4%, empty relaxations). Record it as a `nearMiss` relaxation so
  // the plan panel / push review surface it honestly. Tolerance: snap-rung
  // jitter must never fire this (min(2pp, half the ask)); gated on the retune
  // path (`disperseLoss`) so every legacy direct caller's relaxations stay
  // byte-identical.
  if (disperseLoss) {
    const expectedNm = nearMissMass + pinnedNearMissShare;
    const shortfall = expectedNm - risk.nearMiss;
    if (expectedNm > 1e-9 && shortfall > Math.min(0.02, 0.5 * expectedNm)) {
      const existingNm = relaxations.find((r) => r.lever === "nearMiss");
      const reason = `Near-miss band lands at ${(risk.nearMiss * 100).toFixed(2)}% (target ${(expectedNm * 100).toFixed(2)}%): holding the edge target with the cheapest-carries-most loss ordering leaves no more room for near-miss mass in this pool.`;
      if (existingNm) {
        existingNm.applied = risk.nearMiss;
        existingNm.reason = reason;
      } else {
        relaxations.push({
          lever: "nearMiss",
          requested: requestedNearMissMin,
          applied: risk.nearMiss,
          reason,
        });
      }
    }
  }

  return {
    weights,
    risk,
    ev: risk.ev,
    edge: risk.edge,
    relaxations,
    snapped,
    lotterySkewApplied,
    topInflationUnavoidable,
    ...(oneSidedAccepted && oneSidedEdgeExcess !== null
      ? { oneSidedEdgeExcess }
      : {}),
    // Tagged per-100k snap only (§niceness): the human-nice verdict + the
    // exempt indexes. The gcd-reduce above preserves proportions, so the
    // verdict computed on the snap vector stays valid. Untagged / unsnapped
    // results never set these — untagged behavior is byte-identical.
    ...(taggedSnapApplied &&
    taggedSnapAllNice !== undefined &&
    taggedSnapNiceExemptIdx !== undefined
      ? { allNice: taggedSnapAllNice, niceExemptIdx: taggedSnapNiceExemptIdx }
      : {}),
  };
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
//   Tier 1b: nmTier (retune path only — near-miss floor shortfall in 1pp
//            buckets; fully-funded beats starved; inert for legacy callers)
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

/**
 * The ONE retune price-search band: ±60% of the anchor price. INVARIANT: the
 * planner dry-runs (`planAllRetunes` / `planSingleRetune`), the write
 * (`applyPackRetune`) and the client confirm/adjust mirrors (`retune-review`)
 * MUST all pass this same value as `maxPriceChangePct` so preview = confirm
 * summary = write by construction — a proposal whose clean snap needs a >25%
 * price move must land at write time on the SAME price the review showed.
 * (The `maxPriceChangePct` default below stays ±25% for other/legacy callers,
 * e.g. the staged pool-editor lever, which previews and writes at the default.)
 */
export const RETUNE_MAX_PRICE_CHANGE_PCT = 0.6;

/**
 * The DEFAULT retune price budget: the automatic plan may move the ticket at
 * most ±10% of the live price (owner-approved default, 2026-07-03 — the ±60%
 * band produced a −58% "so the odds land clean" move on a $4.38 pack, halving
 * the ticket for cosmetics). Override via
 * `pack_system_config.retunePriceBudgetPct`; hard-capped at
 * {@link RETUNE_MAX_PRICE_CHANGE_PCT}. The full ±60% band remains the
 * SUGGESTION band — a wide probe may PROPOSE prices beyond the budget, ranked
 * and with exact numbers, but a beyond-budget price is NEVER silently applied
 * as the default plan. The budget is a caller-side concern:
 * `searchBestPriceForCleanSnap` already takes `maxPriceChangePct` as input;
 * this constant is what the one-brain `buildRetuneSearchParams` threads as the
 * default band when no config override exists.
 */
export const RETUNE_PRICE_BUDGET_DEFAULT_PCT = 0.1;

/** Fields common to both the internal single-arm core solve and the public result. */
type SearchBestPriceResultCore = {
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
  /**
   * Tagged-mode only: total all-nice DFS nodes the plan's snaps spent (perf-
   * incident bound). Deterministic across runs/machines — the `plan-quality.ts`
   * permanent perf gate asserts EVERY fleet pack stays under a pinned ceiling so
   * the tagged snapper can never silently regress into the pool-stampede incident
   * again. `0` for untagged / disabled searches (no `snapTaggedPer100k` runs).
   */
  snapNodesSpent: number;
};

export type SearchBestPriceResult = SearchBestPriceResultCore & {
  /**
   * GRACEFUL FALLBACK (untagged retune spike fix, attempt #2): TRUE only when
   * the caller passed `holdWinRateHard` AND the hard-held sweep found NO
   * feasible in-budget price, so the search re-ran with the OLD soft
   * `holdWinRate` (+5pp float) instead — the pack still gets a plan (Captive /
   * Dooms Day class: genuinely EV-forced at the design win-rate). `false` when
   * the hard hold itself solved, or when `holdWinRateHard` was never requested
   * (every other caller — including the plain `holdWinRate` / tagged / legacy
   * paths — is unaffected and always reports `false`).
   */
  usedSoftFallback: boolean;
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
  /**
   * The pack's CURRENT per-card weights (pool order, parallel to `cards`).
   * Forwarded verbatim to {@link shapeWeights} so the ANTI-INFLATION anchor
   * (owner rule #1 — no win/grail card's odds may exceed its current odds) is
   * enforced at EVERY candidate price. The anchor is price-relative (banding
   * shifts with price), so passing it here keeps the "trim the tail, never
   * inflate" guarantee across the whole price sweep. Omit to skip the anchor.
   */
  currentWeights?: number[];
  /**
   * Owner-pinned EXACT per-card odds (Retune V2 pins), forwarded verbatim to
   * {@link shapeWeights} at EVERY candidate price — a pinned card is held at
   * exactly its share at every price the sweep evaluates (its BAND may shift
   * with the candidate price; the hold does not). A pin that is infeasible at
   * every candidate (e.g. cap-dropped) surfaces as the `pins-infeasible`
   * error result. Omit for the legacy behavior — byte-identical.
   */
  pinnedShares?: ShapeWeightsPinnedShare[];
  /**
   * WIN-RATE HOLD (owner-lens item 4): when TRUE, forwarded to
   * {@link shapeWeights} at every candidate price so an UNTAGGED (soft) retune
   * holds the achieved win-rate within `WINRATE_HOLD_BAND` (+5pp) of the design.
   * When holding makes a given price's edge unreachable, THAT price errors and
   * the search moves on to one where the band-held win-rate reaches the edge (a
   * clean plan). Set by the untagged retune arm (`buildRetuneSearchParams`);
   * omit for the legacy unbounded float (existing callers byte-identical). No-op
   * in tagged mode (a tagged pack never floats).
   */
  holdWinRate?: boolean;
  /**
   * WIN-RATE HOLD — HARD, WITH GRACEFUL SOFT FALLBACK (untagged retune spike
   * fix, attempt #2): when TRUE, the search first runs its ENTIRE price sweep
   * with the win-rate PINNED at design (forwarded to {@link shapeWeights} as
   * `holdWinRateHard` at every candidate price — no float, cheapest winner
   * capped). This kills the mid-pool spike (root cause: the old soft float left
   * the cheapest winner as an uncapped EV sink). It is a PREFERENCE, not a hard
   * requirement: if the hard-held sweep finds NO feasible (non-error) candidate
   * anywhere in the ±budget band, the search transparently RE-RUNS the whole
   * sweep with the OLD soft `holdWinRate` (+5pp float band) instead — so a
   * genuinely EV-forced pool (the win band structurally cannot carry the target
   * EV at the design rate, e.g. "Captive") still gets its plan rather than a
   * bare refusal. `usedSoftFallback` on the result reports which arm was used.
   * Set by the untagged retune arm (`buildRetuneSearchParams`) in place of the
   * plain `holdWinRate`; omit for the legacy unbounded float. No-op in tagged
   * mode. See `holdWinRateHard` on `shapeWeights`.
   */
  holdWinRateHard?: boolean;
  /**
   * LOSS-MASS DISPERSION (owner-lens item 10): when TRUE, forwarded to
   * {@link shapeWeights} at every candidate price so the free-dust loss band is
   * re-spread at fixed band mass + EV (edge/win-rate/tag unchanged) — the crush
   * ladder's single-carrier collapse is loosened where the pool has room. Set by
   * the retune arm (`buildRetuneSearchParams`); omit for the legacy single-β
   * layout (existing callers byte-identical).
   */
  disperseLoss?: boolean;
  /**
   * SEGMENT-SEEDED CANDIDATE SEARCH (ruleset delta 9, Retune V3): when TRUE,
   * the sweep seeds candidates at the pool's BANDING BOUNDARIES inside the
   * band — the cents where a card's band membership flips (`price = v` WIN↔
   * NEARMISS, `price = 2v` NEARMISS↔DUST, `price = v/5` GRAIL↔WIN; both cents
   * of each crossing). Feasibility is piecewise in price with breakpoints
   * exactly there (crossing a boundary changes which cards can carry EV /
   * near-miss mass), so snap-capable "needle" cents cluster at boundaries the
   * coarse grid can miss on expensive packs (stride grows with band width;
   * the offset passes densify blindly and the budget can run out first —
   * see the Phase 4 note). Seeds run as a BONUS ROUND after the full legacy
   * enumeration on an EXTRA ~20% allowance — the seeded sweep evaluates a
   * strict SUPERSET of the unseeded one, so it can never land on a worse
   * plan (fleet-measured: spending seeds from the shared budget instead
   * cannibalized grid cents and regressed snapped plans). Deterministic
   * (nearest-boundary-first) and never leaves the requested band. Set by the
   * retune arm (`buildRetuneSearchParams`, both arms — the wide ±60%
   * suggestion probe inherits it too, where strides are widest); omit for
   * the legacy enumeration (existing callers byte-identical).
   */
  seedSegmentBoundaries?: boolean;
  /**
   * NICE-GRID POST-PASS (Retune V3 wave 7 — the dust-chain nice-grid item):
   * when TRUE, forwarded to {@link shapeWeights} at every candidate price so
   * an accepted tier-G tagged snap (the DFS-starved / all-nice-infeasible
   * fallback that ships per-100k-exact but off-nice decimals like 38.279%)
   * is polished onto the human-nice grid by {@link polishTaggedNiceGrid} —
   * one strictly-improving move at a time, the FULL acceptance stack (edge
   * window, exact tag, win-ladder + LAW M monotonicity, anti-inflation
   * grailGuard, byte-identical near-miss mass) re-verified per move, so a
   * polished plan can never be lawful-worse than the unpolished one. No-op
   * in untagged mode ({@link snapTaggedPer100k} never runs) and on tiers
   * N/P. Set by the retune arm (`buildRetuneSearchParams`, both arms); omit
   * for the legacy tier-G vector (existing callers byte-identical).
   */
  niceGridPolish?: boolean;
}): SearchBestPriceResult {
  const holdWinRateHardRequested = input.holdWinRateHard === true;
  // GRACEFUL FALLBACK orchestration: try the hard hold across the WHOLE sweep
  // first; if nothing in the band solves, re-run the whole sweep with the old
  // soft float. Both passes are the exact same function (recursion, one level
  // deep — `holdWinRateHard` is stripped so the second pass can't re-recurse).
  if (holdWinRateHardRequested) {
    const { holdWinRateHard: _drop, ...rest } = input;
    const hardResult = searchBestPriceForCleanSnapCore({
      ...rest,
      holdWinRateHard: true,
    });
    if (hardFeasibleSomewhere(hardResult)) {
      return { ...hardResult, usedSoftFallback: false };
    }
    // No in-budget price admits a hard-held clean solve — fall back to the
    // OLD soft float (holdWinRate, +5pp band) so the pack still gets a plan
    // (Captive / Dooms Day class: genuinely EV-forced, never load-bearing to
    // refuse). NOT a silent regression: this is BYTE-IDENTICAL to the
    // pre-attempt-#2 behavior for exactly the packs that need it.
    const softResult = searchBestPriceForCleanSnapCore({
      ...rest,
      holdWinRate: true,
    });
    if (isShapeWeightsSuccess(softResult.bestResult)) {
      return { ...softResult, usedSoftFallback: true };
    }
    // LAW M RESCUE (Retune V3): both arms refused everywhere in the band.
    // When a lawful full-ladder window still contains the contract (the
    // split's exact-floor allocation was the blocker, not physics), lay the
    // ladder directly — design win rate held EXACTLY, so this counts as the
    // HARD arm succeeding, not a soft float.
    const rescued = lawfulRescueSweep(input);
    if (rescued !== null) return { ...rescued, usedSoftFallback: false };
    return { ...softResult, usedSoftFallback: true };
  }
  const core = searchBestPriceForCleanSnapCore(input);
  if (!isShapeWeightsSuccess(core.bestResult) && input.disperseLoss === true) {
    // LAW M RESCUE for the remaining retune arms (tagged / plain hold): same
    // last-resort contract as above — never reached by legacy callers.
    const rescued = lawfulRescueSweep(input);
    if (rescued !== null) return { ...rescued, usedSoftFallback: false };
    // LAW T VERDICT (stage 3): a TAGGED retune refused at EVERY candidate
    // price (core sweep + lawful rescue). When the LAW M window math PROVES
    // the tag itself sits outside the pool's lawful fit range at the live
    // price, upgrade the generic closest-cent refusal to the typed
    // `tag-unreachable` verdict. Only the ambiguous EV/law refusal kinds are
    // upgradable — structural refusals (no dust, no winners, broken pins,
    // invalid inputs) name a concrete defect and keep their own story.
    const coreKind = !isShapeWeightsSuccess(core.bestResult)
      ? core.bestResult.limit.kind
      : "";
    if (
      typeof input.taggedWinRate === "number" &&
      Number.isFinite(input.taggedWinRate) &&
      TAG_VERDICT_UPGRADABLE_KINDS.has(coreKind)
    ) {
      const verdict = lawTagVerdict({
        cards: input.cards,
        basePrice: input.basePrice,
        targetEdge: input.targetEdge,
        taggedWinRate: input.taggedWinRate,
        maxWinCap: input.maxWinCap,
        currentWeights: input.currentWeights,
        pinnedShares: input.pinnedShares,
      });
      if (verdict !== null) {
        const priorFeas = !isShapeWeightsSuccess(core.bestResult)
          ? core.bestResult.feasibility
          : undefined;
        return {
          ...core,
          bestResult: {
            error: verdict.error,
            ...(priorFeas !== undefined ? { feasibility: priorFeas } : {}),
            limit: verdict.limit,
          },
          usedSoftFallback: false,
        };
      }
    }
  }
  return { ...core, usedSoftFallback: false };
}

/**
 * The refusal kinds the LAW T verdict may upgrade: the ambiguous "the math
 * didn't reach" family, where the window proof genuinely ANSWERS the refusal.
 * Structural kinds (`no-dust-cards`, `no-win-cards`, `pins-infeasible`,
 * `empty-pool`, `degenerate-pool`, invalid inputs…) stay verbatim — they
 * already name the concrete defect and its fix.
 */
const TAG_VERDICT_UPGRADABLE_KINDS: ReadonlySet<string> = new Set([
  "ev-unreachable-for-split",
  "edge-unreachable",
  "ev-out-of-range",
  "monotone-unreachable",
  "loss-nonmonotone",
  "no-win-band-card",
]);

type LawTagVerdictInput = {
  cards: { value: number }[];
  basePrice: number;
  targetEdge: number;
  taggedWinRate: number;
  maxWinCap?: number;
  currentWeights?: number[];
  pinnedShares?: ShapeWeightsPinnedShare[];
};

/**
 * LAW T verdict builder (stage 3): decides whether an everywhere-refused
 * TAGGED search should surface as the typed `tag-unreachable` limit, and
 * builds the refusal copy from the window proof ({@link lawfulTagFitRange}
 * at the LIVE price, one-sided edge acceptance).
 *
 * Returns null (keep the solver's own refusal) when the tag DOES fit the
 * lawful envelope at the live price — the refusal is then solver- or
 * pin-specific, and that story is more actionable than a false tag verdict.
 * With pins present and NO tag fitting, the pool is re-probed UNPINNED: if
 * some tag fits without the pins, the pins are the blocker and the solver's
 * `pins-infeasible` copy stands.
 */
function lawTagVerdict(
  input: LawTagVerdictInput,
): { error: string; limit: ShapeWeightsLimit } | null {
  const tag = input.taggedWinRate;
  const price = input.basePrice;
  if (!(price > 0) || !Number.isFinite(tag) || tag < 0 || tag >= 1) return null;
  const fitArgs = {
    cards: input.cards,
    price,
    targetEdge: input.targetEdge,
    maxWinCap: input.maxWinCap,
    currentWeights: input.currentWeights,
    pinnedShares: input.pinnedShares,
  };
  const range = lawfulTagFitRange(fitArgs);
  const tagPct = (tag * 100).toFixed(2);
  if (range === null) {
    if ((input.pinnedShares?.length ?? 0) > 0) {
      const unpinned = lawfulTagFitRange({ ...fitArgs, pinnedShares: undefined });
      if (unpinned !== null) return null; // pins are the blocker — keep pins copy
    }
    return {
      error: `LAW T: no win-rate tag fits this pool lawfully at $${price.toFixed(2)} — the solver refused at every in-band price.`,
      limit: {
        kind: "tag-unreachable",
        detail: `No lawful plan exists for the ${tagPct}% tag at any candidate price, and the LAW M window math at $${price.toFixed(2)} proves NO tag fits this pool inside the ${(input.targetEdge * 100).toFixed(2)}% edge contract (never-inflate caps + monotone full ladder + pins). The pool shape itself refuses.`,
        suggestion:
          "Edit the pool: add win-band cards (or raise never-inflate caps by editing live odds), or reprice the pack — retagging alone cannot fix this.",
      },
    };
  }
  const tolerance = TAGGED_WINRATE_TOLERANCE;
  if (tag >= range.minFit - tolerance && tag <= range.maxFit + tolerance) {
    return null; // the tag fits the lawful envelope — the refusal is solver/pin-specific
  }
  const maxPct = (range.maxFit * 100).toFixed(2);
  const minPct = (range.minFit * 100).toFixed(2);
  if (tag > range.maxFit) {
    return {
      error: `LAW T: the ${tagPct}% tag exceeds the lawful maximum ${maxPct}% for this pool — the solver refused at every in-band price.`,
      limit: {
        kind: "tag-unreachable",
        detail: `The ${tagPct}% tag cannot be lawfully hosted: no candidate price in the band produced a plan, and the LAW M window at $${price.toFixed(2)} proves the pool can carry at most a ${maxPct}% tag inside the ${(input.targetEdge * 100).toFixed(2)}% edge contract (never-inflate caps + monotone full ladder + pins).`,
        suggestion: `Retag the pack at or below ${maxPct}% (or untag it for a soft win-rate), raise the never-inflate caps by editing live odds, or add win-band cards.`,
      },
    };
  }
  return {
    error: `LAW T: the ${tagPct}% tag sits below the lawful minimum ${minPct}% for this pool — the solver refused at every in-band price.`,
    limit: {
      kind: "tag-unreachable",
      detail: `The ${tagPct}% tag cannot be lawfully hosted: no candidate price in the band produced a plan, and the LAW M window at $${price.toFixed(2)} proves this pool's lawful tag range is ${minPct}%–${maxPct}% inside the ${(input.targetEdge * 100).toFixed(2)}% edge contract — the tag falls below it (the pool needs more win mass to land the edge).`,
      suggestion: `Retag the pack into the ${minPct}%–${maxPct}% range, or edit the pool (add cheaper dust/near-miss cards so less win mass is needed).`,
    },
  };
}

/**
 * The LAW M rescue price sweep — {@link searchBestPriceForCleanSnap}'s third
 * pass (see the call sites above). Walks the SAME ±band the core sweeps
 * (dense 1¢ ring around base + coarse grid to the endpoints, closest-to-base
 * first) and lays a lawful window ladder at each candidate via
 * {@link lawfulWindowRescue}; the first success (= smallest price move) wins.
 * Tagged mode holds the TAG as the exact win mass. Returns null when no
 * candidate price admits a lawful ladder — the caller keeps the honest
 * refusal.
 */
function lawfulRescueSweep(input: {
  cards: { value: number }[];
  basePrice: number;
  targetEdge: number;
  targetWinRate: number;
  maxWinCap?: number;
  nearMissMin?: number;
  winRateTol?: number;
  maxPriceChangePct?: number;
  taggedWinRate?: number;
  upwardPriceExtensionPct?: number;
  currentWeights?: number[];
  pinnedShares?: ShapeWeightsPinnedShare[];
}): SearchBestPriceResultCore | null {
  const basePrice = input.basePrice;
  if (!(basePrice > 0) || input.cards.length === 0) return null;
  const tagged =
    typeof input.taggedWinRate === "number" && Number.isFinite(input.taggedWinRate);
  const winMass = tagged ? input.taggedWinRate! : input.targetWinRate;
  const maxPriceChangePct = input.maxPriceChangePct ?? 0.25;
  const centsAtBase = Math.round(basePrice * 100);
  const downCents = Math.max(0, Math.floor(basePrice * maxPriceChangePct * 100));
  const upCents = Math.max(
    downCents,
    Math.floor(basePrice * Math.max(0, input.upwardPriceExtensionPct ?? 0) * 100),
  );
  const lo = Math.max(1, centsAtBase - downCents);
  const hi = centsAtBase + upCents;
  const seen = new Set<number>();
  const candidates: number[] = [];
  const push = (c: number) => {
    if (c < lo || c > hi || seen.has(c)) return;
    seen.add(c);
    candidates.push(c);
  };
  push(centsAtBase);
  for (let d = 1; d <= 30; d++) {
    push(centsAtBase + d);
    push(centsAtBase - d);
  }
  const span = hi - lo;
  if (span > 0) {
    const stride = Math.max(1, Math.ceil(span / 60));
    for (let c = lo; c <= hi; c += stride) push(c);
    push(lo);
    push(hi);
  }
  candidates.sort((a, b) => Math.abs(a - centsAtBase) - Math.abs(b - centsAtBase));
  let searched = 0;
  for (const cents of candidates) {
    const price = cents / 100;
    searched++;
    const rescued = lawfulWindowRescue({
      cards: input.cards,
      price,
      targetEdge: input.targetEdge,
      targetWinRate: winMass,
      maxWinCap: input.maxWinCap,
      nearMissMin: input.nearMissMin,
      winRateTol: input.winRateTol,
      currentWeights: input.currentWeights,
      pinnedShares: input.pinnedShares,
    });
    if (rescued === null) continue;
    return {
      bestPrice: price,
      bestResult: rescued,
      searched,
      fellBackToBase: false,
      taggedAccuracyHit: tagged ? true : null,
      snapNodesSpent: 0,
    };
  }
  return null;
}

/**
 * TRUE when the hard-hold sweep produced at least one non-error candidate
 * ANYWHERE in the evaluated band (not necessarily the chosen `bestResult` — a
 * clean snap may lose the tie-break to a closer-but-unsnapped candidate, but
 * that still means the hard hold is FEASIBLE at some in-budget price, so no
 * fallback is warranted). Conservative: only falls back when the hard hold is
 * feasible NOWHERE in the band.
 */
function hardFeasibleSomewhere(result: SearchBestPriceResultCore): boolean {
  return isShapeWeightsSuccess(result.bestResult);
}

/**
 * Ruleset delta 9 seed list: the in-band cents where a card's band membership
 * flips. Banding is `v ≥ 5·price` GRAIL / `v ≥ price` WIN / `v ≥ 0.5·price`
 * NEARMISS / else DUST, so per usable card value `v` the price-space
 * breakpoints are `v/5`, `v`, `2v`. With integer-cent prices the upper-band
 * side of a breakpoint `b` is the cent `floor(b·100 + ε)` and the lower-band
 * side is the next cent up — both are seeded (the physics differ on each
 * side). Over-cap / non-positive values are skipped (their exclusion is
 * price-independent, no breakpoint exists). Deduped, clipped to
 * `[loCents, hiCents]`, sorted nearest-to-base first (ties: lower cent) so a
 * capped spend keeps the most-relevant seeds — deterministic by construction.
 * Exported for the `packs/__checks__` harness (boundary-math contract).
 */
export function segmentBoundaryCents(args: {
  cards: readonly { value: number }[];
  maxWinCap: number | undefined;
  loCents: number;
  hiCents: number;
  centsAtBase: number;
}): number[] {
  const { cards, maxWinCap, loCents, hiCents, centsAtBase } = args;
  const out = new Set<number>();
  const push = (c: number) => {
    if (c > 0 && c >= loCents && c <= hiCents) out.add(c);
  };
  for (const card of cards) {
    const v = card.value;
    if (!Number.isFinite(v) || !(v > 0)) continue;
    if (maxWinCap !== undefined && v > maxWinCap) continue;
    for (const boundaryCents of [v * 100, v * 200, v * 20]) {
      const bc = Math.floor(boundaryCents + 1e-6);
      push(bc);
      push(bc + 1);
    }
  }
  return [...out].sort((a, b) => {
    const da = Math.abs(a - centsAtBase);
    const db = Math.abs(b - centsAtBase);
    return da !== db ? da - db : a - b;
  });
}

function searchBestPriceForCleanSnapCore(input: {
  cards: { value: number }[];
  basePrice: number;
  targetEdge: number;
  targetWinRate: number;
  maxWinCap?: number;
  nearMissMin?: number;
  winRateTol?: number;
  maxPriceChangePct?: number;
  taggedWinRate?: number;
  upwardPriceExtensionPct?: number;
  preferHigherEdge?: boolean;
  currentWeights?: number[];
  pinnedShares?: ShapeWeightsPinnedShare[];
  holdWinRate?: boolean;
  holdWinRateHard?: boolean;
  disperseLoss?: boolean;
  seedSegmentBoundaries?: boolean;
  niceGridPolish?: boolean;
}): SearchBestPriceResultCore {
  const {
    cards,
    basePrice,
    targetEdge,
    targetWinRate,
    maxWinCap,
    nearMissMin,
    winRateTol,
    currentWeights,
    pinnedShares,
  } = input;
  const maxPriceChangePct = input.maxPriceChangePct ?? 0.25;
  const upwardPriceExtensionPct = Math.max(0, input.upwardPriceExtensionPct ?? 0);
  const taggedWinRate = input.taggedWinRate;
  const tagged = typeof taggedWinRate === "number" && Number.isFinite(taggedWinRate);
  const preferHigherEdge = input.preferHigherEdge === true;
  const holdWinRate = input.holdWinRate === true;
  const holdWinRateHard = input.holdWinRateHard === true;
  const disperseLoss = input.disperseLoss === true;
  const seedSegmentBoundaries = input.seedSegmentBoundaries === true;
  const niceGridPolish = input.niceGridPolish === true;

  // PLAN-WIDE tagged-snap DFS budget (perf-incident fix). ONE mutable counter
  // shared across every candidate price's snap so the all-nice enumeration is
  // bounded per PLAN, not per candidate — a lottery pack with many win cards used
  // to run the full per-snap cap at all 320 candidates and grind for seconds.
  // Proportional to the requested band (see `taggedPlanNodeBudget`): the DEFAULT
  // ±10% path (the concurrent stampede path) stays tight; the manual ±60% wide-
  // probe earns a larger budget. Tagged mode only (the untagged path never runs
  // `snapTaggedPer100k`); a fresh budget every call keeps each plan independent +
  // deterministic.
  const nodeBudget: SnapNodeBudget | undefined = tagged
    ? { remaining: taggedPlanNodeBudget(maxPriceChangePct) }
    : undefined;
  const nodeBudgetInitial = nodeBudget?.remaining ?? 0;
  // DFS nodes this plan's snaps have spent so far (initial budget minus what's
  // left). Computed at each return so the perf gate can pin it. 0 when untagged.
  const snapNodesSpent = (): number =>
    nodeBudget !== undefined ? nodeBudgetInitial - nodeBudget.remaining : 0;

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
      ...(nodeBudget !== undefined ? { nodeBudget } : {}),
      ...(currentWeights !== undefined ? { currentWeights } : {}),
      // Retune V2 pins: held exact at every candidate price.
      ...(pinnedShares !== undefined && pinnedShares.length > 0
        ? { pinnedShares }
        : {}),
      // A tagged pack's win-rate is a HARD design target — pin it (no float-up,
      // no cheapest-winner cap exemption) so the achieved win-rate can land on
      // the tag rather than drifting up while the price search hunts for a price
      // that hits BOTH the tag win-rate and clean odds.
      ...(tagged ? { winRateIsHard: true } : {}),
      // Untagged WIN-RATE HOLD (owner-lens item 4): cap the soft float at
      // design + 5pp at every candidate price (no-op in tagged mode).
      ...(holdWinRate && !tagged ? { holdWinRate: true } : {}),
      // Untagged WIN-RATE HOLD — HARD (spike fix): pin the win-rate at design AND
      // cap the cheapest winner at every candidate price (no-op in tagged mode).
      // This CORE function runs a single arm per call — the graceful fallback
      // between hard and soft lives in the public `searchBestPriceForCleanSnap`
      // wrapper above, which calls this core once per arm.
      ...(holdWinRateHard && !tagged ? { holdWinRateHard: true } : {}),
      // LOSS-MASS DISPERSION (owner-lens item 10): re-spread the free-dust band
      // at fixed mass + EV at every candidate price (edge/win-rate untouched).
      ...(disperseLoss ? { disperseLoss: true } : {}),
      // NICE-GRID POST-PASS (wave 7): polish accepted tier-G tagged snaps onto
      // the human-nice grid at every candidate price (no-op untagged / N / P).
      ...(niceGridPolish ? { niceGridPolish: true } : {}),
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
      snapNodesSpent: snapNodesSpent(),
    };
  }

  // ── Price-independent no-dust pre-check (§Rule Set fix) ──────────────
  // Over the USABLE cards (positive value, under the max-win cap — both
  // price-independent facts), a dust card demands `price > 2·min` while a
  // winner demands `price ≤ max`. When `2·min ≥ max` the demands are
  // disjoint at EVERY price: the sweep would burn its whole budget
  // re-proving the same `no-dust-cards` refusal at every cent. Evaluate the
  // base ONCE and return the disabled-path shape (`searched: 1`); the base
  // result carries the `priceIndependent` limit for the honest plan copy.
  // (`targetWinRate > 0` guard: with a zero win target no winner is needed,
  // so a high enough price CAN still shape the pool.)
  if (targetWinRate > 0) {
    let usableMin = Infinity;
    let usableMax = -Infinity;
    for (const c of cards) {
      const v = c.value;
      if (!(v > 0) || !Number.isFinite(v)) continue;
      if (maxWinCap !== undefined && v > maxWinCap) continue;
      if (v < usableMin) usableMin = v;
      if (v > usableMax) usableMax = v;
    }
    if (usableMax > 0 && 2 * usableMin >= usableMax) {
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
        snapNodesSpent: snapNodesSpent(),
      };
    }
  }

  // ── Evaluation budget ───────────────────────────────────────────────
  // `MAX_CANDIDATES` is the TOTAL evaluation budget (each candidate runs a
  // full `shapeWeights`, so cost is bounded by this number, not by the band):
  //   • Default mode (legacy clean-snap): 50.
  //   • TAGGED MODE: 320 — the strict 0.01pp accuracy gate needs headroom.
  //   • Upward-boosted (chip-strip edge nudge): 800.
  //
  // HOW THE BUDGET IS SPENT — three phases, all inside the requested band
  // (fixes the owner-reported band truncation: the old builder walked ±1¢
  // outward and STOPPED at the cap, so a 50-candidate budget only ever
  // explored ±25 CENTS of the requested band — on a $10+ pack clean-snap
  // prices provably sat inside the allowance but were never evaluated):
  //   1. FINE (~50%): 1¢ outward walk around base — densest where the
  //      "tiny nudge for clean odds" snaps live.
  //   2. COARSE (~30%): even-stride grid across the WHOLE remaining band,
  //      band endpoints always included — every part of the requested
  //      allowance is reachable regardless of pack price.
  //   3. REFINE: 1¢ sweep around the best hit beyond the fine zone,
  //      polishing a coarse hit to its exact best cent.
  //   4. OFFSET passes: any leftover budget re-walks the grid at halved
  //      offsets, densifying coverage until the budget is spent (cheap packs
  //      end up with full 1¢ coverage; expensive packs keep a bounded grid).
  //   5. SEGMENT-SEED BONUS ROUND (retune arm only, ruleset delta 9): the
  //      in-band cents where a card's band membership flips (price = v, 2v,
  //      v/5 — both sides of each crossing) — feasibility breakpoints where
  //      isolated snap-capable needles cluster. Runs AFTER phases 1-4 on an
  //      EXTRA allowance (~20% on top of the budget), so the seeded
  //      enumeration is a strict SUPERSET of the unseeded one — a seeded
  //      sweep can never land on a worse plan than the same sweep without
  //      seeds (spending seeds from the shared budget instead was measured
  //      to cannibalize grid cents and regress snapped fleet plans).
  const upwardBoosted = upwardPriceExtensionPct > 0;
  const MAX_CANDIDATES = upwardBoosted ? 800 : tagged ? 320 : 120;
  const centsAtBase = Math.round(basePrice * 100);
  const downCents = Math.max(0, Math.floor(basePrice * maxPriceChangePct * 100));
  // Upward span = the LARGER of the symmetric ±maxPriceChangePct band and the
  // operator's explicit upwardPriceExtensionPct (a chip-strip nudge can push
  // far past the band to land both clean odds AND the raised edge target).
  const upCents = Math.max(
    downCents,
    Math.floor(basePrice * upwardPriceExtensionPct * 100),
  );

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
  //   Tier 1b: nmTier (retune path only — near-miss floor shortfall, 1pp buckets).
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
    /**
     * §niceness: tagged mode, snapped successes only — the count of
     * non-exempt planned cards OFF the human-nice grid (0 = all nice).
     * 0 for untagged / unsnapped / error candidates (inert — those are
     * already outranked by the earlier tiers). Sits BELOW tag accuracy and
     * snappedness and ABOVE price distance: "all-nice > partially-nice >
     * per-100k-exact", never overriding tag exactness / edge window / caps.
     */
    niceTier: number;
    /**
     * NEAR-MISS INTEGRITY (retune path only — owner incident "Tails?" /
     * "Sealed Titan", 2026-07-06): the candidate's near-miss shortfall vs the
     * requested floor, bucketed in 1pp bins (0 = floor fully funded). The
     * price sweep is otherwise near-miss-blind: two equally-clean candidates
     * cents apart can differ 5pp in how much of the pack's DESIGNED "almost!"
     * band survives (a lower price shrinks the loss-EV budget), and centsDist
     * would pick the starved one. Sits BELOW snap-cleanness/niceness (clean
     * odds stay a must) and ABOVE price distance. 0 (inert) for legacy
     * callers (`disperseLoss` unset) and when no floor was requested —
     * ordering byte-identical for them.
     */
    nmTier: number;
    centsDist: number;
    edgeDrift: number;
  };
  const nmTierActive = disperseLoss && (nearMissMin ?? 0) > 0;
  const scoreOf = (price: number, result: ShapeWeightsResult): Scored => {
    let snapPriority: number;
    let edgeDrift: number;
    let winRateTier: number;
    let edgeBand: number;
    let niceTier: number;
    let nmTier: number;
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
      // Niceness (shared helper — the engine's `allNice` and the plan
      // projection count with the same grid, so they can never disagree).
      niceTier =
        tagged && isSnapped
          ? countOffNicePct(result.weights, result.niceExemptIdx)
          : 0;
      // Near-miss integrity: 1pp shortfall buckets (rounded, so snap-rung
      // jitter under half a point never moves the price).
      nmTier = nmTierActive
        ? Math.round(Math.max(0, (nearMissMin ?? 0) - result.risk.nearMiss) * 100)
        : 0;
    } else {
      snapPriority = 3;
      edgeDrift = Infinity;
      winRateTier = tagged ? 2 : 0;
      // Failed candidates land in the worst (largest positive) band so they
      // lose to every success.
      edgeBand = preferHigherEdge ? Number.MAX_SAFE_INTEGER : 0;
      niceTier = 0;
      nmTier = nmTierActive ? Number.MAX_SAFE_INTEGER : 0;
    }
    return {
      price,
      result,
      winRateTier,
      edgeBand,
      snapPriority,
      niceTier,
      nmTier,
      centsDist: Math.abs(Math.round(price * 100) - centsAtBase),
      edgeDrift,
    };
  };

  // Lexicographic comparator: winRateTier < edgeBand < snapPriority <
  // niceTier < nmTier < centsDist < edgeDrift. In default mode winRateTier +
  // edgeBand are always 0 → effectively starts at snapPriority (niceTier is
  // always 0 untagged, nmTier always 0 off the retune path — ordering
  // byte-identical to the pre-niceness comparator for legacy callers).
  const lexBetter = (a: Scored, b: Scored): boolean =>
    a.winRateTier < b.winRateTier ||
    (a.winRateTier === b.winRateTier && a.edgeBand < b.edgeBand) ||
    (a.winRateTier === b.winRateTier &&
      a.edgeBand === b.edgeBand &&
      a.snapPriority < b.snapPriority) ||
    (a.winRateTier === b.winRateTier &&
      a.edgeBand === b.edgeBand &&
      a.snapPriority === b.snapPriority &&
      a.niceTier < b.niceTier) ||
    (a.winRateTier === b.winRateTier &&
      a.edgeBand === b.edgeBand &&
      a.snapPriority === b.snapPriority &&
      a.niceTier === b.niceTier &&
      a.nmTier < b.nmTier) ||
    (a.winRateTier === b.winRateTier &&
      a.edgeBand === b.edgeBand &&
      a.snapPriority === b.snapPriority &&
      a.niceTier === b.niceTier &&
      a.nmTier === b.nmTier &&
      a.centsDist < b.centsDist) ||
    (a.winRateTier === b.winRateTier &&
      a.edgeBand === b.edgeBand &&
      a.snapPriority === b.snapPriority &&
      a.niceTier === b.niceTier &&
      a.nmTier === b.nmTier &&
      a.centsDist === b.centsDist &&
      a.edgeDrift < b.edgeDrift);

  let best: Scored = scoreOf(basePrice, baseResult);

  // ── Base-prefer early return ─────────────────────────────────────────
  // DEFAULT MODE: if the base price already produced a snapped (and
  // skew-matching) result, prefer it — never deviate without reason.
  // TAGGED MODE: ALSO require base to satisfy the 0.01pp win-rate gate AND
  //   land ALL-NICE (§niceness: a merely per-100k-exact base must not stop
  //   the hunt for round numbers elsewhere in the band).
  // PREFER-HIGHER-EDGE MODE: the sweep MUST run — even if base snaps cleanly,
  //   a HIGHER-priced candidate may give the operator the edge they asked for.
  // Otherwise the sweep MUST run — the owner's accuracy requirement is
  // the hard primary.
  const baseQualifiesForEarlyReturn = preferHigherEdge
    ? false
    : tagged
      ? best.winRateTier === 0 && best.snapPriority === 0 && best.niceTier === 0
      : best.snapPriority === 0;
  if (baseQualifiesForEarlyReturn) {
    return {
      bestPrice: basePrice,
      bestResult: baseResult,
      searched: 1,
      fellBackToBase: false,
      taggedAccuracyHit: tagged ? true : null,
      snapNodesSpent: snapNodesSpent(),
    };
  }

  // ── Phased evaluation (fine → coarse grid → refine) ─────────────────
  // Deterministic: fixed phase order, fixed walk order inside each phase.
  // All phases draw from the ONE `MAX_CANDIDATES` budget (base used 1).
  const seenCents = new Set<number>([centsAtBase]);
  const loCents = centsAtBase - downCents;
  const hiCents = centsAtBase + upCents;
  // The evaluation cap: `MAX_CANDIDATES` through phases 1-4 (byte-identical
  // legacy enumeration); the segment-seed bonus round (phase 5) RAISES it by
  // its own allowance so seeds never displace a grid cent the unseeded sweep
  // would have evaluated (the superset guarantee).
  let candidateCap = MAX_CANDIDATES;
  const evaluateCents = (cents: number): boolean => {
    if (cents <= 0 || cents < loCents || cents > hiCents) return false;
    if (seenCents.has(cents) || searched >= candidateCap) return false;
    seenCents.add(cents);
    const price = cents / 100;
    const scored = scoreOf(price, runAt(price));
    searched += 1;
    if (lexBetter(scored, best)) best = scored;
    return true;
  };

  // Once a top-tier hit (clean snap, matching skew, within-tol win-rate for
  // tagged — and ALL-NICE for tagged, §niceness) exists at distance k and
  // every cent ≤ k has been evaluated, no farther candidate can beat it —
  // centsDist is the deciding tier from there. Without the niceTier guard the
  // tagged sweep would settle at the nearest per-100k-exact cent and never
  // reach the round-number assignment farther out (fixture F2: Δ71¢).
  // The nmTier guard is the same fix for near-miss integrity ("Sealed
  // Titan"): a clean-but-starved candidate near base must not stop the walk
  // before a fully-funded candidate farther out is seen.
  // Exception: preferHigherEdge keeps hunting (edgeBand outranks centsDist).
  const topTierAt = (d: number): boolean =>
    !preferHigherEdge &&
    best.winRateTier === 0 &&
    best.snapPriority === 0 &&
    (!tagged || best.niceTier === 0) &&
    best.nmTier === 0 &&
    best.centsDist <= d;

  // Phase 1 — FINE: 1¢ outward walk (densest near base).
  const fineBudget = Math.max(10, Math.floor((MAX_CANDIDATES - 1) * 0.5));
  const maxDelta = Math.max(downCents, upCents);
  let fineUsed = 0;
  let fineRadius = 0;
  for (let d = 1; d <= maxDelta && fineUsed < fineBudget; d++) {
    if (evaluateCents(centsAtBase + d)) fineUsed += 1;
    if (fineUsed < fineBudget && evaluateCents(centsAtBase - d)) fineUsed += 1;
    fineRadius = d;
    if (topTierAt(d)) break;
  }
  const settledNear = topTierAt(fineRadius);

  // Phase 2 — COARSE: even-stride grid across the rest of the band; the band
  // endpoints are evaluated first so the edges of the allowance are always
  // reachable no matter the pack price.
  const remainingSpan =
    Math.max(0, upCents - fineRadius) + Math.max(0, downCents - fineRadius);
  let stride = 0;
  if (!settledNear && remainingSpan > 0 && searched < MAX_CANDIDATES) {
    evaluateCents(hiCents);
    evaluateCents(loCents);
    const coarseBudget = Math.max(2, Math.floor((MAX_CANDIDATES - 1) * 0.3));
    stride = Math.max(1, Math.ceil(remainingSpan / coarseBudget));
    for (
      let g = fineRadius + stride;
      g <= maxDelta && searched < MAX_CANDIDATES;
      g += stride
    ) {
      evaluateCents(centsAtBase + g);
      evaluateCents(centsAtBase - g);
    }
  }

  // Phase 3 — REFINE: 1¢ sweep around the best hit beyond the fine zone (a
  // coarse grid point rarely sits on the exact best cent).
  const bestCents = Math.round(best.price * 100);
  if (stride > 1 && Math.abs(bestCents - centsAtBase) > fineRadius) {
    for (let r = 1; r < stride && searched < MAX_CANDIDATES; r++) {
      evaluateCents(bestCents + r);
      evaluateCents(bestCents - r);
    }
  }

  // Phase 4 — OFFSET passes: spend any remaining budget densifying the grid,
  // one residue class per pass (offset 1, 2, … stride−1). Snap-capable cents
  // can be isolated needles (the anchored path may admit exactly ONE clean
  // price in the whole band), so leftover budget shrinks the grid gap until
  // either the budget or the offsets run out — cheap packs end up with full
  // 1¢ coverage of the entire band.
  for (
    let offset = 1;
    offset < stride && searched < MAX_CANDIDATES && !settledNear;
    offset++
  ) {
    for (
      let g = fineRadius + offset;
      g <= maxDelta && searched < MAX_CANDIDATES;
      g += stride
    ) {
      evaluateCents(centsAtBase + g);
      evaluateCents(centsAtBase - g);
    }
  }

  // Phase 5 — SEGMENT-SEED BONUS ROUND (ruleset delta 9, retune arm only):
  // evaluate the banding-boundary cents nearest-first on an EXTRA allowance
  // (candidateCap is raised, so phases 1-4 above ran the byte-identical
  // legacy enumeration first — the seeded sweep evaluates a strict SUPERSET
  // and can never pick a worse plan). If a seed takes the lead, the leftover
  // allowance polishes a 1¢ outward walk around it (a boundary hit rarely
  // sits on its own exact best cent, same reasoning as the REFINE phase).
  // Skipped when the fine walk settled a provably-optimal near hit (every
  // seed is farther, so centsDist already decides against it).
  if (seedSegmentBoundaries && !settledNear) {
    const seedAllowance = Math.max(6, Math.floor((MAX_CANDIDATES - 1) * 0.2));
    candidateCap = searched + seedAllowance;
    const bestBefore = best;
    const seeds = segmentBoundaryCents({
      cards,
      maxWinCap,
      loCents,
      hiCents,
      centsAtBase,
    });
    for (const c of seeds) {
      if (searched >= candidateCap) break;
      evaluateCents(c);
    }
    if (best !== bestBefore) {
      const seedCents = Math.round(best.price * 100);
      for (let d = 1; d <= maxDelta && searched < candidateCap; d++) {
        evaluateCents(seedCents + d);
        if (searched < candidateCap) evaluateCents(seedCents - d);
      }
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
    snapNodesSpent: snapNodesSpent(),
  };
}

/** Narrow a `ShapeWeightsResult` to its success arm. */
function isShapeWeightsSuccess(r: ShapeWeightsResult): r is ShapeWeightsSuccess {
  return "weights" in r;
}
