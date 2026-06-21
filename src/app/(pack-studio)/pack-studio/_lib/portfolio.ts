/**
 * PURE, dependency-free SYSTEM-LEVEL portfolio risk-balancer for Pack-Studio.
 *
 * The per-pack auto-retune (`autoRetuneTargets` in `./auto-targets`) targets each
 * pack INDEPENDENTLY: a flat house-edge target, a default win-rate, and an auto
 * jackpot cap. That keeps every pack money-correct but says NOTHING about the
 * SHAPE of the whole catalog — how many packs are "spicy" (high-tier / high-CV),
 * how much total jackpot exposure the house carries, whether the catalog drifts
 * into all-swing or all-grind.
 *
 * This module adds the missing layer. It (a) profiles a set of scored packs into
 * a handful of catalog-level metrics, (b) defines + reads a system-target config,
 * and (c) DERIVES per-pack targets (same shape `autoRetuneTargets` returns) that
 * pull the WHOLE catalog back inside the system bounds — tightening only the
 * worst offenders, leaving compliant packs on the default.
 *
 * Pure + deterministic where possible: the profile + the derive heuristic are
 * dep-free (import only the dep-free risk/auto-target modules) so the same code
 * runs client-side in the builder/retune preview AND server-side in the plan-all
 * read. Only `readPortfolioSystemConfig` touches the DB (via `risk-config`'s
 * `readPackSystemConfig`), mirroring how `readMaxWinCap` is split out.
 *
 * v1 is a TRANSPARENT heuristic — every tightening step is explained in the
 * returned `systemPlan` so the UI can show the owner exactly which packs were
 * pulled in and why. No magic constants without a documented rationale.
 */

import type { PackRisk, RiskTier } from "@/app/(admin)/insights/edge-calc/risk";
import {
  autoRetuneTargets,
  DEFAULT_TARGET_WIN_RATE,
  DEFAULT_NEAR_MISS_MIN,
  TARGET_PACK_EDGE,
  type AutoRetuneTargets,
  type ResolvedAutoTargetCfg,
} from "./auto-targets";

// ─── Catalog profile ───────────────────────────────────────────────────

/** A scored pack reduced to the two facts the portfolio math needs. */
export type PricedPackRisk = {
  /** Sticker price (USD). */
  price: number;
  /** The pack's computed risk record. */
  risk: PackRisk;
};

/** Catalog-level risk profile — the SHAPE of the whole pack portfolio. */
export type PortfolioProfile = {
  /** Number of packs the profile was computed over. */
  packCount: number;
  /** Count of packs in each volatility tier (T1..T5). */
  tierDistribution: Record<RiskTier, number>;
  /** Σ per-pack maxWin (USD) — total single-card jackpot exposure across packs. */
  totalMaxWinExposure: number;
  /** Price-weighted mean CV across the catalog (0 when no priced mass). */
  aggregateCv: number;
  /** Count of packs whose top card exceeds the per-pack auto jackpot cap. */
  countOverCap: number;
  /** Count of packs whose edge is below the house target. */
  countBelowTarget: number;
  /** Share (0..1) of packs sitting in the spicy tiers T4+T5. */
  spicyShare: number;
};

const TIERS: readonly RiskTier[] = ["T1", "T2", "T3", "T4", "T5"] as const;

function emptyTierDistribution(): Record<RiskTier, number> {
  return { T1: 0, T2: 0, T3: 0, T4: 0, T5: 0 };
}

/** Is a tier one of the "spicy" high-volatility buckets (T4 / T5)? */
export function isSpicyTier(tier: RiskTier): boolean {
  return tier === "T4" || tier === "T5";
}

/**
 * Profile a set of scored packs into the catalog-level risk metrics. Pure + sync.
 *
 *   tierDistribution    — count per CV tier.
 *   totalMaxWinExposure — Σ maxWin (the house's total jackpot liability surface).
 *   aggregateCv         — price-weighted mean CV (a $50 pack's swing weighs more
 *                         than a $1 pack's; weight = price, so the headline CV
 *                         reflects where the money sits). Falls back to a plain
 *                         mean when total price is 0.
 *   countOverCap        — packs whose maxWin already exceeds the auto cap.
 *   countBelowTarget    — packs whose edge < house target.
 *   spicyShare          — share of packs in T4+T5.
 *
 * `cfg` is the resolved auto-target config (globalCap + maxMultCeiling) so
 * `countOverCap` uses the SAME per-pack cap the retune would enforce.
 */
export function computePortfolioProfile(
  packRisks: PricedPackRisk[],
  cfg: ResolvedAutoTargetCfg,
): PortfolioProfile {
  const tierDistribution = emptyTierDistribution();
  let totalMaxWinExposure = 0;
  let countOverCap = 0;
  let countBelowTarget = 0;
  let spicyCount = 0;

  // Price-weighted CV accumulators.
  let cvPriceWeightedSum = 0;
  let priceSum = 0;
  // Plain-mean fallback accumulators (used only when priceSum === 0).
  let cvPlainSum = 0;

  for (const { price, risk } of packRisks) {
    tierDistribution[risk.tier] += 1;
    if (Number.isFinite(risk.maxWin) && risk.maxWin > 0) {
      totalMaxWinExposure += risk.maxWin;
    }
    if (isSpicyTier(risk.tier)) spicyCount += 1;

    const autoTargets = autoRetuneTargets(price, cfg);
    if (risk.maxWin > autoTargets.maxWinCap) countOverCap += 1;
    if (risk.edge < TARGET_PACK_EDGE) countBelowTarget += 1;

    const cv = Number.isFinite(risk.cv) && risk.cv > 0 ? risk.cv : 0;
    cvPlainSum += cv;
    if (Number.isFinite(price) && price > 0) {
      cvPriceWeightedSum += cv * price;
      priceSum += price;
    }
  }

  const packCount = packRisks.length;
  const aggregateCv =
    priceSum > 0
      ? cvPriceWeightedSum / priceSum
      : packCount > 0
        ? cvPlainSum / packCount
        : 0;
  const spicyShare = packCount > 0 ? spicyCount / packCount : 0;

  return {
    packCount,
    tierDistribution,
    totalMaxWinExposure,
    aggregateCv,
    countOverCap,
    countBelowTarget,
    spicyShare,
  };
}

// ─── System-target config ──────────────────────────────────────────────

/**
 * The resolved system-target config the portfolio balancer operates on. Read
 * from `admin_settings.pack_system_config` (the SAME blob `readMaxWinCap` reads)
 * with the auto-target config folded in so the derive step has everything it
 * needs in one object.
 */
export type PortfolioSystemConfig = {
  /** Default target win-rate for a compliant pack (mirrors {@link DEFAULT_TARGET_WIN_RATE}). */
  defaultWinRate: number;
  /**
   * Max share (0..1) of packs allowed in the spicy tiers T4+T5. Over this, the
   * balancer tightens the spiciest offenders down. Default {@link DEFAULT_MAX_SPICY_SHARE}.
   */
  maxSpicyShare: number;
  /**
   * Catalog-wide jackpot exposure cap (USD): the balancer keeps Σ per-pack maxWin
   * at or below this. Default = a fraction of reserves R ({@link RESERVE_EXPOSURE_FRACTION}),
   * or {@link DEFAULT_EXPOSURE_CAP_USD} when reserves are unknown.
   */
  exposureCapUsd: number;
  /** The auto-target config (globalCap + maxMultCeiling) the per-pack caps use. */
  autoCfg: ResolvedAutoTargetCfg;
};

/**
 * Default ceiling on the spicy (T4+T5) share of the catalog: at most 20% of packs
 * may sit in the two highest-volatility tiers. Keeps the catalog mostly grind-
 * with-occasional-swing rather than all-swing (which spikes the variance of house
 * P&L and the bankroll the reserves must cover).
 */
export const DEFAULT_MAX_SPICY_SHARE = 0.2;

/**
 * Fraction of reserve capital (R) the catalog's total jackpot exposure may reach
 * when reserves are known. A single open can pay at most Σ-bounded by the per-pack
 * caps; capping the SUM of those caps at a slice of reserves bounds the worst-case
 * simultaneous-jackpot drawdown the bankroll must absorb. 50% is a deliberately
 * conservative starting slice — documented, not magic; the owner can override
 * `exposureCapUsd` directly in the config blob.
 */
export const RESERVE_EXPOSURE_FRACTION = 0.5;

/**
 * Absolute fallback for the catalog jackpot-exposure cap (USD) when reserves are
 * NOT set in the config blob. Sized as a small multiple of the default single-win
 * cap so a handful of capped jackpots fit; the owner should set real `reserves`
 * (or `exposureCapUsd`) for an accurate bound. Documented constant, not magic.
 */
export const DEFAULT_EXPOSURE_CAP_USD = 200_000;

/**
 * The optional system-target fields the config blob MAY carry, layered on top of
 * the existing `PackSystemConfig`. All optional → safe defaults when unset.
 */
export type PortfolioSystemConfigInput = {
  defaultWinRate?: number;
  maxSpicyShare?: number;
  exposureCapUsd?: number;
  reserves?: number;
};

/**
 * Resolve the system-target config from the raw config-blob fields + the auto cfg.
 * Pure + sync (the DB read lives in `readPortfolioSystemConfig`), so it can be
 * unit-pinned without a DB:
 *
 *   defaultWinRate  — explicit, else DEFAULT_TARGET_WIN_RATE (0.20).
 *   maxSpicyShare   — explicit (clamped to (0,1]), else DEFAULT_MAX_SPICY_SHARE.
 *   exposureCapUsd  — explicit positive, else RESERVE_EXPOSURE_FRACTION·reserves
 *                     when reserves is a positive number, else
 *                     DEFAULT_EXPOSURE_CAP_USD.
 */
export function resolvePortfolioSystemConfig(
  input: PortfolioSystemConfigInput | null,
  autoCfg: ResolvedAutoTargetCfg,
): PortfolioSystemConfig {
  const wr = input?.defaultWinRate;
  const defaultWinRate =
    typeof wr === "number" && Number.isFinite(wr) && wr > 0 && wr < 1
      ? wr
      : DEFAULT_TARGET_WIN_RATE;

  const ms = input?.maxSpicyShare;
  const maxSpicyShare =
    typeof ms === "number" && Number.isFinite(ms) && ms > 0 && ms <= 1
      ? ms
      : DEFAULT_MAX_SPICY_SHARE;

  const explicitCap = input?.exposureCapUsd;
  let exposureCapUsd: number;
  if (
    typeof explicitCap === "number" &&
    Number.isFinite(explicitCap) &&
    explicitCap > 0
  ) {
    exposureCapUsd = explicitCap;
  } else if (
    typeof input?.reserves === "number" &&
    Number.isFinite(input.reserves) &&
    input.reserves > 0
  ) {
    exposureCapUsd = input.reserves * RESERVE_EXPOSURE_FRACTION;
  } else {
    exposureCapUsd = DEFAULT_EXPOSURE_CAP_USD;
  }

  return { defaultWinRate, maxSpicyShare, exposureCapUsd, autoCfg };
}

// ─── Per-pack target derivation (the balancer) ──────────────────────────

/** A pack handed to the balancer: identity + price + current scored risk. */
export type PortfolioPackInput = {
  packId: string;
  price: number;
  /**
   * The pack NAME — threaded so the balancer's per-pack default targets are
   * TAG-AWARE: a pack whose name starts with `X%` targets that hit-rate (see
   * `parsePackHitRate`). Optional so legacy callers compile; omitted ⇒ untagged.
   */
  name?: string;
  /** Pool cards (values only — the same shape `shapeWeights` consumes). */
  cards: { value: number }[];
  /** The pack's risk AS IT IS NOW. */
  currentRisk: PackRisk;
};

/**
 * Per-pack target set the balancer emits — the SAME shape `autoRetuneTargets`
 * returns plus an optional `floorRatioMin` (unused in v1 but part of the
 * shapeWeights target contract, kept so the caller can pass the whole record
 * straight through). A pack left at the default carries the plain auto-targets.
 */
export type PortfolioPackTargets = AutoRetuneTargets & {
  floorRatioMin?: number;
};

/** Why a single pack was tightened (one entry per tightened pack). */
export type PortfolioTighteningStep = {
  packId: string;
  /** CV·maxWin contribution that ranked it (higher = tightened earlier). */
  contribution: number;
  /** The default auto win-rate before tightening. */
  winRateBefore: number;
  /** The nudged-up win-rate after tightening. */
  winRateAfter: number;
  /** The default auto cap before tightening. */
  maxWinCapBefore: number;
  /** The tightened cap after tightening. */
  maxWinCapAfter: number;
  /** Human-readable reason (which system bound it was pulled in for). */
  reason: string;
};

/** Before/after profile + the tightening log — the UI's "explain it" payload. */
export type PortfolioSystemPlan = {
  cfg: PortfolioSystemConfig;
  /** Catalog profile BEFORE any tightening (every pack on its auto-target). */
  before: PortfolioProfile;
  /**
   * Catalog profile the balancer ESTIMATES after tightening, using each
   * tightened pack's projected tier. This is a heuristic projection (the real
   * post-shape risk is only known once `shapeWeights` runs); the UI should treat
   * it as the balancer's intent, with the actual shaped risk as the source of
   * truth once applied.
   */
  projectedAfter: PortfolioProfile;
  /** Which packs were tightened + why, tightened-first order. */
  tightened: PortfolioTighteningStep[];
  /** True when the catalog was already within all system bounds (no tightening). */
  withinBounds: boolean;
};

/** The balancer's full output: per-pack targets keyed by packId + the plan. */
export type DerivePortfolioTargetsResult = {
  /** Per-pack system targets, keyed by packId (every input pack present). */
  targetsByPack: Map<string, PortfolioPackTargets>;
  systemPlan: PortfolioSystemPlan;
};

/**
 * How many win-rate "nudge" steps the balancer may apply to one pack, and the
 * size of each step. Raising win-rate concentrates probability on the cheaper
 * win cards → lowers payout variance → lowers CV → lowers tier → less spicy.
 * Capped so a tightened pack never approaches an all-win (no-house-edge) shape.
 */
export const WIN_RATE_NUDGE_STEP = 0.05;
export const MAX_WIN_RATE_NUDGES = 3;

/**
 * Hard ceiling on a tightened pack's win-rate. Win-rate + the near-miss floor
 * must leave dust mass for the house edge (see `shapeWeights`' feasibility gate),
 * so the balancer never pushes win-rate past this — keeping a feasible,
 * house-edge-bearing shape.
 */
export const MAX_TIGHTENED_WIN_RATE = 0.4;

/**
 * The jackpot-cap multiple a tightened pack's cap is pulled toward: cap the top
 * card at this × price. A lower jackpot ceiling both reduces single-card variance
 * (lower CV) AND directly reduces the pack's contribution to total exposure.
 * 25× is a deliberately tighter bound than the default 100× multiplier ceiling —
 * documented, not magic.
 */
export const TIGHTENED_MAX_MULT = 25;

/**
 * The per-pack "spiciness contribution" used to rank offenders: CV × maxWin. A
 * pack scores high when it is BOTH volatile (high CV → high tier) AND carries a
 * large jackpot (high maxWin → high exposure) — exactly the packs whose
 * tightening most efficiently pulls BOTH system metrics down at once. Pure.
 */
export function spicinessContribution(risk: PackRisk): number {
  const cv = Number.isFinite(risk.cv) && risk.cv > 0 ? risk.cv : 0;
  const maxWin = Number.isFinite(risk.maxWin) && risk.maxWin > 0 ? risk.maxWin : 0;
  return cv * maxWin;
}

/**
 * Derive per-pack targets that pull the WHOLE catalog inside the system bounds.
 *
 * v1 transparent heuristic:
 *   1. Start EVERY pack on its plain `autoRetuneTargets(price)` — same as today.
 *   2. Profile the catalog at those defaults.
 *   3. If spicyShare ≤ maxSpicyShare AND totalMaxWinExposure ≤ exposureCapUsd →
 *      already within bounds; return the defaults unchanged (no tightening).
 *   4. Otherwise rank the offenders by `spicinessContribution` (CV·maxWin) DESC
 *      and tighten them one at a time — lowering maxWinCap toward TIGHTENED_MAX_MULT
 *      × price and nudging targetWinRate UP (in WIN_RATE_NUDGE_STEP steps, capped)
 *      — until BOTH metrics are within target or we run out of spicy packs.
 *
 * Tightening a pack lowers its projected tier (higher win-rate ⇒ lower CV) and its
 * exposure (lower cap ⇒ lower maxWin), so the projected profile is recomputed each
 * step from the projected per-pack risk. Compliant packs are never touched.
 *
 * PURE: the projection uses a documented tier-step model (a tightened spicy pack
 * is projected one tier down per applied nudge, floored at T3) rather than re-
 * running `shapeWeights` — the real post-shape risk is computed downstream when
 * the plan is actually shaped. The returned `systemPlan.projectedAfter` is the
 * balancer's INTENT; the shaped risk is the source of truth once applied.
 */
export function derivePortfolioTargets(
  packs: PortfolioPackInput[],
  cfg: PortfolioSystemConfig,
): DerivePortfolioTargetsResult {
  // 1. Default targets for every pack — TAG-AWARE: a pack whose name starts with
  //    `X%` defaults to that hit-rate as its win-rate (else DEFAULT_TARGET_WIN_RATE).
  const targetsByPack = new Map<string, PortfolioPackTargets>();
  for (const p of packs) {
    targetsByPack.set(p.packId, autoRetuneTargets(p.price, cfg.autoCfg, p.name));
  }

  // 2. Profile at defaults.
  const before = computePortfolioProfile(
    packs.map((p) => ({ price: p.price, risk: p.currentRisk })),
    cfg.autoCfg,
  );

  const overSpicy = before.spicyShare > cfg.maxSpicyShare;
  const overExposure = before.totalMaxWinExposure > cfg.exposureCapUsd;

  // 3. Already within bounds → defaults unchanged.
  if (!overSpicy && !overExposure) {
    return {
      targetsByPack,
      systemPlan: {
        cfg,
        before,
        projectedAfter: before,
        tightened: [],
        withinBounds: true,
      },
    };
  }

  // 4. Rank offenders by CV·maxWin contribution, descending.
  const ranked = [...packs].sort(
    (a, b) => spicinessContribution(b.currentRisk) - spicinessContribution(a.currentRisk),
  );

  // Mutable projection state: per-pack projected tier + projected maxWin. We
  // recompute the catalog metrics from these as we tighten.
  type Projected = { price: number; tier: RiskTier; maxWin: number; cv: number };
  const projected = new Map<string, Projected>();
  for (const p of packs) {
    projected.set(p.packId, {
      price: p.price,
      tier: p.currentRisk.tier,
      maxWin: Number.isFinite(p.currentRisk.maxWin) ? p.currentRisk.maxWin : 0,
      cv: Number.isFinite(p.currentRisk.cv) ? p.currentRisk.cv : 0,
    });
  }

  const tierIndex = (t: RiskTier): number => TIERS.indexOf(t);
  const tierAt = (i: number): RiskTier => TIERS[Math.max(0, Math.min(TIERS.length - 1, i))]!;

  function projectedProfile(): { spicyShare: number; totalMaxWinExposure: number } {
    let spicy = 0;
    let exposure = 0;
    for (const pr of projected.values()) {
      if (isSpicyTier(pr.tier)) spicy += 1;
      if (pr.maxWin > 0) exposure += pr.maxWin;
    }
    const count = projected.size;
    return {
      spicyShare: count > 0 ? spicy / count : 0,
      totalMaxWinExposure: exposure,
    };
  }

  const tightened: PortfolioTighteningStep[] = [];

  for (const p of ranked) {
    const cur = projectedProfile();
    const stillOverSpicy = cur.spicyShare > cfg.maxSpicyShare;
    const stillOverExposure = cur.totalMaxWinExposure > cfg.exposureCapUsd;
    if (!stillOverSpicy && !stillOverExposure) break; // bounds met → stop.

    const proj = projected.get(p.packId)!;

    // Only tighten a pack that actually contributes to a violated bound:
    //   • over-spicy  → tighten if this pack is itself spicy (T4/T5).
    //   • over-exposure → tighten if this pack carries jackpot exposure.
    const contributesSpicy = stillOverSpicy && isSpicyTier(proj.tier);
    const contributesExposure = stillOverExposure && proj.maxWin > 0;
    if (!contributesSpicy && !contributesExposure) continue;

    const baseTargets = targetsByPack.get(p.packId)!;
    const winRateBefore = baseTargets.targetWinRate;
    const maxWinCapBefore = baseTargets.maxWinCap;

    // Lower the jackpot cap toward TIGHTENED_MAX_MULT × price (never above the
    // pack's existing default cap, never below the ticket price — a cap below
    // price would strip every win card, mirroring `autoMaxWinCap`'s floor).
    const tightenedCap = Math.max(
      p.price,
      Math.min(maxWinCapBefore, p.price * TIGHTENED_MAX_MULT),
    );

    // Nudge win-rate up: each step lowers projected CV/tier. Number of steps
    // scales with how spicy the pack is (T5 gets the full budget, T4 fewer),
    // capped by MAX_WIN_RATE_NUDGES and the hard win-rate ceiling.
    const spicyDepth = isSpicyTier(proj.tier)
      ? tierIndex(proj.tier) - tierIndex("T3") // T4→1, T5→2
      : 1;
    const nudges = Math.min(MAX_WIN_RATE_NUDGES, Math.max(1, spicyDepth));
    const tightenedWinRate = Math.min(
      MAX_TIGHTENED_WIN_RATE,
      winRateBefore + nudges * WIN_RATE_NUDGE_STEP,
    );

    // Persist the tightened targets.
    targetsByPack.set(p.packId, {
      ...baseTargets,
      targetWinRate: tightenedWinRate,
      maxWinCap: tightenedCap,
    });

    // Project the effect: each applied nudge drops the projected tier one step
    // (higher win-rate ⇒ lower variance ⇒ lower CV ⇒ lower tier), floored at T3
    // (we never project a tightened pack below the mid tier — that would over-
    // claim the heuristic's certainty). The projected maxWin drops to the cap.
    const newTierIdx = Math.max(tierIndex("T3"), tierIndex(proj.tier) - nudges);
    proj.tier = tierAt(newTierIdx);
    proj.maxWin = Math.min(proj.maxWin > 0 ? proj.maxWin : tightenedCap, tightenedCap);

    const reasons: string[] = [];
    if (contributesSpicy) reasons.push("spicy-tier share over cap");
    if (contributesExposure) reasons.push("catalog jackpot exposure over cap");

    tightened.push({
      packId: p.packId,
      contribution: spicinessContribution(p.currentRisk),
      winRateBefore,
      winRateAfter: tightenedWinRate,
      maxWinCapBefore,
      maxWinCapAfter: tightenedCap,
      reason: reasons.join("; "),
    });
  }

  // Recompute the full projected profile for the UI (tier distribution + the
  // derived metrics) from the projected per-pack state.
  const projectedAfter = computePortfolioProfile(
    packs.map((p) => {
      const pr = projected.get(p.packId)!;
      return {
        price: p.price,
        risk: {
          ...p.currentRisk,
          tier: pr.tier,
          maxWin: pr.maxWin,
        },
      };
    }),
    cfg.autoCfg,
  );

  const finalProfile = projectedProfile();
  const withinBounds =
    finalProfile.spicyShare <= cfg.maxSpicyShare &&
    finalProfile.totalMaxWinExposure <= cfg.exposureCapUsd;

  return {
    targetsByPack,
    systemPlan: {
      cfg,
      before,
      projectedAfter,
      tightened,
      withinBounds,
    },
  };
}

// Re-export the defaults the caller may want to surface.
export { DEFAULT_TARGET_WIN_RATE, DEFAULT_NEAR_MISS_MIN, TARGET_PACK_EDGE };
