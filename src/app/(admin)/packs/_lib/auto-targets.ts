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

// ─── Per-pack edge curve (floor + risk premium) ─────────────────────────
//
// The target edge is NO LONGER a flat 10.99% for every pack. Instead each pack
// targets `EDGE_FLOOR + a gentle risk premium` — the premium rises with the
// pack's HOUSE RISK (primarily its max-win $ exposure, secondarily its price).
// The curve is ONE-DIRECTIONAL: it only ever pushes a pack's target UP from the
// floor, never below it. A calm/cheap pack sits exactly at the floor; the
// spiciest packs the house carries (high price + a five-figure top card) target
// a little above it, hard-capped well short of anything punitive.
//
// WHY (house economics): a higher max-win $ jackpot and a higher ticket price
// both raise the variance + worst-case drawdown the bankroll must absorb on that
// pack. Charging a slightly fatter edge on exactly those packs is a risk premium
// — it funds the extra reserve those packs tie up — while the bulk of the
// catalog (cheap, calm packs) stays at the headline 10.99%.

/**
 * Hard floor on a pack's target edge (10.99%). NO pack ever targets below this
 * — the curve is one-directional (premium ≥ 0), so the floor is also the target
 * for any cheap/calm pack. Equals {@link TARGET_PACK_EDGE} by construction.
 */
export const DEFAULT_EDGE_FLOOR = TARGET_PACK_EDGE;

/**
 * Hard ceiling on a pack's target edge (11.50%). A safety cap that almost
 * nothing reaches — only a hypothetical extreme (a pack far pricier / far more
 * jackpot-heavy than anything in the live catalog) approaches it. The real
 * top-of-catalog packs (e.g. a $766 / $24k-top pack) land around 11.10%, well
 * under this cap.
 */
export const DEFAULT_EDGE_CEILING = 0.115;

/**
 * Curve coefficients + log-scale anchors driving the risk premium. CALIBRATED
 * against the live official-pack catalog (read-only prod probe of active
 * `pack_type='official'` packs: their price + the max obtainable card value),
 * so the catalog lands as the owner specified:
 *
 *   • a cheap / calm pack (≤ ~$2, low max-win)        → the floor (10.99%)
 *   • a mid pack (~$10–20, calm jackpot)              → ~11.00%
 *   • a top-of-catalog pack ($766 price / ~$24k top)  → ~11.10%  (the target)
 *   • only a hypothetical extreme                     → approaches 11.20%+,
 *                                                       hard-capped at 11.50%
 *
 * The premium is the sum of two log-scaled drivers, each normalised to 0 at a
 * "calm baseline" and to ~1.0 at the top-of-catalog reference:
 *
 *   premium = maxWinCoef · logNorm(maxWin, maxWinBase, maxWinRef)
 *           + priceCoef  · logNorm(price,  priceBase,  priceRef)
 *
 * `logNorm(x, base, ref) = clamp₀(ln(x/base) / ln(ref/base))` — 0 at/below the
 * base, rising log-scaled to 1.0 at the reference (and beyond, so an extreme can
 * push past the references toward the ceiling). Because `ln` is monotone and the
 * coefficients are non-negative, the premium — and therefore the target edge —
 * is monotone NON-DECREASING in both `maxWin` and `price`.
 *
 * maxWin is the PRIMARY driver (coef 0.0008) and price the SECONDARY (coef
 * 0.0003): at the top-of-catalog reference both drivers ≈ 1.0, so the premium ≈
 * 0.0011 → 10.99% + 0.11pp ≈ 11.10%, exactly the owner's target for that pack.
 * The baselines ($500 max-win, $2 price) sit at/below the calm end of the live
 * distribution so the bulk of cheap/calm packs contribute zero premium and stay
 * on the floor. Constants are tunable via `pack_system_config` (see
 * `readEdgeCurveConfig` in `risk-config`).
 */
export type EdgeCurveConfig = {
  /** Hard floor on the target edge (default {@link DEFAULT_EDGE_FLOOR}). */
  edgeFloor: number;
  /** Hard ceiling on the target edge (default {@link DEFAULT_EDGE_CEILING}). */
  edgeCeiling: number;
  /** Premium weight on the (log-scaled) max-win driver — the PRIMARY driver. */
  maxWinCoef: number;
  /** Premium weight on the (log-scaled) price driver — the SECONDARY driver. */
  priceCoef: number;
  /** Max-win ($) at/below which the max-win driver contributes 0. */
  maxWinBase: number;
  /** Max-win ($) reference where the max-win driver's log-norm ≈ 1.0. */
  maxWinRef: number;
  /** Price ($) at/below which the price driver contributes 0. */
  priceBase: number;
  /** Price ($) reference where the price driver's log-norm ≈ 1.0. */
  priceRef: number;
};

/** Default (calibrated) edge-curve coefficients — see {@link EdgeCurveConfig}. */
export const DEFAULT_EDGE_CURVE: EdgeCurveConfig = {
  edgeFloor: DEFAULT_EDGE_FLOOR,
  edgeCeiling: DEFAULT_EDGE_CEILING,
  maxWinCoef: 0.0008,
  priceCoef: 0.0003,
  maxWinBase: 500,
  maxWinRef: 24000,
  priceBase: 2,
  priceRef: 766,
};

/**
 * Log-scaled, clamped-at-0 normalisation: 0 for `x ≤ base`, rising as
 * `ln(x/base) / ln(ref/base)` (≈ 1.0 at `x = ref`, and > 1.0 beyond it so an
 * extreme can push the premium toward the ceiling). NaN-/non-positive-safe:
 * a non-finite or ≤-base input contributes 0.
 */
function logNorm(x: number, base: number, ref: number): number {
  if (!Number.isFinite(x) || !(x > base) || !(ref > base)) return 0;
  const v = Math.log(x / base) / Math.log(ref / base);
  return v > 0 ? v : 0;
}

/**
 * The per-pack target house edge: {@link EdgeCurveConfig.edgeFloor} plus a gentle,
 * log-scaled risk premium driven primarily by the pack's max-win $ exposure and
 * secondarily by its price, clamped into `[edgeFloor, edgeCeiling]`. Pure + sync
 * + dep-free (no DB, no Decimal) so the risk-check harness, the targets reader
 * and any client preview share ONE implementation.
 *
 * Invariants (pinned in `packs/__checks__/risk.ts`):
 *   • result ∈ [edgeFloor, edgeCeiling] — NEVER below the floor (10.99%).
 *   • monotone non-decreasing in `maxWin` and in `price`.
 *   • a cheap/calm pack (price ≤ priceBase, maxWin ≤ maxWinBase) → exactly the floor.
 *   • a top-of-catalog pack (≈ priceRef / maxWinRef) → ≈ floor + (maxWinCoef +
 *     priceCoef) ≈ 11.10%.
 *
 * `maxWin` is the pack's max obtainable single-card value (the jackpot exposure).
 * For TARGET derivation (pre-shape) the actual maxWin isn't known yet, so callers
 * pass the pack's intended cap (`autoMaxWinCap(price, …)`) — see
 * {@link autoRetuneTargets}.
 */
export function autoTargetEdge(
  input: { price: number; maxWin: number },
  cfg: EdgeCurveConfig = DEFAULT_EDGE_CURVE,
): number {
  const price = Number.isFinite(input.price) && input.price > 0 ? input.price : 0;
  const maxWin = Number.isFinite(input.maxWin) && input.maxWin > 0 ? input.maxWin : 0;
  const premium =
    cfg.maxWinCoef * logNorm(maxWin, cfg.maxWinBase, cfg.maxWinRef) +
    cfg.priceCoef * logNorm(price, cfg.priceBase, cfg.priceRef);
  const edge = cfg.edgeFloor + (premium > 0 ? premium : 0);
  // Clamp into [floor, ceiling]; the premium is ≥ 0 so this only ever caps UP.
  return Math.min(cfg.edgeCeiling, Math.max(cfg.edgeFloor, edge));
}

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
 *
 * NOTE: this default is used ONLY for an UNTAGGED pack. A pack whose NAME starts
 * with a percentage (e.g. "1% 18 PLUS", "10% Divine Order") is a TAGGED hit-rate
 * pack — the leading X% is the INTENDED top-hit / gold-profit rate, so its target
 * win-rate is parsed from the name via {@link parsePackHitRate}, NOT this default.
 */
export const DEFAULT_TARGET_WIN_RATE = 0.2;

/**
 * Parse the INTENDED hit-rate (win-rate) from a pack NAME.
 *
 * Domain rule (owner): a pack whose name STARTS with a percentage — e.g.
 * "1% 18 PLUS", "5% Blazing Light", "10% Divine Order" — is a TAGGED hit-rate
 * pack. The leading `X%` is the DESIGNED top-hit / gold-profit rate: X% of opens
 * are intended to hit a profit/gold card (value ≥ price). Because win-rate is
 * exactly `P(card value ≥ price)` — the hit/profit rate — the tag maps DIRECTLY
 * to a target win-rate: `1% → 0.01`, `5% → 0.05`, `10% → 0.10`.
 *
 * Returns the tag as a FRACTION in `(0, 1]`, or `null` when the name carries no
 * leading percentage tag (an untagged pack keeps {@link DEFAULT_TARGET_WIN_RATE}).
 *
 * Pure + sync + dep-free. Matches a leading integer/decimal percentage with any
 * leading whitespace and optional space before the `%` (`"  10 % …"` parses 0.10);
 * a value of 0% or > 100% is rejected (returns `null`) since a hit-rate of 0 is
 * unshapeable and a tag above 100% is malformed.
 */
export function parsePackHitRate(name: string): number | null {
  if (typeof name !== "string") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*%/.exec(name);
  if (!m) return null;
  const pct = Number(m[1]);
  if (!Number.isFinite(pct)) return null;
  const frac = pct / 100;
  // Clamp to a sane (0, 1] range: a 0% (or negative/NaN) tag is unshapeable, a
  // > 100% tag is malformed — both fall back to the untagged default (null).
  if (!(frac > 0) || frac > 1) return null;
  return frac;
}

/**
 * The target win-rate for a pack, tag-aware: the INTENDED hit-rate parsed from the
 * pack NAME ({@link parsePackHitRate}) when the name carries a leading percentage
 * tag, else {@link DEFAULT_TARGET_WIN_RATE} (0.20). Pure + sync.
 *
 * `nameOrHitRate` accepts EITHER the raw pack name (string → parsed) OR a
 * precomputed intended hit-rate (number, already a fraction) OR `null`/`undefined`
 * (no tag → default). Passing the precomputed number lets a caller parse the name
 * ONCE and reuse it.
 */
export function resolveTargetWinRate(
  nameOrHitRate: string | number | null | undefined,
): number {
  if (typeof nameOrHitRate === "number") {
    return Number.isFinite(nameOrHitRate) && nameOrHitRate > 0 && nameOrHitRate <= 1
      ? nameOrHitRate
      : DEFAULT_TARGET_WIN_RATE;
  }
  if (typeof nameOrHitRate === "string") {
    return parsePackHitRate(nameOrHitRate) ?? DEFAULT_TARGET_WIN_RATE;
  }
  return DEFAULT_TARGET_WIN_RATE;
}

/**
 * The DB `pack_tag` percent tags mapped to their designed hit-rate. Prisma
 * returns the TS enum names (`pct1`), raw SQL returns the mapped DB strings
 * (`"%1"`) — both notations are accepted so every read path can share this.
 */
const TAG_HIT_RATES: Readonly<Record<string, number>> = {
  pct1: 0.01,
  "%1": 0.01,
  pct5: 0.05,
  "%5": 0.05,
  pct10: 0.1,
  "%10": 0.1,
};

/** The designed hit-rate carried by the DB `packs.tags` column, or `null`. */
export function hitRateFromTags(
  tags: readonly string[] | null | undefined,
): number | null {
  if (!tags) return null;
  for (const tag of tags) {
    const hitRate = TAG_HIT_RATES[tag];
    if (hitRate !== undefined) return hitRate;
  }
  return null;
}

/**
 * The pack's intended hit-rate from BOTH tag systems: the DB `packs.tags`
 * column first (authoritative — the owner categorized the pack there), the
 * name-prefix tag ({@link parsePackHitRate}) as fallback. `null` = untagged.
 *
 * Fixes the audit finding that DB-tagged packs whose name lacks a leading
 * "X%" prefix (prod: "Heavy Hitters" %1, "Legendary Showcase" %5,
 * "Molten Crown" / "Trainers Tale" %10) were silently retuned as 20% packs
 * with the tight untagged jackpot cap.
 */
export function resolveIntendedHitRate(
  name: string | null | undefined,
  tags: readonly string[] | null | undefined,
): number | null {
  return hitRateFromTags(tags) ?? (name ? parsePackHitRate(name) : null);
}

/**
 * Write-time acceptance for a pct-tagged pack's achieved win-rate vs its TAG
 * (0.1pp). The generic ±2pp solver tolerance would let a "1%" pack ship
 * anywhere in [0%, 3%] — 3x its designed winner share. Slightly looser than
 * the price-search's 0.01pp scoring gate so clean-snap rounding never trips
 * a false refusal.
 */
export const TAGGED_WRITE_WINRATE_TOLERANCE = 0.001;

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
  /**
   * The per-pack edge-curve config (floor / ceiling / coefficients). Optional so
   * existing callers that only resolve the cap config keep compiling; when
   * omitted, {@link DEFAULT_EDGE_CURVE} is used. The DB reader
   * (`readEdgeCurveConfig` in `risk-config`) fills this from
   * `pack_system_config` overrides.
   */
  edgeCurve?: EdgeCurveConfig;
};

/**
 * The auto jackpot cap (USD) for a pack at `price`: the LESSER of the absolute
 * global cap and the price-relative ceiling (`price · maxMultCeiling`), but
 * never below the ticket price itself — a cap below price would drop every
 * win/grail card and leave the pool unshapeable. Pure + sync.
 *
 *   cheap pack  → bounded by the multiplier   (price · maxMultCeiling < globalCap)
 *   premium pack→ bounded by the global cap    (globalCap < price · maxMultCeiling)
 *
 * HIT-RATE-AWARE (lottery packs): a LOW-hit-rate pack ("1% …", "5% …") needs a
 * BIG jackpot to hold the house edge — a low win probability only balances out
 * when the rare win pays a lot. So the price-relative multiplier scales INVERSELY
 * with the intended hit-rate, anchored at the default win-rate (0.20) so a
 * normal pack is UNCHANGED:
 *
 *   scale = max(1, DEFAULT_TARGET_WIN_RATE / hitRate)
 *           → 1 at the default (0.20), 4 at 5%, 20 at 1%
 *
 * `Math.max(1, …)` is the load-bearing guard: a pack with a HIGHER-than-default
 * hit-rate never gets a TIGHTER cap than the plain 100×. The cap is only ever
 * LOOSENED for low hit-rate, never tightened. The absolute `globalCap` clamp is
 * preserved, so the loosened multiplier can never breach the absolute ceiling.
 *
 * `hitRate` is the pack's INTENDED hit-rate (a fraction in (0,1], e.g. from
 * {@link parsePackHitRate}). Omitted / non-positive ⇒ the default win-rate ⇒ no
 * scale (existing callers stay byte-for-byte unchanged).
 */
export function autoMaxWinCap(
  price: number,
  cfg: ResolvedAutoTargetCfg,
  hitRate?: number,
): number {
  const effHitRate = hitRate && hitRate > 0 ? hitRate : DEFAULT_TARGET_WIN_RATE;
  // scale ≥ 1 always: 1 at the default win-rate, larger as hit-rate drops below
  // it. NEVER below 1 — a higher-than-default hit-rate keeps the plain 100×.
  const scale = Math.max(1, DEFAULT_TARGET_WIN_RATE / effHitRate);
  const multBound = price * cfg.maxMultCeiling * scale;
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
  /**
   * The INTENDED hit-rate parsed from the pack NAME (the leading `X%` tag, e.g.
   * "10% Divine Order" → 0.10), or `null` for an untagged pack. When non-null,
   * `targetWinRate === intendedHitRate` (the pack targets ITS tag hit-rate); when
   * null, `targetWinRate === DEFAULT_TARGET_WIN_RATE`. Exposed so the UI can show
   * "1% pack → targeting 1% win-rate".
   */
  intendedHitRate: number | null;
};

/**
 * The default retune targets for a pack at `price`: the PER-PACK house edge
 * target (from {@link autoTargetEdge} — floor 10.99% + a gentle risk premium),
 * the default win-rate + near-miss floors, and the auto-resolved jackpot cap.
 * Pure + sync — the caller resolves `cfg` once (via `readMaxWinCap` +
 * `readMaxMultCeiling` + `readEdgeCurveConfig`) and reuses it across packs.
 *
 * `targetEdge` uses the pack's intended jackpot cap (`autoMaxWinCap(price, cfg,
 * intendedHitRate)`) as the max-win input: pre-shape the pack's ACTUAL max
 * obtainable card value isn't known yet (the shaper decides which cards survive
 * the cap), so the cap — the worst-case top-card exposure the pack is allowed to
 * carry — is the right, deterministic proxy for the pack's house-risk premium.
 * Once shaped, the actual top card is ≤ this cap, so the cap is a conservative
 * (upper-bound) premium. For a tagged LOTTERY pack the hit-rate-aware cap is
 * larger, so its edge target is nudged up a hair (more jackpot exposure ⇒ a
 * slightly fatter risk premium) — still clamped under `edgeCeiling` (11.50%).
 *
 * Every existing consumer of `autoRetuneTargets` (`portfolio.ts`'s
 * `derivePortfolioTargets`/`computePortfolioProfile`, and — via
 * `resolveRetuneTargets` — `planPackRetune`/`applyPackRetune`/`planAllRetunes`)
 * therefore auto-inherits the per-pack edge through this one return shape.
 *
 * TAG-AWARE WIN-RATE: pass the pack NAME (or a precomputed intended hit-rate) as
 * `nameOrHitRate`. A pack whose name starts with a percentage (e.g. "10% Divine
 * Order") targets THAT hit-rate ({@link parsePackHitRate}: 10% → 0.10); an
 * untagged pack keeps {@link DEFAULT_TARGET_WIN_RATE} (0.20). The parsed tag is
 * also returned verbatim as `intendedHitRate` (null when untagged) so callers /
 * the UI can show "1% pack → targeting 1% win-rate". Omitting the argument keeps
 * the legacy behavior (default win-rate, `intendedHitRate: null`).
 */
export function autoRetuneTargets(
  price: number,
  cfg: ResolvedAutoTargetCfg,
  nameOrHitRate?: string | number | null,
): AutoRetuneTargets {
  const intendedHitRate =
    typeof nameOrHitRate === "string"
      ? parsePackHitRate(nameOrHitRate)
      : typeof nameOrHitRate === "number" &&
          Number.isFinite(nameOrHitRate) &&
          nameOrHitRate > 0 &&
          nameOrHitRate <= 1
        ? nameOrHitRate
        : null;
  // HIT-RATE-AWARE cap: a tagged lottery pack ("1% …") gets a LOOSENED jackpot
  // ceiling so its big top card survives the shaper (a low hit-rate needs a big
  // jackpot to hold the edge). Untagged ⇒ intendedHitRate null ⇒ the plain cap.
  const maxWinCap = autoMaxWinCap(price, cfg, intendedHitRate ?? undefined);
  return {
    targetEdge: autoTargetEdge(
      { price, maxWin: maxWinCap },
      cfg.edgeCurve ?? DEFAULT_EDGE_CURVE,
    ),
    targetWinRate: intendedHitRate ?? DEFAULT_TARGET_WIN_RATE,
    nearMissMin: DEFAULT_NEAR_MISS_MIN,
    maxWinCap,
    intendedHitRate,
  };
}
