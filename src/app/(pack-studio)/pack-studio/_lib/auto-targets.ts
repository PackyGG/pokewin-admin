/**
 * PURE, dependency-free auto-target helpers for Pack-Studio re-tuning.
 *
 * Side-effect-free and DB-free: imports ONLY the dep-free math module
 * (`insights/edge-calc/math`, for the house edge knob). This is split out of
 * `risk-config.ts` — which is DB-coupled (`getAdminSetting` → `adminDb`) — so the
 * no-DB risk-check harness (`packs/__checks__/risk.ts`) can import and pin these
 * exact functions, and the doctor / plan-all reads can derive a pack's targets
 * without re-reading `admin_settings` per pack. The caller resolves the config
 * ONCE (via `readMaxWinCap()` + `readMaxMultCeiling()` in risk-config) and passes
 * it in here. `risk-config.ts` re-exports everything below so existing import
 * sites stay stable.
 */

import { TARGET_HOUSE_EDGE } from "@/app/(admin)/insights/edge-calc/math";

/** Target house edge a compliant cash pack must hit (10.99%). */
export const TARGET_PACK_EDGE = TARGET_HOUSE_EDGE;

/**
 * Default ceiling on a single card's payout expressed as a MULTIPLE of the pack
 * price, used when `pack_system_config.maxMultCeiling` is unset. A 100× cap on a
 * $5 pack auto-caps the jackpot at $500 — the per-pack auto-cap is the LESSER of
 * this multiplier bound and the absolute global cap. See {@link autoMaxWinCap}.
 */
export const DEFAULT_MAX_MULT_CEILING = 100;

/**
 * Default target win-rate for an auto-retune: the probability mass on win+grail
 * cards (value ≥ price) the shaper aims for when the owner doesn't override it.
 * 20% wins matches the design baseline used across the risk checks/sweep.
 */
export const DEFAULT_TARGET_WIN_RATE = 0.2;

/**
 * Default minimum near-miss probability mass for an auto-retune (cards in
 * `[0.5·price, price)`). 10% mirrors `shapeWeights`' own `nearMissMin` default,
 * keeping the auto-targets consistent with the solver's built-in fallback.
 */
export const DEFAULT_NEAR_MISS_MIN = 0.1;

/** Resolved pack-system config the pure auto-target helpers operate on. */
export type ResolvedAutoTargetCfg = {
  /** Absolute single-win cap in USD (from `readMaxWinCap`). */
  globalCap: number;
  /** Single-win cap as a multiple of price (from `readMaxMultCeiling`). */
  maxMultCeiling: number;
};

/**
 * The auto jackpot cap (USD) for a pack at `price`: the LESSER of the absolute
 * global cap and the price-relative ceiling (`price · maxMultCeiling`), but
 * never below the ticket price itself — a cap below price would drop every
 * win/grail card and leave the pool unshapeable. Pure + sync.
 *
 *   cheap pack  → bounded by the multiplier   (price · maxMultCeiling < globalCap)
 *   premium pack→ bounded by the global cap    (globalCap < price · maxMultCeiling)
 */
export function autoMaxWinCap(
  price: number,
  cfg: ResolvedAutoTargetCfg,
): number {
  const multBound = price * cfg.maxMultCeiling;
  const cap = Math.min(cfg.globalCap, multBound);
  // Never cap below the ticket price (would strip all win/grail cards).
  return Math.max(cap, price);
}

/** The full auto-retune target set for a pack at `price`. */
export type AutoRetuneTargets = {
  targetEdge: number;
  targetWinRate: number;
  nearMissMin: number;
  maxWinCap: number;
};

/**
 * The default retune targets for a pack at `price`: the house edge target, the
 * default win-rate + near-miss floors, and the auto-resolved jackpot cap. Pure +
 * sync — the caller resolves `cfg` once (via `readMaxWinCap` +
 * `readMaxMultCeiling`) and reuses it across packs.
 */
export function autoRetuneTargets(
  price: number,
  cfg: ResolvedAutoTargetCfg,
): AutoRetuneTargets {
  return {
    targetEdge: TARGET_PACK_EDGE,
    targetWinRate: DEFAULT_TARGET_WIN_RATE,
    nearMissMin: DEFAULT_NEAR_MISS_MIN,
    maxWinCap: autoMaxWinCap(price, cfg),
  };
}
