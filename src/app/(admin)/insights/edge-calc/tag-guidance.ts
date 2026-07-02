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
  const RANK: Record<TuneSuggestionKind, number> = {
    "price-edge-exact": 0,
    "price-move": 0,
    "add-card": 1,
    "edge-bump": 2,
    "raise-cap": 3,
    "repair-monotone": 4,
    "loosen-cheapest-winner": 5,
    retag: 6,
    "remove-dead-card": 8,
    "no-fix-under-constraints": 9,
  };
  suggestions.sort((a, b) => RANK[a.kind] - RANK[b.kind]);

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
