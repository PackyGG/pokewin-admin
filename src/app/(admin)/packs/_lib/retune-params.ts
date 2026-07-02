/**
 * THE one place retune price-search parameters are built (Retune V2 "one
 * brain" root fix — RC1 kill-shot).
 *
 * Every retune solve — the read-only plan (`planPackTune`, both arms) AND both
 * MAIN write actions (`applyPackRetune`, `applyStagedPackEditAndRetune`) —
 * MUST construct its `searchBestPriceForCleanSnap` argument object through
 * {@link buildRetuneSearchParams}. The write paths pin the previewed price
 * with tolerance 0 (`approvedPriceAfter`) + a pool-freshness fingerprint
 * (`approvedPoolFingerprint`); that pin is only sound when plan and write
 * solve the EXACT same problem. Sharing this constructor makes preview↔write
 * parameter skew unconstructible instead of comment-discipline.
 *
 * Contract (identical on BOTH arms — the arm only names which anchor semantics
 * the caller used: live pool/live price vs staged pool/staged price):
 *   • `maxPriceChangePct: RETUNE_MAX_PRICE_CHANGE_PCT` (±60%) — the ONE shared
 *     retune band. NOTE: this deliberately widens the staged write's search
 *     from its silent ±25% default to the shared ±60% band — owner-sanctioned
 *     ("price is a free lever", 2026-07-02) and required for the tolerance-0
 *     price pin to be skew-proof across arms.
 *   • `upwardPriceExtensionPct: 0` — no upward extension; legacy chip-strip
 *     callers may still override it AFTER the builder (V2 never does).
 *   • no `preferHigherEdge` — snap-first scoring (clean odds are a MUST).
 *   • the tagged gate: `taggedWinRate` is set iff the resolved intended
 *     hit-rate exists AND value-equals the target win-rate (< 1e-9) — exactly
 *     the value-equality gate both writes used before the extraction.
 *   • `currentWeights` — the anti-inflation anchor (live weights; staged-in
 *     cards ride a 0), forwarded verbatim.
 *
 * Pure + dependency-light (imports only the dep-free risk engine) so the
 * `packs/__checks__/retune-params.ts` parity harness can pin it via `npx tsx`.
 */

import {
  searchBestPriceForCleanSnap,
  RETUNE_MAX_PRICE_CHANGE_PCT,
} from "../../insights/edge-calc/risk";

/** Which solve arm the params are for (anchor semantics live at the caller). */
export type RetuneArm = "live" | "staged";

export type RetuneSearchInputs = {
  /** Pool card values — solve order = pool order (live) / staged order (staged). */
  cards: { value: number }[];
  /** Live price (live arm) / staged price (staged arm). */
  basePrice: number;
  targetEdge: number;
  targetWinRate: number;
  maxWinCap: number;
  nearMissMin: number;
  winRateTol: number;
  /**
   * Anti-inflation anchor: the pack's CURRENT (live-pool) weights aligned to
   * `cards` order; a staged-in card that wasn't in the live pool carries 0.
   */
  currentWeights: number[];
  /** `resolveIntendedHitRate(name, tags)` — null for an untagged pack. */
  intendedHitRate: number | null;
};

/**
 * Build the FULL `searchBestPriceForCleanSnap` argument object for a retune
 * solve. Consumed by four call sites: `applyPackRetune`'s solve,
 * `applyStagedPackEditAndRetune`'s solve, and both `planPackTune` arms — the
 * tolerance-0 `approvedPriceAfter` pin depends on all four sharing it.
 */
export function buildRetuneSearchParams(
  arm: RetuneArm,
  i: RetuneSearchInputs,
): Parameters<typeof searchBestPriceForCleanSnap>[0] {
  return {
    cards: i.cards,
    basePrice: i.basePrice,
    targetEdge: i.targetEdge,
    targetWinRate: i.targetWinRate,
    maxWinCap: i.maxWinCap,
    nearMissMin: i.nearMissMin,
    winRateTol: i.winRateTol,
    currentWeights: i.currentWeights,
    // The ONE shared retune band, both arms (staged: ±25% → ±60%, owner-
    // sanctioned — price is a free lever; clean odds are a MUST).
    maxPriceChangePct: RETUNE_MAX_PRICE_CHANGE_PCT,
    upwardPriceExtensionPct: 0,
    // Tagged gate: strict 0.01pp win-rate accuracy scoring is active iff the
    // resolved target IS the tag (value equality) — an operator-pinned rate
    // away from the tag never silently runs tagged mode.
    ...(i.intendedHitRate !== null &&
    Math.abs(i.intendedHitRate - i.targetWinRate) < 1e-9
      ? { taggedWinRate: i.targetWinRate }
      : {}),
  };
}
