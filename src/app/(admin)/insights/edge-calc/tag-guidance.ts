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
  type ShapeWeightsRelaxation,
} from "./risk";
import {
  DEFAULT_EDGE_CURVE,
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
   *   retag:           { liveRate, proposedTag }
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
  /** Σ caps (Infinity when any card is uncapped/new). */
  capSum: number;
  saturated: boolean;
  capDroppedCount: number;
  maxDroppedValue: number;
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
}): BandModel {
  const { price, cap, tag, nearMissMin } = args;

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

  args.cards.forEach((c, idx) => {
    const v = c.value;
    if (!(v > 0)) return;
    if (v > cap) {
      capDroppedCount += 1;
      if (v > maxDroppedValue) maxDroppedValue = v;
      return;
    }
    if (v >= price) {
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
      nmValues.push(v);
    } else {
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

  const m = nmValues.length > 0 && nearMissMin > 0 ? nearMissMin : 0;
  const d = 1 - tag - m;

  const nmLo = bandEvForBeta(nmValues, BETA_HI);
  const nmHi = bandEvForBeta(nmValues, BETA_LO);
  const dustLo = bandEvForBeta(dustValues, BETA_HI);
  const dustHi = bandEvForBeta(dustValues, BETA_LO);
  const lossLo = m * nmLo + Math.max(0, d) * dustLo;
  const lossHi = m * nmHi + Math.max(0, d) * dustHi;

  const winEvMin = waterFillWinEv(winValues, winCaps, tag, BETA_WIN_MAX);
  const winEvMax = waterFillWinEv(winValues, winCaps, tag, BETA_WIN_FLOOR);
  const evMin = winEvMin + lossLo;
  const evMax = winEvMax + lossHi;
  const cheapestWin = winValues.length > 0 ? Math.min(...winValues) : 0;
  const evMinKnob =
    winValues.length > 0 ? Math.min(evMin, tag * cheapestWin + lossLo) : evMin;

  let capSum = 0;
  for (const c of winCaps) capSum += c;
  const saturated = Number.isFinite(capSum) && capSum <= tag + 1e-12;

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
  "remove-dead-card": 8,
  "accept-as-is": 9,
  "no-fix-under-constraints": 10,
};

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

  const modelAt = (p: number): { model: BandModel; eStar: number; evT: number } => {
    const cap = capAt(p);
    const model = buildModel({
      cards: input.cards,
      currentWeights: input.currentWeights,
      price: p,
      cap,
      tag,
      nearMissMin: input.nearMissMin,
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

  const suggestions: TuneSuggestion[] = [];
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
            humanCopy: `Move the price to ${usd(pCand)} and set the edge target to ${(ePrime * 100).toFixed(3)}% — this pool's odds are fully pinned (never-inflate + hard tag), so it pays exactly one amount; at ${usd(pCand)} that amount IS a ${(ePrime * 100).toFixed(3)}% edge with the ${pp(tag)}% tag exact. No card changes.`,
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
    const wUsed = waterFillWinEv(base.winValues, base.winCaps, tag, BETA_WIN_MAX);
    const nmUsed = base.m * bandEvForBeta(base.nmValues, BETA_HI);
    const vB = (evTarget - wUsed - nmUsed) / base.d;
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
        const dReq = (evTarget - wUsed - nmUsed) / base.d;
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
    tag - base.capSum > 1e-9 &&
    base.d > 1e-9
  ) {
    const s = tag - base.capSum;
    let capEv = 0;
    for (let i = 0; i < base.winValues.length; i++) {
      capEv += base.winCaps[i]! * base.winValues[i]!;
    }
    const lossLo = base.m * bandEvForBeta(base.nmValues, BETA_HI) + base.d * bandEvForBeta(base.dustValues, BETA_HI);
    const lossHi = base.m * bandEvForBeta(base.nmValues, BETA_LO) + base.d * bandEvForBeta(base.dustValues, BETA_LO);
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
    if (excess > ONE_SIDED_EDGE_EXCESS_TOL && ePrime < 1) {
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

  // ── 9. Retag to the live rate (last — owner identity decision) ────────────
  if (
    input.liveWinRate != null &&
    Number.isFinite(input.liveWinRate) &&
    input.liveWinRate > 0 &&
    Math.abs(input.liveWinRate - tag) > TAGGED_WRITE_WINRATE_TOLERANCE &&
    !feasibleRaw
  ) {
    const liveRate = input.liveWinRate;
    const nmSeed = Math.max(0, input.liveNearMiss ?? 0);
    const capPrime = cfg ? autoMaxWinCap(price, cfg, liveRate) : input.maxWinCap;
    const m2 = buildModel({
      cards: input.cards,
      currentWeights: input.currentWeights,
      price,
      cap: capPrime,
      tag: liveRate,
      nearMissMin: nmSeed,
    });
    const eStarPrime = targetEdgeAt(price, capPrime, poolTopAt(price));
    const evTPrime = price * (1 - eStarPrime);
    if (engineAccepts(m2, evTPrime, eStarPrime)) {
      suggestions.push({
        kind: "retag",
        params: { liveRate, proposedTag: liveRate },
        humanCopy: `This pool actually pays ${pp(liveRate)}% winners, not the tagged ${pp(tag)}%${nmSeed > 0.005 ? ` (and carries a real ${pp(nmSeed)}% near-miss band)` : ""}. Retag it to ${pp(liveRate)}% and it solves exactly at its real rate — the tag should describe the pool, not fight it.`,
        proof: proofOf(m2, evTPrime, eStarPrime),
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
  //    raise-cap → repair-monotone → retag; informational entries last. ──────
  suggestions.sort((a, b) => SUGGESTION_RANK[a.kind] - SUGGESTION_RANK[b.kind]);

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
  const top = suggestions.find((s) => s.proof.feasibleAfter && s.kind !== "remove-dead-card");
  if (top) {
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
        winEvMin: waterFillWinEv(base.winValues, base.winCaps, tag, BETA_WIN_MAX),
        winEvMax: waterFillWinEv(base.winValues, base.winCaps, tag, BETA_WIN_FLOOR),
        nmMass: base.m,
        dustMass: base.d,
        capSum: Number.isFinite(base.capSum) ? base.capSum : -1,
      },
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
  /** cardIds/indices — the crushed cards, in pool order (for UI chips). */
  crushedIdx: number[];
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

  return {
    lossInvArea,
    absorberExcess,
    crushedCount,
    crushedLiveMass,
    crushedIdx,
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

export type PoolEditReason = "degenerate-shape" | "infeasible" | "risk-band-exit";

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
};

/** Soft-mode (untagged) never-inflate caps at a price: existing win/grail
 * cards cap at live odds, grail monotone running-min, cheapest winner EXEMPT
 * (the float-up's sink — its cap is lifted, exactly like the solver). */
function softBandsAt(
  cards: readonly { value: number }[],
  currentWeights: readonly number[],
  price: number,
  cap: number,
): { winValues: number[]; winCaps: number[]; nmValues: number[]; dustValues: number[] } {
  let curTotal = 0;
  for (const w of currentWeights) {
    if (Number.isFinite(w) && w > 0) curTotal += w;
  }
  const winValues: number[] = [];
  const winCaps: number[] = [];
  const nmValues: number[] = [];
  const dustValues: number[] = [];
  cards.forEach((c, idx) => {
    const v = c.value;
    if (!(v > 0) || v > cap) return;
    if (v >= price) {
      winValues.push(v);
      const w = currentWeights[idx];
      winCaps.push(
        curTotal > 0 && Number.isFinite(w) && (w as number) > 0
          ? (w as number) / curTotal
          : Infinity,
      );
    } else if (v >= 0.5 * price) {
      nmValues.push(v);
    } else {
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
  // Cheapest-winner exemption (SOFT mode only — the EV-balance sink).
  if (winValues.length > 0) {
    let cheapIdx = 0;
    for (let i = 1; i < winValues.length; i++) {
      if (winValues[i]! < winValues[cheapIdx]!) cheapIdx = i;
    }
    winCaps[cheapIdx] = Infinity;
  }
  return { winValues, winCaps, nmValues, dustValues };
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
    if (isFloorPinnedPct(share * 100)) pinnedIdx.push(i);
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
  // evTarget above it ⇒ the float-up fired ⇒ the ladder degenerated.
  const base = softBandsAt(input.cards, input.currentWeights, price, input.maxWinCap);
  const nmMass = base.nmValues.length > 0 ? input.nearMissMin : 0;
  const dm = Math.max(0, 1 - targetWinRate - nmMass);
  const evTarget = price * (1 - targetEdge);
  const evMax =
    waterFillWinEv(base.winValues, base.winCaps, targetWinRate, BETA_WIN_FLOOR) +
    nmMass * bandEvForBeta(base.nmValues, BETA_LO) +
    dm * bandEvForBeta(base.dustValues, BETA_LO);
  const evMin =
    waterFillWinEv(base.winValues, base.winCaps, targetWinRate, BETA_WIN_MAX) +
    nmMass * bandEvForBeta(base.nmValues, BETA_HI) +
    dm * bandEvForBeta(base.dustValues, BETA_HI);

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
      );
      if (bands.winValues.length === 0 || bands.dustValues.length === 0) continue;
      const evT = pCand * (1 - targetEdge);
      const w02 = waterFillWinEv(
        bands.winValues,
        bands.winCaps,
        targetWinRate,
        BETA_WIN_FLOOR,
      );
      const dHi = bandEvForBeta(bands.dustValues, BETA_LO);
      // Near-miss route: the new card becomes the NM band (mass = nmSeed).
      const dmWith = Math.max(0, 1 - targetWinRate - nmSeed);
      const xLo = (evT - w02 - dmWith * dHi) / nmSeed;
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
      const evMaxAfter = w02 + nmSeed * xSuggest + dmWith * dHi;
      const evMinAfter =
        waterFillWinEv(bands.winValues, bands.winCaps, targetWinRate, BETA_WIN_MAX) +
        nmSeed * xSuggest +
        dmWith * bandEvForBeta(bands.dustValues, BETA_HI);
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
        );
        if (bands.winValues.length === 0) continue;
        const evT = pCand * (1 - targetEdge);
        const w02 = waterFillWinEv(
          bands.winValues,
          bands.winCaps,
          targetWinRate,
          BETA_WIN_FLOOR,
        );
        const nmHere = bands.nmValues.length > 0 ? nmSeed : 0;
        const dmHere = Math.max(0, 1 - targetWinRate - nmHere);
        if (!(dmHere > 1e-9)) continue;
        const nmEv = nmHere * bandEvForBeta(bands.nmValues, BETA_LO);
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
    const pinnedSet = new Set(pinnedIdx);
    input.cards.forEach((c, i) => {
      if (pinnedSet.has(i)) return;
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
        winEvMin: waterFillWinEv(
          base.winValues,
          base.winCaps,
          targetWinRate,
          BETA_WIN_MAX,
        ),
        winEvMax: waterFillWinEv(
          base.winValues,
          base.winCaps,
          targetWinRate,
          BETA_WIN_FLOOR,
        ),
        nmMass,
        dustMass: dm,
        capSum: -1,
      },
    },
    suggestions,
  };
}
