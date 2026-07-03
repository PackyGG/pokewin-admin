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
  TAGGED_WINRATE_TOLERANCE,
  type ShapeWeightsPinnedShare,
} from "../../insights/edge-calc/risk";

/** Which solve arm the params are for (anchor semantics live at the caller). */
export type RetuneArm = "live" | "staged";

/**
 * One owner-pinned card odds (Retune V2 pins): the typed PERCENT the plan —
 * and therefore the write — must hold this card at EXACTLY. Serializable
 * (rides `PackTuneStagedInput`, the staged sessionStorage payload and the
 * frozen push artifact verbatim).
 */
export type RetunePinnedOdds = { cardId: string; pct: number };

export type RetuneSearchInputs = {
  /**
   * Pool card values — solve order = pool order (live) / staged order
   * (staged). `cardId` is OPTIONAL (legacy callers pass values only) but
   * REQUIRED on every card whenever `pinnedOdds` is non-empty — the builder
   * resolves each pin to its card index by id.
   */
  cards: { value: number; cardId?: string }[];
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
  /**
   * Owner-pinned EXACT per-card odds. The caller (action) validates the pins
   * STRUCTURALLY against its pool (real cards, no dupes, pct > 0) BEFORE the
   * builder; feasibility (cap-dropped pin, tag/EV overshoot, edge band) is
   * judged by the solver and comes back as the `pins-infeasible` limit —
   * data, never a throw. Omit / empty ⇒ legacy params, byte-identical.
   */
  pinnedOdds?: RetunePinnedOdds[];
};

/**
 * Map owner pins ({cardId, pct} — percent) onto solver pin shares
 * ({index, share} — fraction), resolved against the SAME `cards` array the
 * solve receives and sorted by index so plan and write emit an identical
 * vector (the parity harness deep-equals it). Throws on an unmatched cardId —
 * the calling action validates pins against its pool FIRST, so a throw here
 * is an invariant violation (a plan/write construction bug), never
 * user-reachable input.
 */
export function mapPinnedOddsToShares(
  cards: { value: number; cardId?: string }[],
  pinnedOdds: RetunePinnedOdds[],
): ShapeWeightsPinnedShare[] {
  const idxByCardId = new Map<string, number>();
  cards.forEach((c, i) => {
    if (c.cardId !== undefined) idxByCardId.set(c.cardId, i);
  });
  return pinnedOdds
    .map((p) => {
      const index = idxByCardId.get(p.cardId);
      if (index === undefined) {
        throw new Error(
          "Retune pin references a card that is not part of the solve pool — plan/write construction bug.",
        );
      }
      return { index, share: p.pct / 100 };
    })
    .sort((a, b) => a.index - b.index);
}

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
  // Tagged gate: active iff the resolved target IS the tag (value equality) —
  // an operator-pinned rate away from the tag never silently runs tagged mode.
  const tagged =
    i.intendedHitRate !== null &&
    Math.abs(i.intendedHitRate - i.targetWinRate) < 1e-9;
  // Owner pins ride the SAME shared constructor as everything else, so the
  // pinned solve the operator previews is byte-identically the pinned solve
  // the write re-runs (preview ≡ write including pins). Key ABSENT when no
  // pins exist — legacy callers' param objects stay byte-identical.
  const pinnedShares =
    i.pinnedOdds !== undefined && i.pinnedOdds.length > 0
      ? mapPinnedOddsToShares(i.cards, i.pinnedOdds)
      : null;
  return {
    cards: i.cards,
    basePrice: i.basePrice,
    targetEdge: i.targetEdge,
    targetWinRate: i.targetWinRate,
    maxWinCap: i.maxWinCap,
    nearMissMin: i.nearMissMin,
    // LAW 15 (ruleset §0): a tagged solve carries the STRICT solver tolerance
    // (0.01pp) — the clean-snap acceptance gate reads `winRateTol`, and under
    // the loose 0.02 default it legally drifted a 1% tag to 1.072%. Enforced
    // HERE (the one shared constructor) so all four solve sites — both plans,
    // both writes — inherit it and preview ≡ write stays unconstructible skew.
    winRateTol: tagged ? TAGGED_WINRATE_TOLERANCE : i.winRateTol,
    currentWeights: i.currentWeights,
    // The ONE shared retune band, both arms (staged: ±25% → ±60%, owner-
    // sanctioned — price is a free lever; clean odds are a MUST).
    maxPriceChangePct: RETUNE_MAX_PRICE_CHANGE_PCT,
    upwardPriceExtensionPct: 0,
    // Tagged win-rate accuracy scoring (0.01pp) — see the gate above.
    ...(tagged ? { taggedWinRate: i.targetWinRate } : {}),
    ...(pinnedShares !== null ? { pinnedShares } : {}),
  };
}
