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

/**
 * ARBITRARY hit-rate tag notation (retune V2 ruleset §0 / TAG-TRUTH): the
 * `%1 / %5 / %10` enum stays the PRODUCT tier, but the ENGINE accepts any
 * fraction in `(0, 0.5]` — prod runs pools at 0.2% and 4.9% that the enum
 * cannot represent. This parses the generalized `%X` / `pctX` notations
 * (integer or decimal) so a retag-to-live-rate can round-trip through the
 * same tag plumbing. The fixed map above stays FIRST (byte-identical for the
 * three product tiers); this is the fallback for everything else.
 */
function parseArbitraryTag(tag: string): number | null {
  const m = /^(?:%|pct)(\d+(?:\.\d+)?)$/.exec(tag);
  if (!m) return null;
  const pct = Number(m[1]);
  if (!Number.isFinite(pct)) return null;
  const frac = pct / 100;
  // Arbitrary tags are valid in (0, 0.5] — a "tag" above 50% winners is not a
  // lottery product and is rejected (null → untagged fallback).
  if (!(frac > 0) || frac > 0.5) return null;
  return frac;
}

/** The designed hit-rate carried by the DB `packs.tags` column, or `null`. */
export function hitRateFromTags(
  tags: readonly string[] | null | undefined,
): number | null {
  if (!tags) return null;
  for (const tag of tags) {
    const hitRate = TAG_HIT_RATES[tag];
    if (hitRate !== undefined) return hitRate;
  }
  // Arbitrary-fraction fallback (ruleset §0): "%4.9" / "pct0.2" etc.
  for (const tag of tags) {
    const hitRate = parseArbitraryTag(tag);
    if (hitRate !== null) return hitRate;
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

/** {@link resolveIntendedHitRateDetailed} result — tag + provenance + conflict. */
export type ResolvedHitRateDetail = {
  /** The resolved intended hit-rate (DB-first, name fallback), or null. */
  hitRate: number | null;
  /** Which tag system supplied the rate (null when untagged). */
  source: "db" | "name" | null;
  /**
   * TRUE when BOTH tag systems carry a rate and they disagree (> 1e-6) — e.g.
   * a "%5"-tagged pack named "10% …". The DB tag wins (authoritative), but the
   * disagreement is surfaced so an operator can repair the mislabel instead of
   * silently trusting one side.
   */
  conflict: boolean;
};

/**
 * Detailed variant of {@link resolveIntendedHitRate} (ruleset §0): same DB-
 * first resolution, plus WHICH system supplied the tag and whether the two
 * systems disagree. `resolveIntendedHitRate` stays the compact primitive every
 * existing call site uses; this feeds surfaces that render tag provenance /
 * mislabel warnings (workspace rail, guidance engine, fleet audits).
 */
export function resolveIntendedHitRateDetailed(
  name: string | null | undefined,
  tags: readonly string[] | null | undefined,
): ResolvedHitRateDetail {
  const db = hitRateFromTags(tags);
  const fromName = name ? parsePackHitRate(name) : null;
  const hitRate = db ?? fromName;
  const source: "db" | "name" | null =
    db !== null ? "db" : fromName !== null ? "name" : null;
  const conflict =
    db !== null && fromName !== null && Math.abs(db - fromName) > 1e-6;
  return { hitRate, source, conflict };
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
 *
 * UNTAGGED PACKS ONLY — a tagged lottery pack uses {@link TAGGED_NEAR_MISS_MIN}.
 */
export const DEFAULT_NEAR_MISS_MIN = 0.1;

/**
 * Near-miss floor for a TAGGED lottery pack: ZERO, for ALL tags (ruleset §1.2,
 * THE near-miss decision). The lottery product is binary — win ≥ ~breakeven or
 * dust; teaser cards below price are not in the genre:
 *   • rain.gg corpus: mass in [0.5·price, price) is exactly 0 in ALL 104
 *     exact-spec lottery cases across all three tiers;
 *   • prod fleet: 39/41 live tagged pools carry zero near-miss cards, and the
 *     forced 0.10 floor only produced noise relaxations — or flipped
 *     solver-verified on-tag packs infeasible ([math LAW 14]).
 * Callers SEED upward from the live pool: when the live pool genuinely carries
 * near-miss mass (e.g. Divine Order's designed 20% band), pass
 * `max(TAGGED_NEAR_MISS_MIN, live near-miss mass)` so the designed structure
 * is preserved rather than deleted.
 */
export const TAGGED_NEAR_MISS_MIN = 0;

/**
 * Headroom multiplier on the hit-rate-aware jackpot cap for TAGGED packs
 * (ruleset §1.2, [fleet CAP-STRIP]): the owner deliberately runs 10% packs
 * with 202–207× jackpots (Bling Bling $2,400 = 202.5×, Chaos $905.83 =
 * 206.8×) — the exact 200× cap silently deleted those jackpots in the cap
 * pre-filter and made the target EV unreachable. 1.15 lifts the tagged caps to
 * 230×/460×/2300× (10%/5%/1%), inside which every real rain.gg tier envelope
 * fits (1% median 326×, p90 1018×, max ~1443×) — the headroom binds nothing
 * real while no deliberately-run jackpot is stripped. UNTAGGED packs carry NO
 * headroom (byte-identical plain cap).
 */
export const TAG_CAP_HEADROOM = 1.15;

/**
 * UNTAGGED win-rate is LIVE-ANCHORED (owner-lens Pattern 3, 2026-07-03): the
 * flat 20% recipe ({@link DEFAULT_TARGET_WIN_RATE}) is fiction — it rewrote
 * ~61% of the untagged fleet's designed win-rate upward (a deliberate 8.5%
 * pack floated to 21%; a 50/50 pack to 55%). When the caller passes the live
 * pool's actual win-rate, an untagged retune targets THAT rate (the pack's own
 * designed character), clamped only to a sane product band. The 20% default
 * survives ONLY for a pack with no live pool (a brand-new pack).
 */
export const UNTAGGED_WINRATE_LIVE_MIN = 0.02;
export const UNTAGGED_WINRATE_LIVE_MAX = 0.95;

/**
 * UNTAGGED near-miss is SEEDED FROM LIVE (owner-lens Pattern 3 sub-pattern):
 * the flat 0.1 floor ({@link DEFAULT_NEAR_MISS_MIN}) legally drained designed
 * 40–70% near-miss bands down to 10%. Seed the floor up from the live pool's
 * real near-miss mass (×0.8, mirroring the tagged arm's live seed) so a
 * deliberately teasy pack keeps its "almost!" band. Never LOWERS the floor
 * below the 0.1 default — only raises it toward the live design.
 */
export const UNTAGGED_NEAR_MISS_LIVE_FACTOR = 0.8;

/**
 * EDGE NEVER-BELOW-LIVE (owner-lens Pattern 7, 2026-07-03): the curve target is
 * a setpoint the solver pulls DOWN to when the live edge sits above it — a pure
 * margin refund the owner already banks (Amazon 11.30% → 10.99%). When the live
 * edge is at/above the curve target, the retune targets `max(curveTarget,
 * liveEdge − slack)` (still clamped under the ceiling) — plans may HOLD or
 * RAISE edge vs live, never give it back. A below-target pack is untouched: it
 * still lifts to the curve target. The 0.05pp slack absorbs snap rounding so a
 * held-edge plan never trips a false "below live" flag.
 */
export const EDGE_NEVER_BELOW_LIVE_SLACK = 0.0005;

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
 *   scale = max(1, DEFAULT_TARGET_WIN_RATE / hitRate) · TAG_CAP_HEADROOM
 *           → 1 untagged, 2.3 at 10%, 4.6 at 5%, 23 at 1%
 *
 * `Math.max(1, …)` is the load-bearing guard: a pack with a HIGHER-than-default
 * hit-rate never gets a TIGHTER cap than the plain 100×. The cap is only ever
 * LOOSENED for low hit-rate, never tightened. The absolute `globalCap` clamp is
 * preserved, so the loosened multiplier can never breach the absolute ceiling.
 *
 * TAGGED packs additionally carry {@link TAG_CAP_HEADROOM} (×1.15) on the
 * scaled multiplier ([fleet CAP-STRIP]: the exact 200× cap on a 10% tag
 * silently deleted the owner's deliberately-run 202–207× jackpots and made the
 * EV unreachable). The headroom applies ONLY when a below-default hit-rate is
 * supplied — the untagged path stays byte-for-byte identical (scale 1).
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
  // A tagged (below-default) hit-rate carries the CAP-STRIP headroom so the
  // owner's deliberately-run just-over-the-line jackpots survive the pre-filter.
  const scale =
    effHitRate < DEFAULT_TARGET_WIN_RATE
      ? (DEFAULT_TARGET_WIN_RATE / effHitRate) * TAG_CAP_HEADROOM
      : 1;
  const multBound = price * cfg.maxMultCeiling * scale;
  const cap = Math.min(cfg.globalCap, multBound);
  // Never cap below the ticket price (would strip all win/grail cards).
  return Math.max(cap, price);
}

/**
 * The pack's LIVE-pool anchors (owner-lens live-anchored targets, 2026-07-03).
 * When the caller KNOWS the live pool (both `planPackTune` arms + the staged
 * resolver), it passes these so the retune targets the pack's OWN designed
 * character instead of a fleet recipe:
 *   • `winRate` — untagged win-rate is anchored here (kills the 20% fiction).
 *   • `nearMiss` — untagged near-miss floor is seeded up from here.
 *   • `edge` — the retune's edge is never pulled below this when live ≥ target.
 *   • `topValue` — a live over-cap card is grandfathered (cap stops NEW
 *     escalation, never deletes a running product — Pattern 5).
 * Omitted ⇒ every field falls back to the legacy fleet default (existing
 * callers byte-identical). Each field is independently optional so a caller
 * that only knows some anchors can pass a partial object.
 */
export type LiveTargetAnchors = {
  /** Live pool win-rate (fraction) — untagged target anchor. */
  winRate?: number;
  /** Live pool near-miss mass (fraction) — untagged near-miss seed. */
  nearMiss?: number;
  /** Live pool house edge (fraction) — never-below-live edge floor. */
  edge?: number;
  /** Live pool top card value (USD) — over-cap grandfather. */
  topValue?: number;
};

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
 *
 * ARCHETYPE SPLIT (ruleset §1): a TAGGED pack is a binary lottery product —
 * its `nearMissMin` is {@link TAGGED_NEAR_MISS_MIN} (0; callers seed upward
 * from the live pool's real near-miss mass), while an untagged pack keeps
 * {@link DEFAULT_NEAR_MISS_MIN} (0.1).
 *
 * POOL-AWARE EDGE PREMIUM (`poolMaxWin`, optional 4th arg): when the caller
 * KNOWS the pool (planPackTune, staged solves), pass the pool's actual top
 * card value — `targetEdge` is then computed with
 * `maxWin = min(poolMaxWin, maxWinCap)` instead of the theoretical cap.
 * Feeding the LOOSENED tagged cap into the curve charged a phantom risk
 * premium (~+0.04pp on a typical 1% pack) for jackpot exposure the pool does
 * not actually carry, worsening the below-floor squeeze ([fleet
 * PREMIUM-KILLS]; [rain]: lottery edge equals the house standard, never
 * higher). Omitted / non-positive ⇒ the legacy cap-proxy (existing callers
 * byte-identical).
 *
 * LIVE-ANCHORED TARGETS (`live`, optional 5th arg — owner-lens 2026-07-03):
 * when the caller knows the LIVE pool, pass {@link LiveTargetAnchors} so the
 * retune targets the pack's OWN designed character rather than a fleet recipe:
 *   • UNTAGGED win-rate is anchored to `live.winRate` (kills the flat-20%
 *     fiction that rewrote ~61% of the untagged fleet upward), clamped into
 *     `[UNTAGGED_WINRATE_LIVE_MIN, UNTAGGED_WINRATE_LIVE_MAX]`. TAGGED packs
 *     keep their exact tag — untouched.
 *   • UNTAGGED near-miss floor is seeded up from `live.nearMiss × 0.8`
 *     (`max` with the 0.1 default) so a designed teaser band survives.
 *   • `targetEdge` is floored at `live.edge − EDGE_NEVER_BELOW_LIVE_SLACK`
 *     when live ≥ curve target — plans HOLD or RAISE edge vs live, never
 *     refund it (Pattern 7). A below-target pack still lifts to the curve.
 *   • the jackpot cap GRANDFATHERS a live over-cap card (`max(autoCap,
 *     live.topValue)`) so a deliberately-run running product isn't deleted —
 *     the cap stops NEW escalation only (Pattern 5). This applies whether or
 *     not the pack is tagged (a tagged pack already gets the headroom cap;
 *     the grandfather is a further `max` that only ever LOOSENS).
 * Omitted / partial ⇒ each missing anchor falls back to the legacy default
 * (existing callers byte-identical).
 */
export function autoRetuneTargets(
  price: number,
  cfg: ResolvedAutoTargetCfg,
  nameOrHitRate?: string | number | null,
  poolMaxWin?: number | null,
  live?: LiveTargetAnchors | null,
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
  const autoCap = autoMaxWinCap(price, cfg, intendedHitRate ?? undefined);
  // GRANDFATHER (Pattern 5): a card the owner already runs live ABOVE the auto
  // cap is kept — the cap should stop NEW escalation, not delete a running
  // product. Only ever loosens the cap (a live top BELOW the auto cap changes
  // nothing). Applies to tagged + untagged alike.
  const liveTop =
    typeof live?.topValue === "number" &&
    Number.isFinite(live.topValue) &&
    live.topValue > 0
      ? live.topValue
      : 0;
  const maxWinCap = liveTop > autoCap ? liveTop : autoCap;
  // Edge-curve input: the pool's ACTUAL top-card exposure when known (never
  // above the cap the shaper will enforce), else the cap as the deterministic
  // pre-shape proxy (legacy).
  const curveMaxWin =
    typeof poolMaxWin === "number" && Number.isFinite(poolMaxWin) && poolMaxWin > 0
      ? Math.min(poolMaxWin, maxWinCap)
      : maxWinCap;
  const curveEdge = autoTargetEdge(
    { price, maxWin: curveMaxWin },
    cfg.edgeCurve ?? DEFAULT_EDGE_CURVE,
  );
  const edgeCeiling = (cfg.edgeCurve ?? DEFAULT_EDGE_CURVE).edgeCeiling;
  // NEVER-BELOW-LIVE EDGE (Pattern 7): when the live edge is at/above the curve
  // target, floor the retune's edge at `liveEdge − slack` (still under the
  // ceiling) so a retune can only HOLD or RAISE the edge the owner already
  // banks — never refund it. A below-target pack keeps the curve target (its
  // liveEdge is below curveEdge, so the max is a no-op).
  const liveEdge =
    typeof live?.edge === "number" && Number.isFinite(live.edge) && live.edge > 0
      ? live.edge
      : 0;
  const targetEdge =
    liveEdge > 0
      ? Math.min(
          edgeCeiling,
          Math.max(curveEdge, liveEdge - EDGE_NEVER_BELOW_LIVE_SLACK),
        )
      : curveEdge;
  // UNTAGGED WIN-RATE (Pattern 3): anchor to the pack's OWN live win-rate, not
  // the flat 20% recipe — clamped only to a sane product band. TAGGED packs
  // target their exact tag (untouched). No live pool (brand-new pack) ⇒ the
  // 20% default survives.
  const liveWinRate =
    typeof live?.winRate === "number" &&
    Number.isFinite(live.winRate) &&
    live.winRate > 0
      ? live.winRate
      : null;
  const targetWinRate =
    intendedHitRate !== null
      ? intendedHitRate
      : liveWinRate !== null
        ? Math.min(
            UNTAGGED_WINRATE_LIVE_MAX,
            Math.max(UNTAGGED_WINRATE_LIVE_MIN, liveWinRate),
          )
        : DEFAULT_TARGET_WIN_RATE;
  // UNTAGGED NEAR-MISS (Pattern 3 sub-pattern): seed the floor UP from the live
  // pool's real near-miss mass (×0.8) so a designed teaser band survives the
  // retune instead of draining to the flat 0.1 floor. Never lowers the floor.
  const liveNearMiss =
    typeof live?.nearMiss === "number" &&
    Number.isFinite(live.nearMiss) &&
    live.nearMiss > 0
      ? live.nearMiss
      : 0;
  const nearMissMin =
    intendedHitRate !== null
      ? TAGGED_NEAR_MISS_MIN
      : Math.max(
          DEFAULT_NEAR_MISS_MIN,
          liveNearMiss * UNTAGGED_NEAR_MISS_LIVE_FACTOR,
        );
  return {
    targetEdge,
    targetWinRate,
    nearMissMin,
    maxWinCap,
    intendedHitRate,
  };
}
