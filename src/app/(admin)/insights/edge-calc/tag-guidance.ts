/**
 * TAG GUIDANCE ENGINE — the retune V2 ruleset's feasibility + suggestion brain
 * for HARD-TAGGED lottery packs (ruleset §2, [math LAW 1–13]).
 *
 * Pure and dependency-free beyond the dep-free risk engine + auto-target
 * helpers: no DB, no React, no Decimal. Rebuilds the solver's EXACT
 * feasibility interval OUTSIDE a solve (sharing `waterFillWinEv` /
 * `bandEvForBeta` / the β endpoints with `shapeWeights`, so the interval
 * identity is structural, not re-derived), classifies WHY a tagged plan is
 * infeasible, and emits a RANKED list of typed, PROVEN suggestions — every
 * emitted suggestion re-runs the LAW-1 interval with the intervention applied
 * and only ships when the engine would accept it; the top-ranked suggestion
 * additionally round-trips the real solver.
 *
 * The model (LAW 1, verified 30/30 + 61/61 + 138/138 against the engine):
 *
 *   E*    = P · (1 − e*)                        — target EV
 *   EVmin = W(β_max) + m·bandEv(NM, β_hi) + d·bandEv(DUST, β_hi)
 *   EVmax = W(β_floor) + m·bandEv(NM, β_lo) + d·bandEv(DUST, β_lo)
 *   feasible ⟺ E* ∈ [EVmin − 1e-6, EVmax + 1e-6]
 *
 * where `W(β)` water-fills the tag mass t over the win/grail values under the
 * never-inflate anchor caps (grail monotone running-min), `m` = the near-miss
 * seed if NM cards exist else 0, and `d = 1 − t − m`. The engine additionally
 * accepts (a) down to `t·v_cheapestWinner + loss-cheap` via its RC4
 * cheapest-winner knob and (b) up to `ONE_SIDED_EDGE_EXCESS_TOL` (0.25pp) of
 * edge excess via the one-sided-up acceptance — both folded into the
 * `engine-accepting` check every suggestion proof uses.
 *
 * NEVER emit an unproven suggestion; every infeasible verdict carries ≥ 1
 * suggestion or an explicit `no-fix-under-constraints` with the reason.
 *
 * ALSO hosts the UNTAGGED degenerate-loss-ladder guidance
 * ({@link computeUntaggedGuidance}) — same `TagGuidance` shape, same proof
 * discipline, for feasible untagged plans whose loss ladder collapsed onto a
 * single carrier card (floor-pinned cards / win-rate float — see the section
 * comment below).
 */

import {
  BETA_HI,
  BETA_LO,
  BETA_WIN_FLOOR,
  BETA_WIN_MAX,
  ONE_SIDED_EDGE_EXCESS_TOL,
  TAGGED_WINRATE_TOLERANCE,
  bandEvForBeta,
  waterFillWinEv,
  shapeWeights,
  type ShapeWeightsPinnedShare,
  type ShapeWeightsRelaxation,
} from "./risk";
import {
  DEFAULT_EDGE_CURVE,
  SELECTABLE_TAG_HIT_RATES,
  TAGGED_WRITE_WINRATE_TOLERANCE,
  autoMaxWinCap,
  autoTargetEdge,
  type EdgeCurveConfig,
} from "../../packs/_lib/auto-targets";

// ─── Types (ruleset §2.3 / LAW 13) ────────────────────────────────────────────

export type TuneSuggestionKind =
  | "price-edge-exact"
  | "price-move"
  | "add-card"
  | "edge-bump"
  | "raise-cap"
  | "loosen-cheapest-winner"
  | "repair-monotone"
  | "retag"
  | "untag"
  | "remove-dead-card"
  | "accept-as-is"
  | "no-fix-under-constraints";

export type TuneSuggestion = {
  kind: TuneSuggestionKind;
  /**
   * Machine-readable parameters (all serializable):
   *   add-card:        { band, valueMin, valueMax, suggestedValue, expectedShare }
   *   price-*:         { price, edgeTarget? } — pre-fill the price field
   *   edge-bump:       { edgeTarget }
   *   raise-cap:       { maxWinCap }
   *   repair-monotone: { cardId?, vsCardId?, cardValue, vsCardValue, maxOddsPct }
   *   retag:           { action:"retag", liveRate, proposedTag, tierHitRate, tierTag, tierDbLabel }
   *   untag:           { action:"untag", liveRate }
   *   remove-dead-card:{ cardId?, cardValue }
   */
  params: Record<string, number | string>;
  /** Plain-words copy with the exact numbers baked in. */
  humanCopy: string;
  /**
   * The LAW-1 interval AFTER the intervention. `feasibleAfter` is TRUE for
   * every ranked suggestion (unproven suggestions are never emitted);
   * informational entries (`remove-dead-card`, `no-fix-under-constraints`)
   * carry their honest (possibly false) verdict. `solverVerified` is set on
   * the top-ranked suggestion after a real `shapeWeights` round-trip.
   */
  proof: {
    evMinAfter: number;
    evMaxAfter: number;
    feasibleAfter: boolean;
    solverVerified?: boolean;
  };
};

export type TagGuidance = {
  feasibility: {
    evTarget: number;
    evMin: number;
    evMax: number;
    feasible: boolean;
    saturated: boolean;
    direction: "ok" | "need-ev-down" | "need-ev-up";
    components: {
      winEvMin: number;
      winEvMax: number;
      nmMass: number;
      dustMass: number;
      capSum: number;
    };
    /**
     * TAG-FIT verdict ({@link monotoneFitLocal}) — present on TAGGED guidance
     * only. `monotoneFeasible` answers "can an HONEST ladder (never-inflate
     * caps, loss band cheap-heavy monotone, only the forced cap-overflow
     * residual on the cheapest winner) pay the tag at the target edge AT THE
     * PLAN PRICE?" — the engine may still ship such a pool through its
     * degenerate escape hatches (RC4 cheapest-winner collapse / broad ∝v^-β
     * spill), which is exactly the shape the owner flags. `monotoneEvMin/Max`
     * are the honest-ladder window at the plan price (0/0 when structurally
     * impossible).
     */
    shapeFit?: {
      monotoneFeasible: boolean;
      monotoneEvMin: number;
      monotoneEvMax: number;
    };
  };
  suggestions: TuneSuggestion[];
};

export type TagGuidanceInput = {
  /** Pool card values (raw, pre-cap-filter), aligned with `currentWeights`. */
  cards: { value: number }[];
  /** LIVE pool weights aligned to `cards`; a staged-in card carries 0. */
  currentWeights: number[];
  /** Optional cardIds aligned to `cards` — threaded into per-card params. */
  cardIds?: string[] | null;
  price: number;
  /** The resolved per-pack curve target at `price`. */
  targetEdge: number;
  /** The HARD tag t — the exact share of winning opens. */
  tag: number;
  /** The seeded near-miss floor (0 for a plain tagged pack). */
  nearMissMin: number;
  /** The resolved jackpot cap at `price`. */
  maxWinCap: number;
  /**
   * Auto-target config for price-sweep suggestions (cap + curve re-derive at
   * candidate prices). Omit/null ⇒ price suggestions are skipped.
   */
  cfg?: { globalCap: number; maxMultCeiling: number; edgeCurve?: EdgeCurveConfig } | null;
  /** TRUE when the operator pinned the price — price suggestions are off. */
  pinPrice?: boolean;
  /** Live pool win-rate (for the retag-to-live suggestion). */
  liveWinRate?: number | null;
  /** Live pool near-miss mass (the retag suggestion's NM seed). */
  liveNearMiss?: number | null;
  /**
   * Owner-typed pins (staged arm) aligned to `cards` by index. The staged
   * solve holds these EXACT (`shapeWeights` pinnedShares) while
   * `currentWeights` stays the LIVE anchor — the guidance must model the SAME
   * constraint set, else its "computed fix" solves a different problem and is
   * un-appliable (owner incident "1% Bidoof": live-odds model said move to
   * $3.35 @ 11.257%, but the typed pins fix the payout at a point where that
   * price still refuses). Pinned cards enter the interval as fixed
   * point-masses; omit/empty ⇒ live-arm behavior, byte-identical.
   */
  pinnedShares?: ShapeWeightsPinnedShare[] | null;
};

// ─── Band model at a (price, cap) ─────────────────────────────────────────────

type BandModel = {
  price: number;
  cap: number;
  tag: number;
  m: number;
  d: number;
  winValues: number[];
  /** Never-inflate caps (grail monotone running-min applied), aligned to winValues. */
  winCaps: number[];
  /** Raw (un-tightened) current odds per win card — for inversion detection. */
  winCapsRaw: number[];
  nmValues: number[];
  dustValues: number[];
  evMin: number;
  evMax: number;
  /** Engine floor including the RC4 cheapest-winner knob. */
  evMinKnob: number;
  /** Σ caps over FREE (unpinned) win cards (Infinity when any is uncapped). */
  capSum: number;
  saturated: boolean;
  capDroppedCount: number;
  maxDroppedValue: number;
  /** Win-band EV at the interval endpoints (pins-inclusive). */
  winEvMin: number;
  winEvMax: number;
  /** Owner-pinned fixed contributions per band (0 when no pins). */
  winFixedMass: number;
  winFixedEv: number;
  nmFixedEv: number;
  dustFixedEv: number;
  /** Number of pins actually applied (copy switch). */
  pinnedCount: number;
};

function buildModel(args: {
  cards: readonly { value: number }[];
  currentWeights: readonly number[];
  price: number;
  cap: number;
  tag: number;
  nearMissMin: number;
  /** Extra dust value(s) being trialed (add-card proofs). */
  extraDust?: readonly number[];
  /** Extra win/grail value being trialed (uncapped — LAW 6). */
  extraWin?: number | null;
  /** Skip the grail monotone tighten (repair-monotone proofs). */
  noMonotoneTighten?: boolean;
  /**
   * Owner-typed pins — card index → EXACT share. A pinned card's mass is
   * FIXED in whatever band its value occupies at this (price, cap): it
   * contributes share·value to the interval as a POINT and is excluded from
   * the free water-fill / band-fill budgets, mirroring `shapeWeights`
   * pinnedShares. Absent ⇒ byte-identical legacy model.
   */
  pinnedShares?: readonly ShapeWeightsPinnedShare[] | null;
}): BandModel {
  const { price, cap, tag, nearMissMin } = args;

  const pinByIdx = new Map<number, number>();
  if (args.pinnedShares) {
    for (const p of args.pinnedShares) {
      if (Number.isFinite(p.share) && p.share > 0) pinByIdx.set(p.index, p.share);
    }
  }

  let curTotal = 0;
  for (const w of args.currentWeights) {
    if (Number.isFinite(w) && w > 0) curTotal += w;
  }

  const winValues: number[] = [];
  const rawCaps: number[] = [];
  const nmValues: number[] = [];
  const dustValues: number[] = [];
  let capDroppedCount = 0;
  let maxDroppedValue = 0;
  let winFixedMass = 0;
  let winFixedEv = 0;
  let nmFixedMass = 0;
  let nmFixedEv = 0;
  let dustFixedMass = 0;
  let dustFixedEv = 0;
  let pinnedCount = 0;

  args.cards.forEach((c, idx) => {
    const v = c.value;
    if (!(v > 0)) return;
    if (v > cap) {
      capDroppedCount += 1;
      if (v > maxDroppedValue) maxDroppedValue = v;
      return;
    }
    const pin = pinByIdx.get(idx);
    if (v >= price) {
      if (pin !== undefined) {
        winFixedMass += pin;
        winFixedEv += pin * v;
        pinnedCount += 1;
        return;
      }
      winValues.push(v);
      const w = args.currentWeights[idx];
      // LAW 6: zero/absent current weight ⇒ UNCAPPED (a new card has no
      // advertised odds to protect); existing cards cap at their live odds.
      rawCaps.push(
        curTotal > 0 && Number.isFinite(w) && (w as number) > 0
          ? (w as number) / curTotal
          : Infinity,
      );
    } else if (v >= 0.5 * price) {
      if (pin !== undefined) {
        nmFixedMass += pin;
        nmFixedEv += pin * v;
        pinnedCount += 1;
        return;
      }
      nmValues.push(v);
    } else {
      if (pin !== undefined) {
        dustFixedMass += pin;
        dustFixedEv += pin * v;
        pinnedCount += 1;
        return;
      }
      dustValues.push(v);
    }
  });
  if (args.extraWin != null && args.extraWin >= price && args.extraWin <= cap) {
    winValues.push(args.extraWin);
    rawCaps.push(Infinity);
  }
  if (args.extraDust) {
    for (const v of args.extraDust) {
      if (v > 0 && v < 0.5 * price) dustValues.push(v);
    }
  }

  // Grail monotone running-min (risk.ts anchor semantics): walking grails
  // value-ASCENDING, each cap is min(own, every cheaper grail's cap). Hard
  // tags have NO cheapest-winner exemption.
  const winCaps = rawCaps.slice();
  if (!args.noMonotoneTighten) {
    const grailThreshold = 5 * price;
    const grailAsc = winValues
      .map((v, i) => ({ i, v }))
      .filter((x) => x.v >= grailThreshold)
      .sort((a, b) => a.v - b.v);
    let runningMin = Infinity;
    for (const { i } of grailAsc) {
      runningMin = Math.min(runningMin, rawCaps[i]!);
      winCaps[i] = runningMin;
    }
  }

  // Pins carve their mass out of each band's budget: the tag's free win mass,
  // the near-miss seed's free fill, and the residual dust mass all shrink by
  // the pinned point-masses (no pins ⇒ every Fixed term is 0, identical math).
  const tagFree = Math.max(0, tag - winFixedMass);
  const m =
    nmValues.length > 0 && nearMissMin > 0
      ? Math.max(0, nearMissMin - nmFixedMass)
      : 0;
  const d = 1 - tag - m - nmFixedMass - dustFixedMass;

  const nmLo = bandEvForBeta(nmValues, BETA_HI);
  const nmHi = bandEvForBeta(nmValues, BETA_LO);
  const dustLo = bandEvForBeta(dustValues, BETA_HI);
  const dustHi = bandEvForBeta(dustValues, BETA_LO);
  const lossLo = m * nmLo + Math.max(0, d) * dustLo + nmFixedEv + dustFixedEv;
  const lossHi = m * nmHi + Math.max(0, d) * dustHi + nmFixedEv + dustFixedEv;

  const winEvMin = waterFillWinEv(winValues, winCaps, tagFree, BETA_WIN_MAX) + winFixedEv;
  const winEvMax = waterFillWinEv(winValues, winCaps, tagFree, BETA_WIN_FLOOR) + winFixedEv;
  const evMin = winEvMin + lossLo;
  const evMax = winEvMax + lossHi;
  const cheapestWin = winValues.length > 0 ? Math.min(...winValues) : 0;
  const evMinKnob =
    winValues.length > 0
      ? Math.min(evMin, tagFree * cheapestWin + winFixedEv + lossLo)
      : evMin;

  let capSum = 0;
  for (const c of winCaps) capSum += c;
  const saturated = Number.isFinite(capSum) && capSum <= tagFree + 1e-12;

  return {
    price,
    cap,
    tag,
    m,
    d,
    winValues,
    winCaps,
    winCapsRaw: rawCaps,
    nmValues,
    dustValues,
    evMin,
    evMax,
    evMinKnob,
    capSum,
    saturated,
    capDroppedCount,
    maxDroppedValue,
    winEvMin,
    winEvMax,
    winFixedMass,
    winFixedEv,
    nmFixedEv,
    dustFixedEv,
    pinnedCount,
  };
}

/** Would the ENGINE accept target EV `evTarget` on this model at `targetEdge`? */
function engineAccepts(
  model: BandModel,
  evTarget: number,
  targetEdge: number,
): boolean {
  if (model.winValues.length === 0 || model.dustValues.length === 0) return false;
  if (!(model.d > 1e-9)) return false;
  if (evTarget < model.evMinKnob - 1e-6) return false;
  if (evTarget <= model.evMax + 1e-6) return true;
  // One-sided-up acceptance: the pool lands house-favorable; accepted when the
  // edge excess is within 0.25pp.
  const excess = 1 - model.evMax / model.price - targetEdge;
  return excess >= -1e-12 && excess <= ONE_SIDED_EDGE_EXCESS_TOL + 1e-12;
}

// ─── HONEST-LADDER fit (tag-fit verdict / shape-unfit) ────────────────────────

export type MonotoneFitWindow = {
  /** The honest-ladder EV window (per open) at the given (price, cap, tag). */
  evMin: number;
  evMax: number;
  /**
   * Witness ladders (fractions of 1) aligned to the INPUT cards: pinned cards
   * at their pinned share, cap-dropped / non-positive cards at 0. `minShares`
   * realizes `evMin` (win mass cheap-first under caps, loss mass dumped on the
   * cheapest loss card above the NM floor); `maxShares` realizes `evMax`
   * (win mass rich-first under caps, loss mass uniform).
   */
  minShares: number[];
  maxShares: number[];
};

/**
 * COMPOSE-SEAM: a LOCAL model of the engine's honest-ladder reachability —
 * NOT a call into `shapeWeights` internals. It mirrors the engine's band
 * split, never-inflate caps (grail running-min) and pin carving exactly like
 * {@link buildModel}, but deliberately EXCLUDES the engine's degenerate escape
 * hatches: no cheapest-winner EV exemption, no RC4 all-on-cheapest collapse,
 * no broad ∝v^-β cap spill. Those hatches are how the solver ships a
 * mis-tagged pool by concentrating the win band on one cheap carrier — the
 * exact shape the owner flags. What this DOES allow:
 *
 *   • WIN band: order-free fill of the tag mass under the never-inflate caps
 *     (win-band non-monotonicity is audit-protected legitimate). When the
 *     caps can't carry the tag (Σcaps < tagFree), the forced residual sits on
 *     the CHEAPEST free winner — the engine's one sanctioned overflow
 *     direction, at its MINIMAL magnitude.
 *   • LOSS band: internal monotone (a cheaper loss card is never LESS likely
 *     than a richer one — the house ladder shape `disperseLoss`/
 *     `enforceLossMonotone` protect) + the near-miss floor when free NM cards
 *     exist. Pins are carved out as point-masses exempt from the ordering.
 *
 * Returns `null` when NO honest ladder exists structurally (win mass with no
 * free winner, loss mass with no free loss card, pinned masses over budget,
 * NM floor unreachable under the loss-monotone uniform bound) — callers show
 * evMin/evMax as 0/0. Otherwise the reachable EV window + witness vectors.
 */
export function monotoneFitLocal(args: {
  cards: readonly { value: number }[];
  currentWeights: readonly number[];
  price: number;
  cap: number;
  /** The win-band mass the ladder must pay (the tag for tagged pools). */
  winMass: number;
  nearMissMin: number;
  pinnedShares?: readonly ShapeWeightsPinnedShare[] | null;
}): MonotoneFitWindow | null {
  const { price, cap, winMass, nearMissMin } = args;
  const n = args.cards.length;

  const pinByIdx = new Map<number, number>();
  if (args.pinnedShares) {
    for (const p of args.pinnedShares) {
      if (Number.isFinite(p.share) && p.share > 0) pinByIdx.set(p.index, p.share);
    }
  }
  let curTotal = 0;
  for (const w of args.currentWeights) {
    if (Number.isFinite(w) && w > 0) curTotal += w;
  }

  type FreeWin = { idx: number; v: number; cap: number };
  type FreeLoss = { idx: number; v: number; nm: boolean };
  const freeWin: FreeWin[] = [];
  const freeLoss: FreeLoss[] = [];
  let winFixedMass = 0;
  let winFixedEv = 0;
  let nmFixedMass = 0;
  let nmFixedEv = 0;
  let dustFixedMass = 0;
  let dustFixedEv = 0;
  const minShares = new Array<number>(n).fill(0);
  const maxShares = new Array<number>(n).fill(0);

  args.cards.forEach((c, idx) => {
    const v = c.value;
    if (!(v > 0) || v > cap) return;
    const pin = pinByIdx.get(idx);
    if (pin !== undefined) {
      minShares[idx] = pin;
      maxShares[idx] = pin;
      if (v >= price) {
        winFixedMass += pin;
        winFixedEv += pin * v;
      } else if (v >= 0.5 * price) {
        nmFixedMass += pin;
        nmFixedEv += pin * v;
      } else {
        dustFixedMass += pin;
        dustFixedEv += pin * v;
      }
      return;
    }
    if (v >= price) {
      const w = args.currentWeights[idx];
      freeWin.push({
        idx,
        v,
        cap:
          curTotal > 0 && Number.isFinite(w) && (w as number) > 0
            ? (w as number) / curTotal
            : Infinity,
      });
    } else {
      freeLoss.push({ idx, v, nm: v >= 0.5 * price });
    }
  });

  // Never-inflate grail running-min (value-ascending over grails ≥ 5·price).
  const grailAsc = freeWin
    .filter((x) => x.v >= 5 * price)
    .sort((a, b) => a.v - b.v);
  let runningMin = Infinity;
  for (const g of grailAsc) {
    runningMin = Math.min(runningMin, g.cap);
    g.cap = runningMin;
  }

  const tagFree = winMass - winFixedMass;
  if (tagFree < -1e-9) return null;
  if (tagFree > 1e-9 && freeWin.length === 0) return null;
  const lossFree = 1 - winMass - nmFixedMass - dustFixedMass;
  if (lossFree < -1e-9) return null;
  if (lossFree > 1e-9 && freeLoss.length === 0) return null;

  const freeNmCount = freeLoss.reduce((a, x) => a + (x.nm ? 1 : 0), 0);
  const nmFree =
    freeNmCount > 0 && nearMissMin > 0
      ? Math.max(0, nearMissMin - nmFixedMass)
      : 0;
  const nu = freeNmCount > 0 ? nmFree / freeNmCount : 0;
  const lossCnt = freeLoss.length;
  if (nu * lossCnt > Math.max(0, lossFree) + 1e-9) return null;

  // ── WIN fills (order-free under caps; forced residual on the cheapest) ──
  const asc = freeWin.slice().sort((a, b) => a.v - b.v);
  const fillWin = (order: readonly FreeWin[], shares: number[]): number => {
    let remaining = Math.max(0, tagFree);
    let ev = 0;
    for (const x of order) {
      const take = Math.min(x.cap, remaining);
      if (take > 0) {
        shares[x.idx] = take;
        ev += take * x.v;
        remaining -= take;
      }
      if (!(remaining > 1e-15)) {
        remaining = 0;
        break;
      }
    }
    if (remaining > 1e-15 && asc.length > 0) {
      // Saturated: the sanctioned overflow — the residual on the CHEAPEST.
      const cheapest = asc[0]!;
      shares[cheapest.idx] = (shares[cheapest.idx] ?? 0) + remaining;
      ev += remaining * cheapest.v;
    }
    return ev;
  };
  const winMinEv = fillWin(asc, minShares);
  const winMaxEv = fillWin(asc.slice().reverse(), maxShares);

  // ── LOSS layouts (internal monotone + NM floor) ─────────────────────────
  let lossMinEv = 0;
  let lossMaxEv = 0;
  if (lossCnt > 0) {
    const lf = Math.max(0, lossFree);
    const uniform = lf / lossCnt;
    let cheapest = freeLoss[0]!;
    for (const x of freeLoss) if (x.v < cheapest.v) cheapest = x;
    for (const x of freeLoss) {
      maxShares[x.idx] = uniform;
      lossMaxEv += uniform * x.v;
      minShares[x.idx] = nu;
      lossMinEv += nu * x.v;
    }
    const excess = lf - nu * lossCnt;
    if (excess > 0) {
      minShares[cheapest.idx] = (minShares[cheapest.idx] ?? 0) + excess;
      lossMinEv += excess * cheapest.v;
    }
  }

  const fixedEv = winFixedEv + nmFixedEv + dustFixedEv;
  return {
    evMin: winMinEv + lossMinEv + fixedEv,
    evMax: winMaxEv + lossMaxEv + fixedEv,
    minShares,
    maxShares,
  };
}

/**
 * Does the honest-ladder window admit the target EV at `price`? The down side
 * is sacred (the edge floor is never crossed); the up side carries the
 * engine's one-sided acceptance (≤ 0.25pp of edge excess).
 */
function monotoneFits(
  w: MonotoneFitWindow | null,
  evTarget: number,
  price: number,
): boolean {
  if (w === null || !(price > 0)) return false;
  if (evTarget < w.evMin - 1e-6) return false;
  if (evTarget <= w.evMax + 1e-6) return true;
  return (evTarget - w.evMax) / price <= ONE_SIDED_EDGE_EXCESS_TOL + 1e-12;
}

// ─── The engine ───────────────────────────────────────────────────────────────

const round2 = (v: number): number => Math.round(v * 100) / 100;
const pp = (frac: number): string => (frac * 100).toFixed(2);
const usd = (v: number): string => `$${v.toFixed(2)}`;

/**
 * Fixed suggestion ranking (LAW 12, extended): price levers → add-card →
 * edge-bump → raise-cap → repair-monotone → loosen-cheapest-winner → retag;
 * informational entries (dead cards, accept-as-is, no-fix) last.
 */
const SUGGESTION_RANK: Record<TuneSuggestionKind, number> = {
  "price-edge-exact": 0,
  "price-move": 0,
  "add-card": 1,
  "edge-bump": 2,
  "raise-cap": 3,
  "repair-monotone": 4,
  "loosen-cheapest-winner": 5,
  retag: 6,
  untag: 7,
  "remove-dead-card": 8,
  "accept-as-is": 9,
  "no-fix-under-constraints": 10,
};

/**
 * Absurdity ceiling on an "accept this edge as the target" (edge-bump)
 * suggestion (owner-lens Pattern 9f / rule 4). The edge-bump lifts the target
 * to whatever a saturated pool CAN pay, but on a badly mis-tagged pool that
 * ceiling is a house edge so high it is not a real product option — e.g. Divine
 * Order (a %10-tagged pool actually paying 30%) topped out at a ~59% edge, and
 * the guidance ranked "Accept 58.859%" as suggestion #1. Beyond this ceiling the
 * edge-bump is SUPPRESSED — the retag / restructure path is the honest fix, not
 * a rigged 59%-house-edge product. (Chosen at 0.25: 25% is already a very high
 * house edge for a lottery pack; the real fleet targets sit around 11%.)
 */
const MAX_ACCEPT_EDGE = 0.25;

export function computeTagGuidance(input: TagGuidanceInput): TagGuidance {
  const { price, targetEdge, tag } = input;
  const cfg = input.cfg ?? null;
  const evTarget = price * (1 - targetEdge);

  /** The per-pack curve target at a candidate price (pool-aware maxWin). */
  const targetEdgeAt = (p: number, capAtP: number, poolTop: number): number =>
    autoTargetEdge(
      { price: p, maxWin: Math.min(poolTop > 0 ? poolTop : capAtP, capAtP) },
      cfg?.edgeCurve ?? DEFAULT_EDGE_CURVE,
    );
  const capAt = (p: number): number =>
    cfg ? autoMaxWinCap(p, cfg, tag) : input.maxWinCap;
  const poolTopAt = (p: number): number => {
    const cap = capAt(p);
    let top = 0;
    for (const c of input.cards) {
      if (c.value > 0 && c.value <= cap && c.value > top) top = c.value;
    }
    return top;
  };

  // Owner pins (staged arm) — threaded into EVERY model this engine builds so
  // the interval, the direction verdict, and every suggestion proof describe
  // the SAME constraint set the staged solve enforces.
  const pins =
    input.pinnedShares != null && input.pinnedShares.length > 0
      ? input.pinnedShares
      : null;

  const modelAt = (p: number): { model: BandModel; eStar: number; evT: number } => {
    const cap = capAt(p);
    const model = buildModel({
      cards: input.cards,
      currentWeights: input.currentWeights,
      price: p,
      cap,
      tag,
      nearMissMin: input.nearMissMin,
      pinnedShares: pins,
    });
    const eStar = targetEdgeAt(p, cap, poolTopAt(p));
    return { model, eStar, evT: p * (1 - eStar) };
  };

  const base = buildModel({
    cards: input.cards,
    currentWeights: input.currentWeights,
    price,
    cap: input.maxWinCap,
    tag,
    nearMissMin: input.nearMissMin,
    pinnedShares: pins,
  });

  const feasibleRaw =
    evTarget >= base.evMin - 1e-6 && evTarget <= base.evMax + 1e-6;
  const direction: TagGuidance["feasibility"]["direction"] = feasibleRaw
    ? "ok"
    : evTarget < base.evMin
      ? "need-ev-down"
      : "need-ev-up";
  // The interval degenerates to a point when saturated with no loss-side
  // freedom — plain fixed-target price sweeps are then infeasible on EVERY
  // cent (LAW 2); the combined price+edge repair (LAW 9) applies instead.
  const pointInterval =
    base.saturated && base.evMax - base.evMin < 1e-4 * price;

  // ── TAG-FIT verdict (shape-unfit): the honest-ladder window at the plan
  //    price. Distinct from `feasibleRaw` — the engine can accept through its
  //    degenerate hatches (RC4 knob / spill) a tag no honest ladder carries.
  const baseFit = monotoneFitLocal({
    cards: input.cards,
    currentWeights: input.currentWeights,
    price,
    cap: input.maxWinCap,
    winMass: tag,
    nearMissMin: input.nearMissMin,
    pinnedShares: pins,
  });
  const monotoneFeasible = monotoneFits(baseFit, evTarget, price);
  const shapeFit = {
    monotoneFeasible,
    monotoneEvMin: baseFit?.evMin ?? 0,
    monotoneEvMax: baseFit?.evMax ?? 0,
  };

  const suggestions: TuneSuggestion[] = [];
  // Shape-unfit lead entries rank ABOVE the fixed kind ranking (see the sort).
  const leadSet = new Set<TuneSuggestion>();
  const proofOf = (m: BandModel, evT: number, eStar: number) => ({
    evMinAfter: m.evMin,
    evMaxAfter: m.evMax,
    feasibleAfter: engineAccepts(m, evT, eStar),
  });

  // ── 1/2. Price levers (LAW 7 + LAW 9) ─────────────────────────────────────
  const priceAllowed = cfg !== null && input.pinPrice !== true && price > 0;

  if (priceAllowed && pointInterval && !feasibleRaw) {
    // LAW 9 — saturated combo: the smallest house-favorable price. E0(P) is
    // piecewise constant (bands shift at crossings), so iterate twice (one
    // Newton step) then read the achieved edge at the chosen cent.
    let pCand = price;
    for (let iter = 0; iter < 3; iter++) {
      const { model, eStar } = modelAt(pCand);
      const e0 = (model.evMin + model.evMax) / 2;
      if (!(e0 > 0)) break;
      const next = Math.ceil((100 * e0) / (1 - eStar)) / 100;
      if (Math.abs(next - pCand) < 0.005) {
        pCand = next;
        break;
      }
      pCand = next;
    }
    const at = modelAt(pCand);
    const e0 = (at.model.evMin + at.model.evMax) / 2;
    if (e0 > 0 && pCand > 0) {
      const landedEdge = 1 - e0 / pCand;
      const excess = landedEdge - at.eStar;
      if (excess >= -1e-9) {
        if (excess <= ONE_SIDED_EDGE_EXCESS_TOL && engineAccepts(at.model, at.evT, at.eStar)) {
          // Within the engine's one-sided acceptance — a PLAIN price move at
          // auto targets suffices, no edge-target change needed.
          suggestions.push({
            kind: "price-move",
            params: { price: pCand },
            humanCopy: `Move the price to ${usd(pCand)} — the pool then lands the ${pp(tag)}% tag exactly at ${pp(landedEdge)}% edge (+${(excess * 100).toFixed(2)}pp over the curve target, inside the accepted band). No card changes.`,
            proof: proofOf(at.model, at.evT, at.eStar),
          });
        } else if (excess < 0.05) {
          // Needs the explicit edge-target ride-along (price-edge-exact).
          const ePrime = landedEdge;
          const evPrime = pCand * (1 - ePrime);
          suggestions.push({
            kind: "price-edge-exact",
            params: { price: pCand, edgeTarget: ePrime },
            humanCopy: `Move the price to ${usd(pCand)} and set the edge target to ${(ePrime * 100).toFixed(3)}% — ${
              base.pinnedCount > 0
                ? "your typed pins hold every card's odds exact"
                : "this pool's odds are fully pinned (never-inflate + hard tag)"
            }, so it pays exactly one amount; at ${usd(pCand)} that amount IS a ${(ePrime * 100).toFixed(3)}% edge with the ${pp(tag)}% tag exact. ${base.pinnedCount > 0 ? "Keep the pins — no card changes." : "No card changes."}`,
            proof: {
              evMinAfter: at.model.evMin,
              evMaxAfter: at.model.evMax,
              feasibleAfter:
                evPrime >= at.model.evMin - 1e-6 && evPrime <= at.model.evMax + 1e-6,
            },
          });
        }
      }
    }
  }

  if (priceAllowed && !pointInterval && !feasibleRaw) {
    // LAW 7 — segment scan across the full ±60% band: between band/cap
    // crossings EVmin/EVmax are constant and E*(P) is strictly increasing, so
    // the feasible prices per segment form one closed interval.
    const lo = Math.max(0.01, price * 0.4);
    const hi = price * 1.6;
    const breakpoints = new Set<number>([lo, hi]);
    for (const c of input.cards) {
      const v = c.value;
      if (!(v > 0)) continue;
      for (const b of [v, v / 5, 2 * v]) {
        if (b > lo && b < hi) breakpoints.add(Math.round(b * 100) / 100);
      }
      // Cap crossing: autoMaxWinCap(P) = v (price-relative arm only).
      if (cfg) {
        const scale = tag < 0.2 ? (0.2 / tag) * 1.15 : 1;
        const pCross = v / (cfg.maxMultCeiling * scale);
        if (pCross > lo && pCross < hi) breakpoints.add(Math.round(pCross * 100) / 100);
      }
    }
    const pts = [...breakpoints].sort((a, b) => a - b);
    let bestCent: number | null = null;
    let bestWindow: { lo: number; hi: number } | null = null;
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k]!;
      const b = pts[k + 1]!;
      if (!(b - a > 0.005)) continue;
      const mid = (a + b) / 2;
      const at = modelAt(mid);
      if (!(at.model.d > 1e-9)) continue;
      // Feasible price window inside the segment at the segment's (constant)
      // interval, with the bump margin E* ≥ EVmin + 0.001·P.
      const denomLo = 1 - at.eStar - 0.001;
      const denomHi = 1 - at.eStar;
      if (!(denomLo > 0) || !(denomHi > 0)) continue;
      const pLo = Math.max(a, at.model.evMin / denomLo);
      const pHi = Math.min(b, at.model.evMax / denomHi);
      if (pLo > pHi) continue;
      // Cent-round inward, then Newton-verify each end at ITS OWN targets.
      const centLo = Math.ceil(pLo * 100) / 100;
      const centHi = Math.floor(pHi * 100) / 100;
      if (centLo > centHi) continue;
      const candidates =
        Math.abs(centLo - price) <= Math.abs(centHi - price)
          ? [centLo, centHi]
          : [centHi, centLo];
      for (const cent of candidates) {
        const chk = modelAt(cent);
        if (!engineAccepts(chk.model, chk.evT, chk.eStar)) continue;
        if (
          bestCent === null ||
          Math.abs(cent - price) < Math.abs(bestCent - price) - 1e-9 ||
          (Math.abs(Math.abs(cent - price) - Math.abs(bestCent - price)) < 1e-9 &&
            cent > bestCent)
        ) {
          bestCent = cent;
          bestWindow = { lo: centLo, hi: centHi };
        }
        break;
      }
    }
    if (bestCent !== null) {
      const at = modelAt(bestCent);
      suggestions.push({
        kind: "price-move",
        params: { price: bestCent },
        humanCopy: `Move the price to ${usd(bestCent)}${bestWindow && bestWindow.hi > bestWindow.lo ? ` (any cent in ${usd(bestWindow.lo)}–${usd(bestWindow.hi)} works)` : ""} — the pool solves at the ${pp(tag)}% tag with no card changes.`,
        proof: proofOf(at.model, at.evT, at.eStar),
      });
    }
  }

  // ── 3. Add a dust card (LAW 4 — the strongest pool lever, need-ev-down) ───
  if (direction === "need-ev-down" && base.d > 1e-9) {
    const wUsed = base.winEvMin;
    const nmUsed = base.m * bandEvForBeta(base.nmValues, BETA_HI) + base.nmFixedEv;
    const vB = (evTarget - wUsed - nmUsed - base.dustFixedEv) / base.d;
    const vMax = Math.min(vB, 0.5 * price - 0.01);
    const onlyDustIsCent =
      base.dustValues.length > 0 && Math.max(...base.dustValues) <= 0.01 + 1e-9;
    if (vMax >= 0.01 && !onlyDustIsCent) {
      let v = Math.min(Math.max(Math.min(0.9 * vB, 0.025 * price), 0.01), vMax);
      v = round2(Math.max(0.01, v));
      let proved: BandModel | null = null;
      for (let iter = 0; iter < 12 && v >= 0.01; iter++) {
        const m2 = buildModel({
          cards: input.cards,
          currentWeights: input.currentWeights,
          price,
          cap: input.maxWinCap,
          tag,
          nearMissMin: input.nearMissMin,
          extraDust: [v],
          pinnedShares: pins,
        });
        if (engineAccepts(m2, evTarget, targetEdge)) {
          proved = m2;
          break;
        }
        if (v <= 0.01) break;
        v = round2(Math.max(0.01, v / 2));
      }
      if (proved) {
        // Expected odds share of the new card (analytic mixing equation —
        // matched simulation within 0.1pp on the audit fixture).
        const dCur = bandEvForBeta(base.dustValues, BETA_HI);
        const dReq = (evTarget - wUsed - nmUsed - base.dustFixedEv) / base.d;
        const share =
          dCur - v > 1e-9
            ? Math.min(1, Math.max(0, (base.d * (dCur - dReq)) / (dCur - v)))
            : base.d;
        suggestions.push({
          kind: "add-card",
          params: {
            band: "dust",
            valueMin: 0.01,
            valueMax: round2(vMax),
            suggestedValue: v,
            expectedShare: share,
          },
          humanCopy: `Add a dust card between ${usd(0.01)} and ${usd(round2(vMax))} (suggest ${usd(v)} — it will carry ≈${(share * 100).toFixed(1)}% of opens). The tag stays exactly ${pp(tag)}%.`,
          proof: proofOf(proved, evTarget, targetEdge),
        });
      }
    }
  }

  // ── 4. Add a jackpot (LAW 5 — saturated spill case, need-ev-up) ───────────
  if (
    direction === "need-ev-up" &&
    Number.isFinite(base.capSum) &&
    tag - base.capSum - base.winFixedMass > 1e-9 &&
    base.d > 1e-9
  ) {
    const s = tag - base.capSum - base.winFixedMass;
    let capEv = base.winFixedEv;
    for (let i = 0; i < base.winValues.length; i++) {
      capEv += base.winCaps[i]! * base.winValues[i]!;
    }
    const lossFixed = base.nmFixedEv + base.dustFixedEv;
    const lossLo = base.m * bandEvForBeta(base.nmValues, BETA_HI) + base.d * bandEvForBeta(base.dustValues, BETA_HI) + lossFixed;
    const lossHi = base.m * bandEvForBeta(base.nmValues, BETA_LO) + base.d * bandEvForBeta(base.dustValues, BETA_LO) + lossFixed;
    let vLo = (evTarget - capEv - lossHi) / s;
    let vHi = (evTarget - capEv - lossLo) / s;
    vLo = Math.max(vLo, price);
    vHi = Math.min(vHi, input.maxWinCap);
    if (vLo <= vHi) {
      // Monotone-grail bound: a new GRAIL is clamped at the next-cheaper
      // grail's odds — the intervention silently dies when s exceeds it.
      const vMid = round2((vLo + vHi) / 2);
      const grailBound = base.winValues
        .map((v, i) => ({ v, c: base.winCapsRaw[i]! }))
        .filter((x) => x.v >= 5 * price && x.v <= vMid)
        .reduce((min, x) => Math.min(min, x.c), Infinity);
      if (vMid < 5 * price || s <= grailBound + 1e-12) {
        const m2 = buildModel({
          cards: input.cards,
          currentWeights: input.currentWeights,
          price,
          cap: input.maxWinCap,
          tag,
          nearMissMin: input.nearMissMin,
          extraWin: vMid,
          pinnedShares: pins,
        });
        if (engineAccepts(m2, evTarget, targetEdge)) {
          suggestions.push({
            kind: "add-card",
            params: {
              band: "jackpot",
              valueMin: round2(vLo),
              valueMax: round2(vHi),
              suggestedValue: vMid,
              expectedShare: s,
            },
            humanCopy: `Add a winner between ${usd(round2(vLo))} and ${usd(round2(vHi))} (suggest ${usd(vMid)}) — it takes the ${pp(s)}% of the tag the current winners' pinned odds can't fill, lifting the payout to the target.`,
            proof: proofOf(m2, evTarget, targetEdge),
          });
        }
      }
    }
  }

  // ── 5. Edge-bump (LAW 8 — upward only, beyond the auto-acceptance) ────────
  if (direction === "need-ev-up" && base.evMax > 0) {
    const ePrime = 1 - base.evMax / price;
    const excess = ePrime - targetEdge;
    // Pattern 9f: suppress an absurd "accept X% edge" on a badly mis-tagged
    // pool — a 25%+ house edge is not a real product option; the retag path is
    // the honest fix.
    if (excess > ONE_SIDED_EDGE_EXCESS_TOL && ePrime < 1 && ePrime <= MAX_ACCEPT_EDGE) {
      suggestions.push({
        kind: "edge-bump",
        params: { edgeTarget: ePrime },
        humanCopy: `This pool can't pay enough to sit at the ${pp(targetEdge)}% target — its pinned odds top out at a ${(ePrime * 100).toFixed(3)}% edge. Accept ${(ePrime * 100).toFixed(3)}% (+${(excess * 100).toFixed(2)}pp) as the target; the tag stays exact. (Upward only — the floor is never lowered.)`,
        proof: {
          evMinAfter: base.evMin,
          evMaxAfter: base.evMax,
          feasibleAfter:
            base.evMax >= base.evMinKnob - 1e-6, // E*′ = evMax sits in the interval
        },
      });
    }
  }

  // ── 6. Raise the cap (LAW 11 — only when the pre-filter dropped cards) ────
  if (direction === "need-ev-up" && base.capDroppedCount > 0) {
    const liftedCap = Math.ceil(base.maxDroppedValue);
    const m2 = buildModel({
      cards: input.cards,
      currentWeights: input.currentWeights,
      price,
      cap: liftedCap,
      tag,
      nearMissMin: input.nearMissMin,
      pinnedShares: pins,
    });
    if (engineAccepts(m2, evTarget, targetEdge)) {
      suggestions.push({
        kind: "raise-cap",
        params: { maxWinCap: liftedCap },
        humanCopy: `Raise the max-win cap to ${usd(liftedCap)} — the current ${usd(input.maxWinCap)} cap drops ${base.capDroppedCount} card(s) (top ${usd(base.maxDroppedValue)}) from the pool, deleting the jackpot the tag's payout needs.`,
        proof: proofOf(m2, evTarget, targetEdge),
      });
    }
  }

  // ── 8. Repair an inverted grail rung ([fleet MONOTONE-GRAIL]) ─────────────
  {
    // Detect: walking grails value-ascending, a card whose RAW live odds
    // exceed the running-min of the cheaper grails is CLIPPED by the engine —
    // an inverted ladder rung (a pricier card more likely than a cheaper one).
    const grailThreshold = 5 * price;
    const grailAsc = base.winValues
      .map((v, i) => ({ i, v, raw: base.winCapsRaw[i]! }))
      .filter((x) => x.v >= grailThreshold && Number.isFinite(x.raw))
      .sort((a, b) => a.v - b.v);
    let runningMin = Infinity;
    let clipped: { v: number; raw: number; vsV: number; bound: number } | null = null;
    let vsValue = 0;
    for (const g of grailAsc) {
      if (g.raw > runningMin + 1e-12 && clipped === null) {
        clipped = { v: g.v, raw: g.raw, vsV: vsValue, bound: runningMin };
      }
      if (g.raw < runningMin) {
        runningMin = g.raw;
        vsValue = g.v;
      }
    }
    if (clipped !== null && !feasibleRaw) {
      const m2 = buildModel({
        cards: input.cards,
        currentWeights: input.currentWeights,
        price,
        cap: input.maxWinCap,
        tag,
        nearMissMin: input.nearMissMin,
        noMonotoneTighten: true,
        pinnedShares: pins,
      });
      if (engineAccepts(m2, evTarget, targetEdge)) {
        const idx = input.cards.findIndex(
          (c, i) =>
            Math.abs(c.value - clipped!.v) < 1e-9 &&
            (input.currentWeights[i] ?? 0) > 0,
        );
        const vsIdx = input.cards.findIndex(
          (c, i) =>
            Math.abs(c.value - clipped!.vsV) < 1e-9 &&
            (input.currentWeights[i] ?? 0) > 0,
        );
        suggestions.push({
          kind: "repair-monotone",
          params: {
            ...(input.cardIds && idx >= 0 ? { cardId: input.cardIds[idx]! } : {}),
            ...(input.cardIds && vsIdx >= 0 ? { vsCardId: input.cardIds[vsIdx]! } : {}),
            cardValue: clipped.v,
            vsCardValue: clipped.vsV,
            maxOddsPct: clipped.bound * 100,
          },
          humanCopy: `The ladder is inverted: the ${usd(clipped.v)} card is MORE likely (${(clipped.raw * 100).toFixed(3)}%) than the cheaper ${usd(clipped.vsV)} (${(clipped.bound * 100).toFixed(3)}%), so the engine clips it and loses the payout it carries. Repair the rung (pricier card at ≤ ${(clipped.bound * 100).toFixed(3)}%, or raise the cheaper card's odds) and the pack solves tag-exact.`,
          proof: proofOf(m2, evTarget, targetEdge),
        });
      }
    }
  }

  // ── 8b. SHAPE-UNFIT lead (tag-fit verdict) ────────────────────────────────
  //
  // When the tag is monotone-unfittable at the plan price AND the pool is
  // infeasible, the identity fix (retag to the live tier / untag to the real
  // rate) is the honest lead — ranked ABOVE the price levers (the ranking
  // override in the sort below), and only ever emitted SOLVER-VERIFIED: a real
  // `shapeWeights` round-trip at THIS price with the pins held. When neither
  // identity fix verifies, the legacy unverified retag/untag (block 9) still
  // runs — honesty over silence.
  let shapeUnfitLead = false;
  if (
    !feasibleRaw &&
    !monotoneFeasible &&
    input.liveWinRate != null &&
    Number.isFinite(input.liveWinRate) &&
    input.liveWinRate > 0 &&
    Math.abs(input.liveWinRate - tag) > TAGGED_WRITE_WINRATE_TOLERANCE
  ) {
    const liveRate = input.liveWinRate;
    const nmSeed = Math.max(0, input.liveNearMiss ?? 0);
    const unfitWhy = `The ${pp(tag)}% tag doesn't fit this pool's cards — no honest ladder (never-inflate odds, cheap-heavy losses) pays ${pp(tag)}% winners at the ${pp(targetEdge)}% target at ${usd(price)}.`;

    // Nearest selectable tier within ±1pp of the live rate → verified RETAG.
    const TIER_TOL = 0.01;
    let nearestTier: (typeof SELECTABLE_TAG_HIT_RATES)[number] | null = null;
    let nearestDist = Infinity;
    for (const t of SELECTABLE_TAG_HIT_RATES) {
      const dist = Math.abs(liveRate - t.hitRate);
      if (dist <= TIER_TOL + 1e-9 && dist < nearestDist) {
        nearestDist = dist;
        nearestTier = t;
      }
    }
    if (nearestTier) {
      const tierRate = nearestTier.hitRate;
      const capPrime = cfg ? autoMaxWinCap(price, cfg, tierRate) : input.maxWinCap;
      let topPrime = 0;
      for (const c of input.cards) {
        if (c.value > 0 && c.value <= capPrime && c.value > topPrime) topPrime = c.value;
      }
      const eStarPrime = targetEdgeAt(price, capPrime, topPrime);
      let verified = false;
      try {
        const r = shapeWeights({
          cards: input.cards.map((c) => ({ value: c.value })),
          price,
          targetEdge: eStarPrime,
          targetWinRate: tierRate,
          maxWinCap: capPrime,
          nearMissMin: nmSeed,
          winRateTol: TAGGED_WINRATE_TOLERANCE,
          currentWeights: input.currentWeights.slice(),
          winRateIsHard: true,
          disperseLoss: true,
          ...(pins ? { pinnedShares: pins.map((p) => ({ ...p })) } : {}),
        });
        verified =
          !("error" in r) &&
          r.edge >= eStarPrime - 1e-9 &&
          Math.abs(r.risk.winRate - tierRate) <= TAGGED_WINRATE_TOLERANCE + 1e-9;
      } catch {
        verified = false;
      }
      if (verified) {
        const m2 = buildModel({
          cards: input.cards,
          currentWeights: input.currentWeights,
          price,
          cap: capPrime,
          tag: tierRate,
          nearMissMin: nmSeed,
          pinnedShares: pins,
        });
        const lead: TuneSuggestion = {
          kind: "retag",
          params: {
            action: "retag",
            liveRate,
            proposedTag: tierRate,
            tierHitRate: tierRate,
            tierTag: nearestTier.tag,
            tierDbLabel: nearestTier.dbLabel,
          },
          humanCopy: `${unfitWhy} The pool actually pays ${pp(liveRate)}% — retag it to ${nearestTier.dbLabel} and it plans tier-exact at this price (solver-verified).`,
          proof: {
            evMinAfter: m2.evMin,
            evMaxAfter: m2.evMax,
            feasibleAfter: true,
            solverVerified: true,
          },
        };
        suggestions.push(lead);
        leadSet.add(lead);
        shapeUnfitLead = true;
      }
    }
    if (!shapeUnfitLead) {
      // UNTAG verified via the untagged-retune solve (hard hold → soft
      // fallback) at the pool's real rate with untagged targets.
      const rate = Math.min(0.95, Math.max(0.02, liveRate));
      const capU = cfg ? autoMaxWinCap(price, cfg) : input.maxWinCap;
      let topU = 0;
      for (const c of input.cards) {
        if (c.value > 0 && c.value <= capU && c.value > topU) topU = c.value;
      }
      const eStarU = autoTargetEdge(
        { price, maxWin: Math.min(topU > 0 ? topU : capU, capU) },
        cfg?.edgeCurve ?? DEFAULT_EDGE_CURVE,
      );
      const nmU = Math.max(0.1, 0.8 * nmSeed);
      let verified = false;
      try {
        const solveU = (mode: "hard" | "soft") =>
          shapeWeights({
            cards: input.cards.map((c) => ({ value: c.value })),
            price,
            targetEdge: eStarU,
            targetWinRate: rate,
            maxWinCap: capU,
            nearMissMin: nmU,
            winRateTol: 0.02,
            currentWeights: input.currentWeights.slice(),
            disperseLoss: true,
            ...(mode === "hard" ? { holdWinRateHard: true } : { holdWinRate: true }),
            ...(pins ? { pinnedShares: pins.map((p) => ({ ...p })) } : {}),
          });
        const hard = solveU("hard");
        if (!("error" in hard) && hard.edge >= eStarU - 1e-9) {
          verified = true;
        } else {
          const soft = solveU("soft");
          verified = !("error" in soft) && soft.edge >= eStarU - 1e-9;
        }
      } catch {
        verified = false;
      }
      if (verified) {
        const m2 = buildModel({
          cards: input.cards,
          currentWeights: input.currentWeights,
          price,
          cap: capU,
          tag: rate,
          nearMissMin: nmU,
          pinnedShares: pins,
        });
        const lead: TuneSuggestion = {
          kind: "untag",
          params: { action: "untag", liveRate },
          humanCopy: `${unfitWhy} It actually pays ${pp(liveRate)}% — not a lottery tier — so untag it and it plans as a normal pack at its real rate (solver-verified at this price).`,
          proof: {
            evMinAfter: m2.evMin,
            evMaxAfter: m2.evMax,
            feasibleAfter: true,
            solverVerified: true,
          },
        };
        suggestions.push(lead);
        leadSet.add(lead);
        shapeUnfitLead = true;
      }
    }
  }

  // ── 9. Retag to the nearest lottery tier, else UNTAG (owner identity decision) ─
  //
  // The tag control can ONLY write a real lottery tier (pct1/pct5/pct10/fifty50 —
  // hitRates 0.01/0.05/0.10/0.50). The live win-rate is NOT itself a valid tag: a
  // pool paying e.g. 30% has NO tier to retag to (there is no %30 tag). So:
  //   • liveRate within ±1pp of a tier AND the engine accepts at that TIER →
  //     RETAG to that tier (proof rebuilt at the tier's hitRate, honest for the
  //     tier — never for the raw liveRate).
  //   • otherwise (no tier within ±1pp, or the nearest tier doesn't accept) →
  //     UNTAG: the pool isn't a lottery at its real rate; it plans as a normal
  //     pack. An untag is an identity decision (feasibleAfter:false is honest —
  //     it's not a tag-solve), so it won't be picked as the solver-verified top.
  // Skipped when the shape-unfit lead (8b) already emitted the VERIFIED
  // identity fix — one identity suggestion, the strongest available.
  if (
    !shapeUnfitLead &&
    input.liveWinRate != null &&
    Number.isFinite(input.liveWinRate) &&
    input.liveWinRate > 0 &&
    Math.abs(input.liveWinRate - tag) > TAGGED_WRITE_WINRATE_TOLERANCE &&
    !feasibleRaw
  ) {
    const liveRate = input.liveWinRate;
    const nmSeed = Math.max(0, input.liveNearMiss ?? 0);

    // Nearest selectable tier within ±1pp (±0.01) of the live rate.
    const TIER_TOL = 0.01;
    let nearestTier: (typeof SELECTABLE_TAG_HIT_RATES)[number] | null = null;
    let nearestDist = Infinity;
    for (const t of SELECTABLE_TAG_HIT_RATES) {
      const dist = Math.abs(liveRate - t.hitRate);
      if (dist <= TIER_TOL + 1e-9 && dist < nearestDist) {
        nearestDist = dist;
        nearestTier = t;
      }
    }

    let emittedRetag = false;
    if (nearestTier) {
      // Rebuild the proof at the TIER's hitRate (not the raw liveRate) so
      // feasibleAfter is honest for what the retag actually writes.
      const tierRate = nearestTier.hitRate;
      const capPrime = cfg ? autoMaxWinCap(price, cfg, tierRate) : input.maxWinCap;
      const m2 = buildModel({
        cards: input.cards,
        currentWeights: input.currentWeights,
        price,
        cap: capPrime,
        tag: tierRate,
        nearMissMin: nmSeed,
        pinnedShares: pins,
      });
      const eStarPrime = targetEdgeAt(price, capPrime, poolTopAt(price));
      const evTPrime = price * (1 - eStarPrime);
      if (engineAccepts(m2, evTPrime, eStarPrime)) {
        suggestions.push({
          kind: "retag",
          params: {
            action: "retag",
            liveRate,
            proposedTag: tierRate,
            tierHitRate: tierRate,
            tierTag: nearestTier.tag,
            tierDbLabel: nearestTier.dbLabel,
          },
          humanCopy: `This pool actually pays ${pp(liveRate)}% winners; the closest lottery tier is ${nearestTier.dbLabel}. Retag it to ${nearestTier.dbLabel} and it plans at that rate${nmSeed > 0.005 ? ` (and carries a real ${pp(nmSeed)}% near-miss band)` : ""} — the tag should describe the pool, not fight it.`,
          proof: proofOf(m2, evTPrime, eStarPrime),
        });
        emittedRetag = true;
      }
    }

    if (!emittedRetag) {
      // No tier within ±1pp, or the nearest tier doesn't engine-accept →
      // this pool isn't a lottery at its real rate. Untag it.
      const capPrime = cfg ? autoMaxWinCap(price, cfg, liveRate) : input.maxWinCap;
      const m2 = buildModel({
        cards: input.cards,
        currentWeights: input.currentWeights,
        price,
        cap: capPrime,
        tag: liveRate,
        nearMissMin: nmSeed,
        pinnedShares: pins,
      });
      suggestions.push({
        kind: "untag",
        params: { action: "untag", liveRate },
        humanCopy: `This pool pays ${pp(liveRate)}% winners — that's not one of the lottery tiers (%1 / %5 / %10 / 50-50), so it isn't a lottery. Untag it and it plans as a normal pack at its real rate.`,
        proof: {
          // An untag is an identity decision, not a tag-solve — feasibleAfter is
          // honestly false (it won't be picked as the solver-verified top).
          evMinAfter: m2.evMin,
          evMaxAfter: m2.evMax,
          feasibleAfter: false,
        },
      });
    }
  }

  // ── 10. Dead near-miss cards (informational, unranked) ────────────────────
  if (base.m === 0 && base.nmValues.length > 0) {
    for (const v of base.nmValues) {
      const idx = input.cards.findIndex((c) => Math.abs(c.value - v) < 1e-9);
      suggestions.push({
        kind: "remove-dead-card",
        params: {
          ...(input.cardIds && idx >= 0 ? { cardId: input.cardIds[idx]! } : {}),
          cardValue: v,
        },
        humanCopy: `${usd(v)} sits in the near-miss band — dead weight for a ${pp(tag)}% tag (a binary lottery gets ~0% mass there). Consider removing it.`,
        proof: {
          evMinAfter: base.evMin,
          evMaxAfter: base.evMax,
          feasibleAfter: feasibleRaw,
        },
      });
    }
  }

  // ── Ranking (LAW 12, fixed): price levers → add-card → edge-bump →
  //    raise-cap → repair-monotone → retag; informational entries last.
  //    Shape-unfit lead entries (8b) rank ABOVE everything — the verified
  //    identity fix outranks the price levers on an unfittable tag. ──────────
  const rankOf = (s: TuneSuggestion): number =>
    leadSet.has(s) ? -1 : SUGGESTION_RANK[s.kind];
  suggestions.sort((a, b) => rankOf(a) - rankOf(b));

  // ── Emission guarantee: no bare infeasible verdicts. ──────────────────────
  const actionable = suggestions.filter(
    (s) => s.kind !== "remove-dead-card" && s.proof.feasibleAfter,
  );
  if (!feasibleRaw && actionable.length === 0) {
    const onlyDustIsCent =
      base.dustValues.length > 0 && Math.max(...base.dustValues) <= 0.01 + 1e-9;
    const reasons: string[] = [];
    if (direction === "need-ev-down" && onlyDustIsCent) {
      reasons.push("the only dust card is already at the $0.01 floor");
    }
    if (input.pinPrice === true) reasons.push("the price is pinned");
    if (!cfg) reasons.push("no price-band config was supplied");
    suggestions.push({
      kind: "no-fix-under-constraints",
      params: {},
      humanCopy: `No fix exists under the current constraints${reasons.length > 0 ? ` (${reasons.join("; ")})` : ""} — unpin the price, allow a target change, or restructure the pool.`,
      proof: {
        evMinAfter: base.evMin,
        evMaxAfter: base.evMax,
        feasibleAfter: false,
      },
    });
  }

  // ── Solver round-trip of the TOP ranked suggestion (honesty gate). ────────
  // A shape-unfit lead already carries its own round-trip (solverVerified is
  // pre-set) — never overwrite a real verification with the generic replay.
  const top = suggestions.find((s) => s.proof.feasibleAfter && s.kind !== "remove-dead-card");
  if (top && top.proof.solverVerified === undefined) {
    try {
      top.proof.solverVerified = solverRoundTrip(input, top);
    } catch {
      top.proof.solverVerified = false;
    }
  }

  return {
    feasibility: {
      evTarget,
      evMin: base.evMin,
      evMax: base.evMax,
      feasible: feasibleRaw,
      saturated: base.saturated,
      direction,
      components: {
        winEvMin: base.winEvMin,
        winEvMax: base.winEvMax,
        nmMass: base.m,
        dustMass: base.d,
        capSum: Number.isFinite(base.capSum) ? base.capSum : -1,
      },
      shapeFit,
    },
    suggestions,
  };
}

/**
 * Round-trip a suggestion through the REAL solver: apply the intervention and
 * run an anchored, hard-tag `shapeWeights` at the (possibly adjusted) targets.
 * TRUE ⟺ the solver succeeds with the tag within 0.01pp — the top-ranked
 * suggestion is only displayed as proven when the engine itself agrees.
 */
function solverRoundTrip(input: TagGuidanceInput, s: TuneSuggestion): boolean {
  const cfg = input.cfg ?? null;
  let cards = input.cards.map((c) => ({ value: c.value }));
  let currentWeights = input.currentWeights.slice();
  let price = input.price;
  let targetEdge = input.targetEdge;
  let maxWinCap = input.maxWinCap;
  let tag = input.tag;
  let nearMissMin = input.nearMissMin;

  switch (s.kind) {
    case "price-move":
    case "price-edge-exact": {
      price = Number(s.params.price);
      maxWinCap = cfg ? autoMaxWinCap(price, cfg, tag) : maxWinCap;
      if (typeof s.params.edgeTarget === "number") {
        targetEdge = s.params.edgeTarget;
      } else {
        let top = 0;
        for (const c of cards) {
          if (c.value > 0 && c.value <= maxWinCap && c.value > top) top = c.value;
        }
        targetEdge = autoTargetEdge(
          { price, maxWin: Math.min(top > 0 ? top : maxWinCap, maxWinCap) },
          cfg?.edgeCurve ?? DEFAULT_EDGE_CURVE,
        );
      }
      break;
    }
    case "add-card": {
      cards = [...cards, { value: Number(s.params.suggestedValue) }];
      currentWeights = [...currentWeights, 0];
      break;
    }
    case "edge-bump": {
      targetEdge = Number(s.params.edgeTarget);
      break;
    }
    case "raise-cap": {
      maxWinCap = Number(s.params.maxWinCap);
      break;
    }
    case "retag": {
      tag = Number(s.params.proposedTag);
      nearMissMin = Math.max(0, input.liveNearMiss ?? 0);
      maxWinCap = cfg ? autoMaxWinCap(price, cfg, tag) : maxWinCap;
      break;
    }
    default:
      return false; // repair-monotone needs a pool edit we can't simulate here
  }

  const r = shapeWeights({
    cards,
    price,
    targetEdge,
    targetWinRate: tag,
    maxWinCap,
    nearMissMin,
    winRateTol: TAGGED_WINRATE_TOLERANCE,
    currentWeights,
    winRateIsHard: true,
    // The staged solve holds owner pins EXACT — the round-trip must run the
    // SAME problem or the "solver-verified" badge certifies a different pack.
    // (add-card appends, so pin indexes into the original pool stay valid.)
    ...(input.pinnedShares != null && input.pinnedShares.length > 0
      ? { pinnedShares: input.pinnedShares.map((p) => ({ ...p })) }
      : {}),
  });
  if ("error" in r) return false;
  return Math.abs(r.risk.winRate - tag) <= TAGGED_WINRATE_TOLERANCE + 1e-9;
}

// ═══ UNTAGGED degenerate-loss-ladder guidance (the owner's "Captive" case) ═══
//
// An UNTAGGED plan can be perfectly feasible — edge on target, price snapped —
// and still carry a degenerate loss ladder: the win-rate float-up (owner rule
// #2) bisects the win mass to the EXACT point where the loss side's maximum
// EV reaches the target, which lands the loss-band skew at its endpoint
// (β = BETA_LO) — ALL loss mass parks on the single richest loss card and
// every cheaper loss card gets pinned at the integer-quantization odds floor
// (weight 1 in 1e6 = 0.0001%). Verified reproduction: pack "Captive" — price
// $485.50 → $435.43, loss side must average ≈$80.50 over 70.7% of opens, only
// the $80.28 card can carry it, the $33.95/$18.23 cards pin at 0.0001% and the
// win-rate floats to 29.3%.
//
// This module answers the owner's WHY and emits the same ranked, PROVEN
// suggestion shape the tagged engine uses:
//   • `add-card` (mid) — the value band (near-miss band first, upper-dust as
//     the fallback) + the price at which the loss mass provably spreads,
//     solver-round-tripped before emission (the SAME mixing/no-float math as
//     the tagged add-dust law, applied to the float-up condition).
//   • `remove-dead-card` — the pinned-at-floor cards (harmless: ~0 EV each;
//     the removal is re-solved through the real engine before emission).
//   • `accept-as-is` — the plan is sound; the pins are the pool's structure.

/**
 * The solver's integer-quantization odds floor in PERCENT units: the precise
 * solve quantizes fractional weights at 1e6 with `Math.max(1, …)`, so a card
 * whose solved share is ~0 lands at weight 1 in ~1,000,000 = 0.0001% (the
 * gcd-reduce can't shrink a vector containing a weight of 1).
 */
export const FLOOR_PINNED_MAX_PCT = 0.0001;

/**
 * TRUE when a planned per-card probability (PERCENT units, e.g. `planned.pct`
 * on a `PackTunePlan`) sits at the quantization floor — the "pinned" signature.
 * Only meaningful for LOSS-band cards (a designed 1-in-a-million jackpot rung
 * is legitimate); callers gate on `value < price`.
 */
export function isFloorPinnedPct(pct: number): boolean {
  return pct > 0 && pct <= FLOOR_PINNED_MAX_PCT + 1e-9;
}

// ── SHAPE GUARD (owner-lens §2 / Pattern 1) ─────────────────────────────
//
// A pure, computable metric of how much a PLANNED ladder deviates from the
// pack's LIVE shape in the ways the owner reads as broken: a rich loss card
// more likely than a cheaper one (inversion), one carrier card absorbing the
// loss mass, and healthy live cards crushed 100×+ below their live odds. The
// solver has no dispersion / live-shape objective, so ~half the untagged fleet
// replans into a one-carrier degenerate ladder (the owner's flagged screenshot).
// This metric DETECTS that so the planner can demote + badge it and lead with
// pool edits. It is a POST-CHECK — never a solver constraint.
//
// All inputs are plain arrays aligned to pool order; SHARES are fractions of 1
// (a staged-in card carries live share 0). The metric NEVER looks at the win
// band's ordering (legitimate win-band non-monotonicity makes a third of the
// catalog infeasible — audit-protected); win cards enter only via the crush
// terms.

/** A card whose planned share sits at/below this (fraction) is "crushed-low". */
const CRUSH_PLANNED_MAX = 0.00002; // 0.002% as a fraction
/** A live/planned ratio at/above this is a 100×+ relative crush. */
const CRUSH_RATIO_MIN = 100;

/** The composite score at/above which a planned ladder is DEGENERATE. */
export const LADDER_DEGENERATE_THRESHOLD = 0.25;

export type LadderShape = {
  /** Intrinsic planned-ladder inversion (rich loss card likelier than cheaper). */
  lossInvArea: number;
  /** Largest single LOSS card's (planned − live) share gain (the absorber). */
  absorberExcess: number;
  /** Count of cards relative-crushed ≥100× and under 0.002% planned. */
  crushedCount: number;
  /** Live share (fraction) sitting on crushed cards. */
  crushedLiveMass: number;
  /** Indices — the crushed cards, in pool order (for UI chips). */
  crushedIdx: number[];
  /**
   * cardIds of the crushed cards (owner-lens §3.3): the UI renders a "crushed"
   * chip on these rows with ZERO client recompute. Empty when the caller passed
   * no `cardIds` (e.g. the pure-math harness). Aligned to `crushedIdx`.
   */
  crushedCardIds: string[];
  /** ½·Σ|planned − live| — total probability mass relocated. */
  liveL1: number;
  /** The composite score (see the formula below). */
  score: number;
  /** score ≥ {@link LADDER_DEGENERATE_THRESHOLD}. */
  degenerate: boolean;
};

/**
 * Compute the {@link LadderShape} of a planned vector vs the live pool (owner-
 * lens §2). Pure, dep-free, side-effect-free.
 *
 * A live pool scored against ITSELF is 0 by construction (all plan-vs-live
 * terms vanish) — a no-op replan is never degenerate. The threshold 0.25 sits
 * ~3× above the worst live pool's intrinsic inversion (fleet max 0.0755), so no
 * legitimately-shaped pool can flag.
 *
 * Components (engine-verified calibration in the planner-discipline harness):
 *   • lossInvArea — over LOSS cards (0 < value < price) sorted ascending by
 *     value, for each adjacent (cheap→rich) pair where the rich card is planned
 *     MORE likely, add `(planned[rich] − planned[cheap]) · max(0.05,
 *     log10(v_rich / v_cheap))`. House style: odds rise as value falls.
 *   • absorberExcess — max over LOSS cards of `max(0, planned − live)`.
 *   • crush — a card with `live > 0`, `planned > 0`, `planned ≤ 0.00002` and
 *     `live/planned ≥ 100`. A card planned to exactly 0 is a CAP event (its own
 *     surface), not a crush.
 *   • liveL1 — ½·Σ|planned − live|.
 *
 *   score = lossInvArea
 *         + max(0, absorberExcess − 0.10)
 *         + 2·min(crushedLiveMass, 0.5)
 *         + 0.06·crushedCount
 *         + 0.5·max(0, liveL1 − 0.25)
 */
export function ladderShape(
  values: readonly number[],
  liveShares: readonly number[],
  plannedShares: readonly number[],
  price: number,
  /** Optional cardIds aligned to `values` — populates `crushedCardIds` for the
   * UI's crush chips. Omit in pure-math contexts (harness). */
  cardIds?: readonly string[] | null,
): LadderShape {
  const n = values.length;
  const num = (x: number | undefined): number =>
    typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;

  // ── loss inversion area (planned ladder shape over LOSS cards) ──────────
  const lossCards: { value: number; planned: number }[] = [];
  for (let i = 0; i < n; i++) {
    const v = values[i] ?? 0;
    if (v > 0 && v < price) {
      lossCards.push({ value: v, planned: num(plannedShares[i]) });
    }
  }
  lossCards.sort((a, b) => a.value - b.value); // cheap → rich
  let lossInvArea = 0;
  for (let i = 1; i < lossCards.length; i++) {
    const cheap = lossCards[i - 1]!;
    const rich = lossCards[i]!;
    if (rich.planned > cheap.planned) {
      const ratio = rich.value / Math.max(cheap.value, 0.0001);
      const w = Math.max(0.05, Math.log10(ratio > 0 ? ratio : 1));
      lossInvArea += (rich.planned - cheap.planned) * w;
    }
  }

  // ── absorber / crush / L1 (per-card, aligned to pool order) ─────────────
  let absorberExcess = 0;
  let crushedCount = 0;
  let crushedLiveMass = 0;
  const crushedIdx: number[] = [];
  let l1 = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i] ?? 0;
    const live = num(liveShares[i]);
    const planned = num(plannedShares[i]);
    l1 += Math.abs(planned - live);
    // absorber: only LOSS cards (win-band gains are governed by never-inflate).
    if (v > 0 && v < price) {
      const excess = planned - live;
      if (excess > absorberExcess) absorberExcess = excess;
    }
    // crush: a live card the plan parks ~0 mass on, 100×+ below live.
    if (
      live > 0 &&
      planned > 0 &&
      planned <= CRUSH_PLANNED_MAX &&
      live / planned >= CRUSH_RATIO_MIN
    ) {
      crushedCount += 1;
      crushedLiveMass += live;
      crushedIdx.push(i);
    }
  }
  const liveL1 = l1 / 2;

  const score =
    lossInvArea +
    Math.max(0, absorberExcess - 0.1) +
    2 * Math.min(crushedLiveMass, 0.5) +
    0.06 * crushedCount +
    0.5 * Math.max(0, liveL1 - 0.25);

  const crushedCardIds =
    cardIds != null
      ? crushedIdx
          .map((i) => cardIds[i])
          .filter((id): id is string => typeof id === "string")
      : [];

  return {
    lossInvArea,
    absorberExcess,
    crushedCount,
    crushedLiveMass,
    crushedIdx,
    crushedCardIds,
    liveL1,
    score,
    degenerate: score >= LADDER_DEGENERATE_THRESHOLD,
  };
}

// ── WIDE-PRICE PROBE SUGGESTION (owner-lens §1.4) ───────────────────────
//
// The DEFAULT plan is constrained to the ±10% price budget; the full ±60% band
// survives ONLY as a bounded SUGGESTION probe. When the in-budget plan is not
// materially clean (infeasible / off-tag / unsnapped / degenerate) AND a single
// ±60% probe solve improves the highest differing rung of the quality ladder,
// the planner appends ONE `price-move` suggestion carrying the exact far price —
// ranked first, flagged `beyondBudget`, NEVER silently applied. Count-only
// improvements (fewer off-nice cards, more snaps at the same rung) do NOT
// qualify — only a rung CROSSING (infeasible→feasible, tag miss→hit, unsnapped→
// snapped, off-nice→all-nice, degenerate→healthy) is "materially better".

/** A minimal quality summary of a solve outcome — the probe compares two. */
export type ProbeOutcome = {
  /** Did the solve produce a vector at all? */
  feasible: boolean;
  /** The landed price (only meaningful when feasible). */
  price: number;
  /** Every non-exempt planned odds landed on the human-nice grid (tagged). */
  allNice: boolean | null;
  /** The clean-snap gate was satisfied. */
  snapped: boolean | null;
  /** Tagged strict-accuracy gate (null in untagged mode). */
  taggedAccuracyHit: boolean | null;
  /** The plan-vs-live shape guard verdict (null when infeasible / not scored). */
  shapeDegenerate: boolean | null;
};

/**
 * Decide whether the wide (±60%) probe is MATERIALLY BETTER than the default
 * (±10%) plan, and if so build the ranked `price-move` suggestion (owner-lens
 * §1.4). Pure — the caller runs the two solves and passes their summaries.
 *
 * Materially better ⟺ the wide result crosses the HIGHEST differing rung of:
 *   1. infeasible → feasible
 *   2. (tagged) tag miss → hit
 *   3. unsnapped → snapped
 *   4. (tagged) off-nice → all-nice
 *   5. degenerate → healthy shape
 * A count-only gain at an already-equal rung never qualifies (the Bidoof case:
 * 1 off-nice → 2 off-nice is not a crossing).
 *
 * Returns `null` when the wide probe is infeasible, not better, or the plan is
 * already clean (the caller gates on "default not materially clean" first — but
 * this is defensive: an already-clean default yields no crossing here either).
 */
export function buildWidePriceProbeSuggestion(args: {
  livePrice: number;
  tagged: boolean;
  tag: number;
  def: ProbeOutcome;
  wide: ProbeOutcome;
  /** Wide solve's landed edge / win-rate (for the params payload). */
  wideEdge: number;
  wideWinRate: number;
}): TuneSuggestion | null {
  const { livePrice, tagged, tag, def, wide } = args;
  if (!wide.feasible) return null;

  // Rung crossings the wide probe achieves that the default did not.
  const feasCross = !def.feasible && wide.feasible;
  const tagCross =
    tagged && def.taggedAccuracyHit === false && wide.taggedAccuracyHit === true;
  const snapCross = def.snapped !== true && wide.snapped === true;
  const niceCross = tagged && def.allNice === false && wide.allNice === true;
  const shapeCross =
    def.shapeDegenerate === true && wide.shapeDegenerate === false;

  if (!(feasCross || tagCross || snapCross || niceCross || shapeCross)) {
    return null;
  }

  const deltaPct = ((wide.price - livePrice) / livePrice) * 100;
  const benefit = feasCross
    ? "the plan becomes solvable"
    : tagCross
      ? "the tag lands exactly"
      : niceCross
        ? "every chance lands on a round number"
        : snapCross
          ? "every chance lands on a round number"
          : "the ladder stays healthy";
  const sign = deltaPct >= 0 ? "+" : "−";
  const humanCopy = `Move the price to ${usd(wide.price)} (${sign}${Math.abs(deltaPct).toFixed(1)}%, outside the ±10% budget) — ${benefit}.`;

  return {
    kind: "price-move",
    params: {
      price: wide.price,
      deltaPct: Math.round(deltaPct * 10) / 10,
      beyondBudget: 1,
      edge: args.wideEdge,
      winRate: args.wideWinRate,
      snapped: wide.snapped === true ? 1 : 0,
      allNice: tagged ? (wide.allNice === true ? 1 : 0) : -1,
      tag: tagged ? tag : -1,
    },
    humanCopy,
    proof: {
      // The probe IS a full engine solve — solver-verified is honest.
      evMinAfter: wide.price * (1 - args.wideEdge),
      evMaxAfter: wide.price * (1 - args.wideEdge),
      feasibleAfter: true,
      solverVerified: true,
    },
  };
}

// ── POOL-EDITS-FIRST (owner-lens §3 / Pattern 1, 10) ────────────────────
//
// When the fixed-pool plan is DEGENERATE or INFEASIBLE, editing the POOL (add a
// mid card / remove dead cards) is the real fix — a price move alone can't
// spread a one-carrier ladder. The guidance engine already computes + solver-
// round-trips these levers (`add-card`, `remove-dead-card`, `price-move`); this
// derives the PRIMARY recommendation from them as a single structured object so
// the plan can lead with it (and the workspace can one-click stage it). Pure —
// derived entirely from an already-computed `TagGuidance`; never re-solves.

export type PoolEditReason =
  | "degenerate-shape"
  | "infeasible"
  | "risk-band-exit"
  // Pattern 10: a FEASIBLE plan that stayed dirty (snapped=false) after the
  // search exhausted its whole candidate budget (fellBackToBase) — no clean
  // value exists at any in-band price. The escape hatch is a pool edit that
  // MAKES a clean solve exist, never "nudge the price" (which the engine just
  // proved has no clean value in the band).
  | "dirty-dead-end";

export type PoolEditPlan = {
  /** Why the pool edit is the primary recommendation. */
  reason: PoolEditReason;
  /** The add-one-card lever (null = pure-removal or price-only rec). */
  addCard: {
    band: string;
    valueMin: number;
    valueMax: number;
    suggestedValue: number;
    /** Predicted share of opens the new card carries (fraction). */
    expectedShare: number;
  } | null;
  /** Dead cards to remove (crushed / floor-pinned; each removal-proven). */
  removeCardIds: string[];
  /** The verified price for the edited pool (from an accompanying price-*). */
  price: number | null;
  /** TRUE when `price` sits outside the ±budget of live. */
  beyondBudget: boolean;
  /** Never emitted unproven — the guidance suggestions are all solver-round-tripped. */
  solverVerified: boolean;
};

/**
 * Derive the PRIMARY {@link PoolEditPlan} from a plan's already-computed
 * guidance (owner-lens §3). Picks the top `add-card` lever (else a pure-removal
 * fix), collects every `remove-dead-card` id, and takes the price from an
 * accompanying `price-move` / `price-edge-exact` suggestion. Returns `null` when
 * the guidance carries no actionable pool lever (falls back to the plain
 * suggestions banner). Pure + sync.
 *
 * `livePrice` + `priceBudgetPct` classify the recommended price as beyond-budget
 * (shown, never auto-applied).
 */
export function derivePoolEditPlan(
  guidance: TagGuidance | null,
  reason: PoolEditReason,
  livePrice: number,
  priceBudgetPct: number,
): PoolEditPlan | null {
  if (guidance === null) return null;
  const sugg = guidance.suggestions;
  const add = sugg.find((s) => s.kind === "add-card") ?? null;
  const removeCardIds = sugg
    .filter((s) => s.kind === "remove-dead-card" && typeof s.params.cardId === "string")
    .map((s) => String(s.params.cardId));
  const priceSugg =
    sugg.find((s) => s.kind === "price-edge-exact") ??
    sugg.find((s) => s.kind === "price-move") ??
    null;
  // No actionable pool lever at all → let the caller fall back to the banner.
  if (add === null && removeCardIds.length === 0) return null;

  const addCard =
    add !== null
      ? {
          band: String(add.params.band ?? ""),
          valueMin: Number(add.params.valueMin ?? 0),
          valueMax: Number(add.params.valueMax ?? 0),
          suggestedValue: Number(add.params.suggestedValue ?? 0),
          expectedShare: Number(add.params.expectedShare ?? 0),
        }
      : null;
  const price = priceSugg !== null ? Number(priceSugg.params.price) : null;
  const beyondBudget =
    price !== null && livePrice > 0
      ? Math.abs(price - livePrice) / livePrice > priceBudgetPct + 1e-9
      : false;
  return {
    reason,
    addCard,
    removeCardIds,
    price,
    beyondBudget,
    solverVerified: true,
  };
}

/**
 * Drop NO-OP price suggestions (owner-lens Pattern 9h): a `price-move` /
 * `price-edge-exact` whose price equals the plan's OWN landed price within 1¢
 * is telling the owner to "move" to the price the plan already picked — noise
 * that erodes trust in the whole guidance list. Pure — returns a new guidance
 * (or the same object when nothing was pruned; null passes through).
 *
 * `priceAfter` is the plan's landed price (`PackTunePlan.priceAfter`). The
 * caller applies this AFTER the wide-probe merge so a beyond-budget far price
 * (which by construction differs from the in-budget landed price) is never
 * pruned.
 */
export function pruneNoOpSuggestions(
  guidance: TagGuidance | null,
  priceAfter: number,
): TagGuidance | null {
  if (guidance === null || !(priceAfter > 0)) return guidance;
  const kept = guidance.suggestions.filter((s) => {
    if (s.kind !== "price-move" && s.kind !== "price-edge-exact") return true;
    const p = Number(s.params.price);
    if (!Number.isFinite(p)) return true;
    return Math.abs(p - priceAfter) > 0.01 + 1e-9;
  });
  if (kept.length === guidance.suggestions.length) return guidance;
  return { ...guidance, suggestions: kept };
}

export type UntaggedPlanGuidanceInput = {
  /** Pool card values, aligned with `currentWeights` / `plannedShares`. */
  cards: { value: number }[];
  /** LIVE pool weights aligned to `cards`; a staged-in card carries 0. */
  currentWeights: number[];
  /** Optional cardIds aligned to `cards` — threaded into per-card params. */
  cardIds?: string[] | null;
  /** The pack's LIVE ticket price (band anchor for the suggestion copy). */
  livePrice: number;
  /** The PLAN's landed price (`priceAfter` — the retune search's pick). */
  price: number;
  /** The plan's resolved targets (held fixed across the retune price search). */
  targetEdge: number;
  /** The soft design win-rate (0.20 for untagged packs). */
  targetWinRate: number;
  /** The untagged near-miss floor (0.10 default). */
  nearMissMin: number;
  maxWinCap: number;
  /** The plan's per-card probabilities as FRACTIONS of 1, aligned to `cards`. */
  plannedShares: number[];
  /** The solver's relaxations from the accepted plan (win-rate float, etc.). */
  relaxations: readonly Pick<
    ShapeWeightsRelaxation,
    "lever" | "requested" | "applied"
  >[];
  /** TRUE when the operator pinned the price — price-moving fixes are off. */
  pinPrice?: boolean;
  /**
   * The §shape-guard verdict on THIS plan ({@link ladderShape}.degenerate),
   * computed by the caller over the same planned vector (owner-lens §2.3). A
   * NEW detection trigger: the three legacy signatures (floor pins / forced
   * loss-avg / empty-NM+float) all MISS complaint (B) "Tails?" — its $20.02
   * card lands at 0.0002% (above the 0.0001% floor test) and no float relaxation
   * fired at ±10%, so the ladder inversion + carrier absorption is invisible to
   * them. The shape guard catches it; feeding its verdict here makes the pool-
   * edit guidance fire on that whole class. Optional (defaults false) so legacy
   * callers are unaffected.
   */
  shapeDegenerate?: boolean;
  /**
   * Owner-typed pins (staged arm) aligned to `cards` by index — the SAME
   * treatment {@link computeTagGuidance} got: pinned cards enter every
   * feasibility window as fixed point-masses carved out of the free bands, the
   * add-card verification solves run WITH the pins held, and an owner-pinned
   * card is never floor-pin-detected (its share is owner intent, not the
   * quantizer's 0.0001% signature) nor suggested for removal. Omit/empty ⇒
   * legacy behavior, byte-identical.
   */
  pinnedShares?: ShapeWeightsPinnedShare[] | null;
};

/** Soft-mode (untagged) never-inflate caps at a price: existing win/grail
 * cards cap at live odds, grail monotone running-min, cheapest FREE winner
 * EXEMPT (the float-up's sink — its cap is lifted, exactly like the solver).
 * Owner pins are carved out of the free bands as fixed point-masses (every
 * Fixed aggregate is 0 without pins — byte-identical legacy math). */
function softBandsAt(
  cards: readonly { value: number }[],
  currentWeights: readonly number[],
  price: number,
  cap: number,
  pinnedShares?: readonly ShapeWeightsPinnedShare[] | null,
): {
  winValues: number[];
  winCaps: number[];
  nmValues: number[];
  dustValues: number[];
  winFixedMass: number;
  winFixedEv: number;
  nmFixedMass: number;
  nmFixedEv: number;
  dustFixedMass: number;
  dustFixedEv: number;
} {
  const pinByIdx = new Map<number, number>();
  if (pinnedShares) {
    for (const p of pinnedShares) {
      if (Number.isFinite(p.share) && p.share > 0) pinByIdx.set(p.index, p.share);
    }
  }
  let curTotal = 0;
  for (const w of currentWeights) {
    if (Number.isFinite(w) && w > 0) curTotal += w;
  }
  const winValues: number[] = [];
  const winCaps: number[] = [];
  const nmValues: number[] = [];
  const dustValues: number[] = [];
  let winFixedMass = 0;
  let winFixedEv = 0;
  let nmFixedMass = 0;
  let nmFixedEv = 0;
  let dustFixedMass = 0;
  let dustFixedEv = 0;
  cards.forEach((c, idx) => {
    const v = c.value;
    if (!(v > 0) || v > cap) return;
    const pin = pinByIdx.get(idx);
    if (v >= price) {
      if (pin !== undefined) {
        winFixedMass += pin;
        winFixedEv += pin * v;
        return;
      }
      winValues.push(v);
      const w = currentWeights[idx];
      winCaps.push(
        curTotal > 0 && Number.isFinite(w) && (w as number) > 0
          ? (w as number) / curTotal
          : Infinity,
      );
    } else if (v >= 0.5 * price) {
      if (pin !== undefined) {
        nmFixedMass += pin;
        nmFixedEv += pin * v;
        return;
      }
      nmValues.push(v);
    } else {
      if (pin !== undefined) {
        dustFixedMass += pin;
        dustFixedEv += pin * v;
        return;
      }
      dustValues.push(v);
    }
  });
  // Grail monotone running-min (value-ascending, ≥ 5·price).
  const grailAsc = winValues
    .map((v, i) => ({ i, v }))
    .filter((x) => x.v >= 5 * price)
    .sort((a, b) => a.v - b.v);
  let runningMin = Infinity;
  for (const { i } of grailAsc) {
    runningMin = Math.min(runningMin, winCaps[i]!);
    winCaps[i] = runningMin;
  }
  // Cheapest-FREE-winner exemption (SOFT mode only — the EV-balance sink).
  if (winValues.length > 0) {
    let cheapIdx = 0;
    for (let i = 1; i < winValues.length; i++) {
      if (winValues[i]! < winValues[cheapIdx]!) cheapIdx = i;
    }
    winCaps[cheapIdx] = Infinity;
  }
  return {
    winValues,
    winCaps,
    nmValues,
    dustValues,
    winFixedMass,
    winFixedEv,
    nmFixedMass,
    nmFixedEv,
    dustFixedMass,
    dustFixedEv,
  };
}

/**
 * Detect a degenerate loss ladder on an accepted UNTAGGED plan and, when
 * found, emit the ranked/proven guidance. Returns `null` for a healthy plan.
 *
 * Detection (any of):
 *   1. a LOSS-band card pinned at the quantization floor (0.0001%),
 *   2. the planned dust-band average forced to within a few percent of the
 *      max dust value (≥ 2 dust values — the β endpoint signature),
 *   3. an empty near-miss band together with a win-rate FLOAT-UP relaxation.
 */
export function computeUntaggedGuidance(
  input: UntaggedPlanGuidanceInput,
): TagGuidance | null {
  const { price, targetEdge, targetWinRate } = input;
  if (
    !(price > 0) ||
    input.cards.length === 0 ||
    input.plannedShares.length !== input.cards.length
  ) {
    return null;
  }

  // Owner pins (staged arm) — carved into every window this advisor builds;
  // a pinned share is owner intent: never floor-pin-detected, never a removal
  // candidate, and every verification solve holds it. Null ⇒ legacy math.
  const ownerPins =
    input.pinnedShares != null && input.pinnedShares.length > 0
      ? input.pinnedShares
      : null;
  const ownerPinnedIdx = new Set<number>();
  if (ownerPins) {
    for (const p of ownerPins) {
      if (Number.isFinite(p.share) && p.share > 0) ownerPinnedIdx.add(p.index);
    }
  }

  // ── Planned aggregates at the landed price ────────────────────────────────
  const pinnedIdx: number[] = [];
  let winMassPlanned = 0;
  let winEvPlanned = 0;
  let lossMassPlanned = 0;
  let dustMassPlanned = 0;
  let dustEvPlanned = 0;
  let dustCount = 0;
  let dustMaxValue = 0;
  let nmCount = 0;
  // The CARRIER: the loss card the endpoint skew parks the mass on (richest
  // dust in the Captive/high-EV case, cheapest in the low-EV case) — named in
  // the copy so the WHY reads off the actual ladder.
  let carrierValue = 0;
  let carrierShare = 0;
  input.cards.forEach((c, i) => {
    const v = c.value;
    const share = input.plannedShares[i] ?? 0;
    if (!(v > 0)) return;
    if (v >= price) {
      winMassPlanned += share;
      winEvPlanned += share * v;
      return;
    }
    lossMassPlanned += share;
    if (share > carrierShare) {
      carrierShare = share;
      carrierValue = v;
    }
    if (v >= 0.5 * price) {
      nmCount += 1;
    } else {
      dustCount += 1;
      dustMassPlanned += share;
      dustEvPlanned += share * v;
      if (v > dustMaxValue) dustMaxValue = v;
    }
    if (!ownerPinnedIdx.has(i) && isFloorPinnedPct(share * 100)) pinnedIdx.push(i);
  });

  const dustAvg = dustMassPlanned > 1e-9 ? dustEvPlanned / dustMassPlanned : 0;
  const winFloated = input.relaxations.some(
    (r) => r.lever === "winRate" && r.applied > r.requested + 1e-9,
  );
  // "Forced to the max" only counts as degenerate when the win-rate float
  // actually fired (the float bisects to the point where the loss side's MAX
  // EV meets the target — the β-endpoint signature). A no-float plan whose
  // dust average merely sits high is the pool paying what it was designed to.
  const lossAvgForced =
    winFloated &&
    dustCount >= 2 &&
    dustMaxValue > 0 &&
    dustAvg >= 0.95 * dustMaxValue;
  const degenerate =
    pinnedIdx.length > 0 ||
    lossAvgForced ||
    (nmCount === 0 && winFloated) ||
    // NEW (owner-lens §2.3): the shape guard's verdict catches complaint (B),
    // which all three legacy signatures miss (no floor pin, no forced loss-avg,
    // a non-empty NM band or no float).
    input.shapeDegenerate === true;
  if (!degenerate) return null;

  // ── Feasibility payload: the no-float interval at the DESIGN win-rate ─────
  // evMax = the most the pool can pay at 20% wins without inflating anything
  // (win fill at the baseline decay + loss bands skewed expensive). The plan's
  // evTarget above it ⇒ the float-up fired ⇒ the ladder degenerated. Owner
  // pins ride every term as fixed point-masses (all Fixed = 0 without pins).
  const base = softBandsAt(
    input.cards,
    input.currentWeights,
    price,
    input.maxWinCap,
    ownerPins,
  );
  const nmMass =
    base.nmValues.length > 0
      ? Math.max(0, input.nearMissMin - base.nmFixedMass)
      : 0;
  const winFree = Math.max(0, targetWinRate - base.winFixedMass);
  const dm = Math.max(
    0,
    1 - targetWinRate - nmMass - base.nmFixedMass - base.dustFixedMass,
  );
  const evTarget = price * (1 - targetEdge);
  const lossFixedEv = base.nmFixedEv + base.dustFixedEv;
  const evMax =
    waterFillWinEv(base.winValues, base.winCaps, winFree, BETA_WIN_FLOOR) +
    base.winFixedEv +
    nmMass * bandEvForBeta(base.nmValues, BETA_LO) +
    dm * bandEvForBeta(base.dustValues, BETA_LO) +
    lossFixedEv;
  const evMin =
    waterFillWinEv(base.winValues, base.winCaps, winFree, BETA_WIN_MAX) +
    base.winFixedEv +
    nmMass * bandEvForBeta(base.nmValues, BETA_HI) +
    dm * bandEvForBeta(base.dustValues, BETA_HI) +
    lossFixedEv;

  const suggestions: TuneSuggestion[] = [];
  const lossAvgNeeded =
    lossMassPlanned > 1e-9 ? (evTarget - winEvPlanned) / lossMassPlanned : 0;

  // ── 1. add-card (mid) — the spread lever, solver-round-tripped ────────────
  // The float-up fires at price P′ iff  evT(P′) > W(0.2) + nm·X + dm·D_hi —
  // so a mid card of value X kills the float (and the ladder spreads) exactly
  // when X clears the analytic bound. The near-miss band is tried FIRST (the
  // added card becomes the NM band and carries exactly the nearMissMin mass);
  // upper-dust is the fallback. Every candidate is verified through the REAL
  // solver (no float relaxation, no floor pins) before emission.
  const nmSeed = input.nearMissMin > 0 ? input.nearMissMin : 0.1;
  {
    // The scan starts AT the landed price and walks the price band downward;
    // when the price is pinned it is restricted to the single landed-price
    // candidate — the analytic bound then almost never clears, which is
    // honest: this fix needs the price lever.
    const pStart = round2(Math.min(price, input.livePrice));
    const pFloor = Math.max(0.01, 0.4 * input.livePrice);
    const step = Math.max(0.01, round2(input.livePrice * 0.005));
    // Round-trip a candidate (pool + new card, pinned price) through the REAL
    // solver; accept only a solve that holds the DESIGN win-rate (no float)
    // with the whole loss ladder spread (no floor pins). Returns the solve's
    // `snapped` flag so the copy can be honest about clean vs exact odds.
    const solveSpreads = (
      cards: { value: number }[],
      weights: number[],
      pCand: number,
      nearMiss: number,
    ): { ok: boolean; snapped: boolean } => {
      const r = shapeWeights({
        cards,
        price: pCand,
        targetEdge,
        targetWinRate,
        maxWinCap: input.maxWinCap,
        nearMissMin: nearMiss,
        winRateTol: 0.02,
        currentWeights: weights,
        // The staged solve holds owner pins EXACT — the verification must run
        // the same problem (add-card appends, so pin indexes stay valid).
        ...(ownerPins
          ? { pinnedShares: ownerPins.map((p) => ({ ...p })) }
          : {}),
      });
      if ("error" in r) return { ok: false, snapped: false };
      if (r.risk.edge < targetEdge - 1e-9) return { ok: false, snapped: false };
      if (Math.abs(r.risk.winRate - targetWinRate) > 0.02 + 1e-9) {
        return { ok: false, snapped: false };
      }
      let total = 0;
      for (const w of r.weights) if (w > 0) total += w;
      if (!(total > 0)) return { ok: false, snapped: false };
      for (let i = 0; i < cards.length; i++) {
        const v = cards[i]!.value;
        if (!(v > 0) || v >= pCand) continue;
        // An owner-pinned share is intent, not a quantization floor.
        if (ownerPinnedIdx.has(i)) continue;
        if (isFloorPinnedPct(((r.weights[i] ?? 0) / total) * 100)) {
          return { ok: false, snapped: false };
        }
      }
      return { ok: true, snapped: r.snapped === true };
    };

    let verifies = 0;
    const MAX_VERIFIES = 8;
    let emitted = false;
    for (
      let pCand = pStart;
      pCand >= pFloor - 1e-9 && verifies < MAX_VERIFIES && !emitted;
      pCand = round2(pCand - step)
    ) {
      if (input.pinPrice === true && Math.abs(pCand - price) > 1e-9) break;
      const bands = softBandsAt(
        input.cards,
        input.currentWeights,
        pCand,
        input.maxWinCap,
        ownerPins,
      );
      if (bands.winValues.length === 0 || bands.dustValues.length === 0) continue;
      const evT = pCand * (1 - targetEdge);
      const w02 =
        waterFillWinEv(
          bands.winValues,
          bands.winCaps,
          Math.max(0, targetWinRate - bands.winFixedMass),
          BETA_WIN_FLOOR,
        ) + bands.winFixedEv;
      const dHi = bandEvForBeta(bands.dustValues, BETA_LO);
      // Near-miss route: the new card becomes the NM band (mass = nmSeed).
      const dmWith = Math.max(
        0,
        1 - targetWinRate - nmSeed - bands.nmFixedMass - bands.dustFixedMass,
      );
      const xLo =
        (evT - w02 - dmWith * dHi - bands.nmFixedEv - bands.dustFixedEv) /
        nmSeed;
      // The band shown to the operator: a near-miss at BOTH the fix price and
      // the live price (so the picked card stays mid-band wherever the price
      // finally lands), above the analytic bound with a small spread margin.
      const xMin = round2(
        Math.max(0.5 * pCand, 0.5 * input.livePrice, xLo * 1.02, 0.01),
      );
      const xMax = round2(0.95 * pCand);
      // Require a real band (≥ 10% of the price wide), not a knife's edge — a
      // slightly lower price buys a much wider card choice AND a comfortably
      // interior loss skew (more spread margin past the analytic bound).
      if (!(xMax - xMin >= Math.max(0.5, 0.1 * pCand))) continue;
      const xSuggest = round2(Math.min(xMax, Math.max(xMin, 0.9 * pCand)));
      verifies += 1;
      const rt = solveSpreads(
        [...input.cards.map((c) => ({ value: c.value })), { value: xSuggest }],
        [...input.currentWeights, 0],
        pCand,
        nmSeed,
      );
      if (!rt.ok) continue;
      const evMaxAfter =
        w02 +
        nmSeed * xSuggest +
        dmWith * dHi +
        bands.nmFixedEv +
        bands.dustFixedEv;
      const evMinAfter =
        waterFillWinEv(
          bands.winValues,
          bands.winCaps,
          Math.max(0, targetWinRate - bands.winFixedMass),
          BETA_WIN_MAX,
        ) +
        bands.winFixedEv +
        nmSeed * xSuggest +
        dmWith * bandEvForBeta(bands.dustValues, BETA_HI) +
        bands.nmFixedEv +
        bands.dustFixedEv;
      suggestions.push({
        kind: "add-card",
        params: {
          band: "near-miss",
          valueMin: xMin,
          valueMax: xMax,
          suggestedValue: xSuggest,
          expectedShare: nmSeed,
          price: pCand,
        },
        humanCopy: `Add a mid-value card between ${usd(xMin)} and ${usd(xMax)} (suggest ${usd(xSuggest)} — it becomes the near-miss band and carries ≈${(nmSeed * 100).toFixed(0)}% of opens) and set the price to ≈${usd(pCand)}, pinned (the free price search drifts back to the degenerate ladder): the loss ladder then spreads across the cheap cards and the win rate lands back at ${(targetWinRate * 100).toFixed(0)}%.${rt.snapped ? "" : " Odds land exact but off the clean ladder."}`,
        proof: {
          evMinAfter,
          evMaxAfter,
          feasibleAfter: true,
          solverVerified: true,
        },
      });
      emitted = true;
    }

    // Upper-dust fallback: no near-miss value can clear the bound anywhere in
    // the band — try a rich dust card (just under 0.5·P′) instead.
    if (!emitted) {
      for (
        let pCand = pStart;
        pCand >= pFloor - 1e-9 && verifies < MAX_VERIFIES && !emitted;
        pCand = round2(pCand - step)
      ) {
        if (input.pinPrice === true && Math.abs(pCand - price) > 1e-9) break;
        const bands = softBandsAt(
          input.cards,
          input.currentWeights,
          pCand,
          input.maxWinCap,
          ownerPins,
        );
        if (bands.winValues.length === 0) continue;
        const evT = pCand * (1 - targetEdge);
        const w02 =
          waterFillWinEv(
            bands.winValues,
            bands.winCaps,
            Math.max(0, targetWinRate - bands.winFixedMass),
            BETA_WIN_FLOOR,
          ) + bands.winFixedEv;
        const nmHere = bands.nmValues.length > 0 ? nmSeed : 0;
        const dmHere = Math.max(
          0,
          1 - targetWinRate - nmHere - bands.nmFixedMass - bands.dustFixedMass,
        );
        if (!(dmHere > 1e-9)) continue;
        const nmEv =
          nmHere * bandEvForBeta(bands.nmValues, BETA_LO) +
          bands.nmFixedEv +
          bands.dustFixedEv;
        // With the new card X as the richest dust value, the loss side's max
        // EV is ≈ dm·X — the no-float bound solves to X ≥ (evT − W − nmEv)/dm.
        const xLo = (evT - w02 - nmEv) / dmHere;
        const xMin = round2(Math.max(xLo * 1.02, dustMaxValue * 1.05, 0.01));
        const xMax = round2(0.5 * pCand - 0.01);
        if (!(xMax - xMin >= Math.max(0.25, 0.005 * pCand))) continue;
        const xSuggest = round2(Math.min(xMax, Math.max(xMin, 0.45 * pCand)));
        verifies += 1;
        const rt = solveSpreads(
          [...input.cards.map((c) => ({ value: c.value })), { value: xSuggest }],
          [...input.currentWeights, 0],
          pCand,
          nmHere,
        );
        if (!rt.ok) continue;
        // Mixing estimate for the copy: the new card must lift the dust band's
        // EV from the rest-average to the required average.
        const dReq = (evT - w02 - nmEv) / dmHere;
        const dRest = bandEvForBeta(bands.dustValues, 0); // uniform approx
        const share =
          xSuggest - dRest > 1e-9
            ? Math.min(dmHere, Math.max(0, (dmHere * (dReq - dRest)) / (xSuggest - dRest)))
            : dmHere;
        suggestions.push({
          kind: "add-card",
          params: {
            band: "dust-upper",
            valueMin: xMin,
            valueMax: xMax,
            suggestedValue: xSuggest,
            expectedShare: share,
            price: pCand,
          },
          humanCopy: `No single near-miss card can carry enough here — add a rich loss card between ${usd(xMin)} and ${usd(xMax)} (suggest ${usd(xSuggest)} — it would carry ≈${(share * 100).toFixed(1)}% of opens) and set the price to ≈${usd(pCand)}, pinned: the loss ladder then spreads and the win rate lands back at ${(targetWinRate * 100).toFixed(0)}%.${rt.snapped ? "" : " Odds land exact but off the clean ladder."}`,
          proof: {
            evMinAfter: evMin,
            evMaxAfter: w02 + nmEv + dmHere * xSuggest,
            feasibleAfter: true,
            solverVerified: true,
          },
        });
        emitted = true;
      }
    }
  }

  // ── 2. remove-dead-card — the floor-pinned cards (harmless, ~0 EV) ────────
  if (pinnedIdx.length > 0) {
    // One re-solve WITHOUT the pinned cards proves the removal is a no-op.
    const keepCards: { value: number }[] = [];
    const keepWeights: number[] = [];
    const keepPins: ShapeWeightsPinnedShare[] = [];
    const pinnedSet = new Set(pinnedIdx);
    input.cards.forEach((c, i) => {
      if (pinnedSet.has(i)) return;
      if (ownerPins && ownerPinnedIdx.has(i)) {
        const pin = ownerPins.find(
          (p) => p.index === i && Number.isFinite(p.share) && p.share > 0,
        );
        // Re-index the surviving pins onto the reduced pool.
        if (pin) keepPins.push({ index: keepCards.length, share: pin.share });
      }
      keepCards.push({ value: c.value });
      keepWeights.push(input.currentWeights[i] ?? 0);
    });
    let removalOk = false;
    try {
      const r = shapeWeights({
        cards: keepCards,
        price,
        targetEdge,
        targetWinRate,
        maxWinCap: input.maxWinCap,
        nearMissMin: input.nearMissMin,
        winRateTol: 0.02,
        currentWeights: keepWeights,
        ...(keepPins.length > 0 ? { pinnedShares: keepPins } : {}),
      });
      removalOk = !("error" in r) && r.risk.edge >= targetEdge - 1e-9;
    } catch {
      removalOk = false;
    }
    for (const i of pinnedIdx) {
      const v = input.cards[i]!.value;
      suggestions.push({
        kind: "remove-dead-card",
        params: {
          ...(input.cardIds ? { cardId: input.cardIds[i]! } : {}),
          cardValue: v,
          plannedPct: (input.plannedShares[i] ?? 0) * 100,
        },
        humanCopy: `${usd(v)} is pinned at the ${FLOOR_PINNED_MAX_PCT}% odds floor — the edge target parks the loss mass on the ${usd(carrierValue)} card, so this one carries ~0% of opens and ~$0 of EV. Removing it changes nothing (the plan re-solves the same without it).`,
        proof: {
          evMinAfter: evMin,
          evMaxAfter: evMax,
          feasibleAfter: removalOk,
        },
      });
    }
  }

  // ── 3. accept-as-is — the plan is sound; this is the pool's structure ─────
  // Pattern 9c (owner-lens §9 rule 3): the accept-as-is copy must SHARE the
  // shape guard's verdict — it may NOT bless a DEGENERATE ladder with "Fine to
  // push as-is" (that copy talked the owner into shipping the exact flagged
  // screenshot). When the shape guard flagged this plan degenerate, the
  // acceptance is honest-but-unblessed: you CAN push (it is mathematically
  // sound), but the pool edit above is the real fix. Only a NON-degenerate
  // reason to be here (harmless floor pins on truly-dead cards) keeps the
  // original "Fine to push as-is" blessing.
  const acceptBody = `At ${usd(price)} the losing ${(lossMassPlanned * 100).toFixed(1)}% of opens must average ≈${usd(lossAvgNeeded)}, and only the ${usd(carrierValue)} card can carry that — so the other loss cards sit at the minimum odds${winFloated ? ` and the win rate floats to ${(winMassPlanned * 100).toFixed(1)}%` : ""}.`;
  suggestions.push({
    kind: "accept-as-is",
    params: {
      winRatePct: winMassPlanned * 100,
      lossMassPct: lossMassPlanned * 100,
      lossAvgNeeded: round2(lossAvgNeeded),
      carrierValue,
      maxLossValue: dustMaxValue,
      degenerate: input.shapeDegenerate === true ? 1 : 0,
    },
    humanCopy:
      input.shapeDegenerate === true
        ? `The math is sound but the ladder is degenerate — ${acceptBody} This is pushable, but the pool edit above is the real fix; accept it only if this concentration is intentional.`
        : `This plan is sound — the pins are the pool's structure, not an error. ${acceptBody} Fine to push as-is.`,
    proof: {
      evMinAfter: evMin,
      evMaxAfter: evMax,
      feasibleAfter: true,
    },
  });

  suggestions.sort((a, b) => SUGGESTION_RANK[a.kind] - SUGGESTION_RANK[b.kind]);

  return {
    feasibility: {
      evTarget,
      evMin,
      evMax,
      // The PLAN is feasible (it solved) — the interval reports the no-float
      // window at the DESIGN win-rate, whose miss is what degenerated the
      // ladder (direction need-ev-up = the float-up signature).
      feasible: true,
      saturated: false,
      direction: evTarget > evMax + 1e-9 ? "need-ev-up" : "ok",
      components: {
        winEvMin:
          waterFillWinEv(base.winValues, base.winCaps, winFree, BETA_WIN_MAX) +
          base.winFixedEv,
        winEvMax:
          waterFillWinEv(base.winValues, base.winCaps, winFree, BETA_WIN_FLOOR) +
          base.winFixedEv,
        nmMass,
        dustMass: dm,
        capSum: -1,
      },
    },
    suggestions,
  };
}

// ═══ PIN REMEDIES (retune V3 — pins-refusal repair search) ═══════════════════
//
// When a pinned retune REFUSES, the refusal names the gap ("pins carry too
// much/too little EV") but not the way out. This section computes VERIFIED
// remedies: the smallest single-pin changes (raise / lower / unpin) — plus an
// in-budget price move when the price isn't pinned — under which the SAME
// solve the retune runs actually accepts. Every emitted remedy round-trips the
// real solver (`shapeWeights` with the modified pins); nothing unverified is
// ever returned, and an empty list is itself a verdict ("no single-pin change
// fixes this — the pins interlock").
//
// Search strategy (solver-driven; the pinned acceptance region has no closed
// form): per pin per direction the search (1) samples the reachable span on a
// coarse ladder walking AWAY from the current pin, (2) on the first accepted
// sample bisects the accept/refuse boundary toward the smallest change,
// (3) snaps to the human step grid INTO the accepted side and re-verifies
// (walking a few grid steps when the snapped value refuses). Bounded work:
// ≤ ~30 solver calls per pin per direction on pool sizes this advisor sees.

export type PinRemedyKind =
  | "raise-pin"
  | "lower-pin"
  | "unpin-card"
  | "price-move";

export type PinRemedy = {
  kind: PinRemedyKind;
  /** Pool index / value of the pinned card (pin kinds only). */
  cardIndex?: number;
  cardValue?: number;
  /** The pin's current / proposed percent-of-opens (pin kinds only). */
  fromPct?: number;
  toPct?: number;
  /** The verified price (price-move only). */
  price?: number;
  /** The verifying solve's landed edge (fraction). */
  edge: number;
  humanCopy: string;
  /** Always true — an unverified remedy is never emitted. */
  verified: true;
};

export type PinRemedyInput = {
  cards: { value: number }[];
  /** Anti-inflation anchor (live weights; a staged-in card carries 0). */
  currentWeights: number[];
  price: number;
  targetEdge: number;
  targetWinRate: number;
  nearMissMin: number;
  maxWinCap: number;
  /** Win-rate tolerance for the untagged verify (default 0.02). */
  winRateTol?: number;
  /** The refused pin set (fractions of 1, aligned to `cards` by index). */
  pinnedShares: ShapeWeightsPinnedShare[];
  /**
   * The resolved tag hit-rate. A LOTTERY tag (≤ 12%, equal to the target
   * win-rate — the retune-params gate) verifies tag-HARD at the strict
   * tolerance; everything else verifies hard-hold → soft-hold fallback,
   * exactly like the staged retune solve.
   */
  intendedHitRate?: number | null;
  /** TRUE ⇒ the price is owner-pinned; no price-move remedies. */
  pinPrice?: boolean;
  /** Price budget for price-move remedies (fraction of price, default 10%). */
  priceBudgetPct?: number;
  /** Cap on emitted remedies (default 4). */
  maxRemedies?: number;
};

/** Human step grid for a pin percentage (the odds-editor's display steps). */
function pinStepPct(pct: number): number {
  if (pct >= 20) return 0.5;
  if (pct >= 5) return 0.25;
  if (pct >= 1) return 0.05;
  if (pct >= 0.1) return 0.01;
  return 0.001;
}
const ceilToStep = (pct: number): number => {
  const s = pinStepPct(pct);
  return Math.ceil(pct / s - 1e-9) * s;
};
const floorToStep = (pct: number): number => {
  const s = pinStepPct(pct);
  return Math.floor(pct / s + 1e-9) * s;
};
const roundPct = (pct: number): number => Math.round(pct * 1e6) / 1e6;
const pctFmt = (pct: number): string => {
  const s = pct.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return s === "" || s === "-0" ? "0" : s;
};

export function computePinRemedies(input: PinRemedyInput): PinRemedy[] {
  const price = input.price;
  const pins = (input.pinnedShares ?? []).filter(
    (p) =>
      Number.isFinite(p.share) &&
      p.share > 0 &&
      Number.isInteger(p.index) &&
      p.index >= 0 &&
      p.index < input.cards.length,
  );
  if (!(price > 0) || pins.length === 0 || input.cards.length === 0) return [];
  const winRateTol = input.winRateTol ?? 0.02;
  // Mirror of the retune-params lottery gate: hitRate ≤ 12% AND the target
  // win-rate IS the tag ⇒ the staged solve ran tag-HARD.
  const tagged =
    input.intendedHitRate != null &&
    Number.isFinite(input.intendedHitRate) &&
    input.intendedHitRate <= 0.12 &&
    Math.abs(input.intendedHitRate - input.targetWinRate) < 1e-9;

  const verify = (
    cand: readonly ShapeWeightsPinnedShare[],
    atPrice: number,
  ): { ok: boolean; edge: number } => {
    const base = {
      cards: input.cards.map((c) => ({ value: c.value })),
      price: atPrice,
      targetEdge: input.targetEdge,
      targetWinRate: input.targetWinRate,
      maxWinCap: input.maxWinCap,
      nearMissMin: input.nearMissMin,
      currentWeights: input.currentWeights.slice(),
      disperseLoss: true,
      ...(cand.length > 0
        ? { pinnedShares: cand.map((p) => ({ ...p })) }
        : {}),
    };
    try {
      if (tagged) {
        const r = shapeWeights({
          ...base,
          winRateTol: TAGGED_WINRATE_TOLERANCE,
          winRateIsHard: true,
        });
        if (
          !("error" in r) &&
          r.edge >= input.targetEdge - 1e-9 &&
          Math.abs(r.risk.winRate - input.targetWinRate) <=
            TAGGED_WINRATE_TOLERANCE + 1e-9
        ) {
          return { ok: true, edge: r.edge };
        }
        return { ok: false, edge: 0 };
      }
      const hard = shapeWeights({
        ...base,
        winRateTol,
        holdWinRateHard: true,
      });
      if (!("error" in hard) && hard.edge >= input.targetEdge - 1e-9) {
        return { ok: true, edge: hard.edge };
      }
      const soft = shapeWeights({ ...base, winRateTol, holdWinRate: true });
      if (!("error" in soft) && soft.edge >= input.targetEdge - 1e-9) {
        return { ok: true, edge: soft.edge };
      }
    } catch {
      /* refusal — fall through */
    }
    return { ok: false, edge: 0 };
  };

  // Remedies only exist against a REFUSED base — an accepting base has
  // nothing to repair.
  if (verify(pins, price).ok) return [];

  let pinTotal = 0;
  for (const p of pins) pinTotal += p.share;
  const freeMass = Math.max(0, 1 - pinTotal);
  let curTotal = 0;
  for (const w of input.currentWeights) {
    if (Number.isFinite(w) && w > 0) curTotal += w;
  }

  const withPinAt = (
    index: number,
    sharePct: number,
  ): ShapeWeightsPinnedShare[] =>
    pins.map((p) =>
      p.index === index ? { index, share: sharePct / 100 } : { ...p },
    );

  type Found = { toPct: number; edge: number };
  // Directional scan+bisect along one pin's share axis, oriented AWAY from
  // the current (refused) pin. Returns the accepted grid value closest to it.
  const searchDirection = (
    index: number,
    fromPct: number,
    farPct: number,
    dir: 1 | -1,
  ): Found | null => {
    const span = (farPct - fromPct) * dir;
    if (!(span > 1e-9)) return null;
    const SAMPLES = 12;
    let accepted: { pct: number; edge: number } | null = null;
    let refusedNear = fromPct;
    for (let k = 1; k <= SAMPLES; k++) {
      const pct = roundPct(fromPct + (dir * (span * k)) / SAMPLES);
      if (!(pct > 0) || pct > 100) break;
      const r = verify(withPinAt(index, pct), price);
      if (r.ok) {
        accepted = { pct, edge: r.edge };
        break;
      }
      refusedNear = pct;
    }
    if (accepted === null) return null;
    let bad = refusedNear;
    let good = accepted.pct;
    let goodEdge = accepted.edge;
    for (let iter = 0; iter < 14 && Math.abs(good - bad) > 1e-4; iter++) {
      const mid = roundPct((good + bad) / 2);
      if (mid === good || mid === bad) break;
      const r = verify(withPinAt(index, mid), price);
      if (r.ok) {
        good = mid;
        goodEdge = r.edge;
      } else {
        bad = mid;
      }
    }
    // Snap INTO the accepted side and re-verify; walk a few grid steps when
    // the snapped value refuses (boundary jitter).
    let snapped = roundPct(dir === 1 ? ceilToStep(good) : floorToStep(good));
    for (let walk = 0; walk < 3; walk++) {
      if (!(snapped > 0)) break;
      if (dir === 1 ? snapped > Math.max(farPct, good) + 1e-9 : false) break;
      if (Math.abs(snapped - fromPct) < 1e-9) break;
      const r = verify(withPinAt(index, snapped), price);
      if (r.ok) return { toPct: snapped, edge: r.edge };
      snapped = roundPct(snapped + dir * pinStepPct(Math.max(snapped, 1e-6)));
    }
    // Off-grid fallback: the bisected boundary value itself verified.
    return { toPct: roundPct(good), edge: goodEdge };
  };

  const remedies: PinRemedy[] = [];
  const adjustedIdx = new Set<number>();
  const edgePct = (e: number): string => (e * 100).toFixed(2);

  // ── RAISE / LOWER per pin (the smallest wins) ─────────────────────────────
  for (const p of pins) {
    const card = input.cards[p.index];
    if (!card || !(card.value > 0)) continue;
    const v = card.value;
    const fromPct = p.share * 100;
    const isWin = v >= price && v <= input.maxWinCap;
    const w = input.currentWeights[p.index];
    const livePct =
      curTotal > 0 && Number.isFinite(w) && (w as number) > 0
        ? ((w as number) / curTotal) * 100
        : null;
    // Raise bound: a WIN pin never inflates past its live odds (never-inflate
    // law); a LOSS pin may absorb the free mass less a sliver the free cards
    // keep. Lower bound: one display step above zero.
    const raiseCap = Math.min(
      100,
      isWin
        ? livePct !== null
          ? Math.min(livePct, fromPct + freeMass * 100)
          : fromPct
        : fromPct + Math.max(0, freeMass * 100 - 0.5),
    );
    const lowerFloor = Math.max(0, Math.min(fromPct, pinStepPct(fromPct)));
    const raise =
      raiseCap > fromPct + 1e-9
        ? searchDirection(p.index, fromPct, raiseCap, 1)
        : null;
    const lower =
      lowerFloor < fromPct - 1e-9
        ? searchDirection(p.index, fromPct, lowerFloor, -1)
        : null;
    const best =
      raise !== null && lower !== null
        ? Math.abs(raise.toPct - fromPct) <= Math.abs(lower.toPct - fromPct)
          ? raise
          : lower
        : (raise ?? lower);
    if (best === null) continue;
    const kind: PinRemedyKind = best.toPct > fromPct ? "raise-pin" : "lower-pin";
    adjustedIdx.add(p.index);
    remedies.push({
      kind,
      cardIndex: p.index,
      cardValue: v,
      fromPct: roundPct(fromPct),
      toPct: best.toPct,
      edge: best.edge,
      humanCopy:
        kind === "raise-pin"
          ? `Raise the pinned ${usd(v)} card from ${pctFmt(fromPct)}% to ${pctFmt(best.toPct)}% — the pins then carry enough EV and the plan verifies at ${usd(price)} (house edge ${edgePct(best.edge)}%, solver-checked).`
          : `Lower the pinned ${usd(v)} card from ${pctFmt(fromPct)}% to ${pctFmt(best.toPct)}% — the pinned EV then fits the budget and the plan verifies at ${usd(price)} (house edge ${edgePct(best.edge)}%, solver-checked).`,
      verified: true,
    });
  }

  // ── UNPIN — only where no verified adjust exists (adjusting preserves the
  //    owner's intent; the full unpin is the stronger cut) ───────────────────
  for (const p of pins) {
    if (adjustedIdx.has(p.index)) continue;
    const card = input.cards[p.index];
    if (!card) continue;
    const rest = pins.filter((q) => q.index !== p.index);
    const r = verify(rest, price);
    if (!r.ok) continue;
    remedies.push({
      kind: "unpin-card",
      cardIndex: p.index,
      cardValue: card.value,
      fromPct: roundPct(p.share * 100),
      edge: r.edge,
      humanCopy: `Unpin the ${usd(card.value)} card (typed ${pctFmt(p.share * 100)}%) and let the solver place it — the remaining pins hold and the plan verifies at ${usd(price)} (house edge ${edgePct(r.edge)}%, solver-checked).`,
      verified: true,
    });
  }

  // ── PRICE-MOVE — nearest in-budget cent that verifies with ALL pins held ──
  if (input.pinPrice !== true) {
    const budget = Math.min(
      Math.max(input.priceBudgetPct ?? 0.1, 0.0001),
      0.6,
    );
    const mults: number[] = [];
    for (const f of [0.25, 0.5, 0.75, 1]) {
      const d = f * budget;
      if (d > 1e-9) mults.push(1 - d, 1 + d);
    }
    mults.sort((a, b) => Math.abs(a - 1) - Math.abs(b - 1));
    for (const mult of mults) {
      const cent = Math.round(price * mult * 100) / 100;
      if (!(cent > 0) || Math.abs(cent - price) < 0.005) continue;
      const r = verify(pins, cent);
      if (!r.ok) continue;
      const delta = ((cent - price) / price) * 100;
      remedies.push({
        kind: "price-move",
        price: cent,
        edge: r.edge,
        humanCopy: `Keep every pin as typed and move the price to ${usd(cent)} (${delta >= 0 ? "+" : "-"}${Math.abs(delta).toFixed(1)}%) — the plan verifies there (house edge ${edgePct(r.edge)}%, solver-checked).`,
        verified: true,
      });
      break;
    }
  }

  // Rank: pin adjusts (smallest change first) → unpins (smallest pin first)
  // → price move. Deterministic tie-break on the card index.
  const classRank: Record<PinRemedyKind, number> = {
    "raise-pin": 0,
    "lower-pin": 0,
    "unpin-card": 1,
    "price-move": 2,
  };
  const deltaOf = (r: PinRemedy): number =>
    r.kind === "price-move"
      ? Math.abs(((r.price ?? price) - price) / price) * 100
      : r.kind === "unpin-card"
        ? (r.fromPct ?? 0)
        : Math.abs((r.toPct ?? 0) - (r.fromPct ?? 0));
  remedies.sort(
    (a, b) =>
      classRank[a.kind] - classRank[b.kind] ||
      deltaOf(a) - deltaOf(b) ||
      (a.cardIndex ?? 0) - (b.cardIndex ?? 0),
  );
  return remedies.slice(0, Math.max(1, input.maxRemedies ?? 4));
}

/**
 * Owner-facing copy for a pins refusal: the shortfall (the engine refusal's
 * authoritative detail when available) + the smallest verified way out — or
 * the honest "the pins interlock" verdict when the remedy search came back
 * empty-handed.
 */
export function pinShortfallHumanCopy(args: {
  price: number;
  targetEdge: number;
  /** The engine refusal's `limit.detail` ($ figures), when available. */
  refusalDetail?: string | null;
  remedies: readonly PinRemedy[];
}): string {
  const head = `The pinned odds can't reach the ${(args.targetEdge * 100).toFixed(2)}% edge target at ${usd(args.price)}.`;
  const detail = args.refusalDetail?.trim().replace(/\s+/g, " ") ?? "";
  const why =
    detail.length > 0 ? ` ${detail}${/[.!?]$/.test(detail) ? "" : "."}` : "";
  if (args.remedies.length === 0) {
    return `${head}${why} No single-pin change fixes this — every raise, lower, unpin and in-budget price move was tried against the solver. The pins interlock: unpin two or more cards, or rebuild the pin set.`;
  }
  const first = args.remedies[0]!;
  const more =
    args.remedies.length > 1
      ? ` (${args.remedies.length - 1} more verified option${args.remedies.length > 2 ? "s" : ""} available.)`
      : "";
  return `${head}${why} Smallest verified fix: ${first.humanCopy}${more}`;
}
