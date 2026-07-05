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
 *   • `maxPriceChangePct: priceBudgetPct` — the retune price budget the caller
 *     resolves ONCE (via `readRetunePriceBudgetPct()`) and passes to plan AND
 *     write, so preview ≡ write stays unconstructible skew. The DEFAULT budget
 *     is ±10% ({@link RETUNE_PRICE_BUDGET_DEFAULT_PCT}); the full ±60% band
 *     ({@link RETUNE_MAX_PRICE_CHANGE_PCT}) survives ONLY as the SUGGESTION
 *     band — a bounded wide probe that PROPOSES beyond-budget prices, ranked
 *     and never silently applied. The builder clamps the passed budget into
 *     `[0.0001, RETUNE_MAX_PRICE_CHANGE_PCT]` so a mis-configured value can
 *     never breach the ±60% hard cap.
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

/** Lower clamp on the price budget: a positive band the search can move within. */
const MIN_PRICE_BUDGET_PCT = 0.0001;

/**
 * Max intended hit-rate that is a LOTTERY (rare-win) archetype eligible for the
 * strict tagged clean-snap path (the per-100k jackpot-ladder DFS + 320-candidate
 * accuracy search). The tags in play are 1% / 5% / 10% (all ≤ 0.12) plus the
 * `50/50` coin-flip (0.50). The lottery snapper is DESIGNED for rare wins: at a
 * high win-rate it must place a huge win mass across many win cards on clean
 * rungs — a combinatorial blow-up (measured: a 9-card `50/50` pack = ~4.7s pure
 * per solve → the ±10% price search ran it 320× → the route timed out → the
 * MAIN max:3 pool got exhausted → the WHOLE admin timed out, the pool-stampede
 * cascade). A coin-flip / high win-rate tag is NOT a lottery: it takes the
 * standard clean-ladder snap (fast: ~0.36s) with `holdWinRate` keeping the
 * achieved rate within +5pp of the tag — plenty exact for a "half the opens
 * win" product (the 0.01pp tagged tolerance only ever mattered for a *rare*
 * 1% tag). So tagged-lottery mode is gated to `intendedHitRate ≤ this`.
 */
const LOTTERY_MAX_HIT_RATE = 0.12;

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
   * The retune price budget (fraction of `basePrice`) — resolved ONCE by the
   * caller via `readRetunePriceBudgetPct()` and passed to plan AND write so
   * preview ≡ write stays unconstructible skew. REQUIRED (not optional): every
   * call site must consciously pass it — a silently-defaulted band is exactly
   * the class of skew the one-brain kills. The builder clamps it into
   * `[MIN_PRICE_BUDGET_PCT, RETUNE_MAX_PRICE_CHANGE_PCT]`.
   */
  priceBudgetPct: number;
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
 * Cap-removal classification (owner rule, 2026-07-03): a card whose value
 * exceeds the resolved max-win cap is DROPPED by the solver's cap pre-filter
 * (`shapeWeights` assigns it weight 0 before any odds exist) — and the owner
 * wants that surfaced and persisted as a true REMOVAL, not a silent 0% row.
 *
 * This is THE one predicate both plans and both writes classify with: it
 * mirrors the engine pre-filter exactly (strict `value > maxWinCap`; the
 * `!(value > 0)` arm of the pre-filter is a degenerate-value drop, NOT a cap
 * removal, and is deliberately excluded here). Only cards that carry a
 * `cardId` can be reported (value-only design slots have no identity).
 *
 * Kept HERE (pure, dep-free) so the `packs/__checks__/` harness can pin that
 * plan classification ≡ write omission on the same fixture.
 */
export function computeCapDroppedCardIds(
  cards: readonly { cardId?: string; value: number }[],
  maxWinCap: number,
): string[] {
  if (!Number.isFinite(maxWinCap)) return [];
  const out: string[] = [];
  for (const c of cards) {
    if (
      c.cardId !== undefined &&
      Number.isFinite(c.value) &&
      c.value > maxWinCap
    ) {
      out.push(c.cardId);
    }
  }
  return out;
}

/**
 * THE one write-vector filter (owner rule, 2026-07-03): no MAIN retune write
 * ever persists a `pack_cards` row with weight ≤ 0. A shaped weight of 0 only
 * exists for slots the solver's pre-filter dropped (over-cap, or a
 * non-positive value) — persisting such a row used to leave a dead 0%-odds
 * card in the pack; the owner wants the card truly removed (recoverable via
 * the History snapshot revert). Verbatim paths (`applyPackEdit`, pins) keep
 * refusing an explicit typed 0 as a VALIDATION ERROR — this filter is for
 * SERVER-shaped vectors only, where 0 is the engine's removal verdict.
 */
export function omitZeroWeightRows<T extends { weight: number }>(
  rows: readonly T[],
): T[] {
  return rows.filter((r) => Number.isFinite(r.weight) && r.weight > 0);
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
  // Tagged gate: active iff (a) the tag is a LOTTERY (rare-win) archetype
  // (`intendedHitRate ≤ LOTTERY_MAX_HIT_RATE` — the 1/5/10% tags) AND (b) the
  // resolved target IS the tag (value equality) — an operator-pinned rate away
  // from the tag never silently runs tagged mode. A high win-rate tag (the
  // `50/50` coin-flip) is deliberately NOT tagged here: the lottery snapper
  // blows up on it (see {@link LOTTERY_MAX_HIT_RATE}); it takes the fast
  // standard snap + `holdWinRate` instead, which lands the rate within +5pp of
  // the tag — exact enough for a half-the-opens-win product.
  const tagged =
    i.intendedHitRate !== null &&
    i.intendedHitRate <= LOTTERY_MAX_HIT_RATE &&
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
    // The retune price budget (both arms): the DEFAULT plan may move the ticket
    // at most ±`priceBudgetPct` (default ±10%). Clamped into
    // [MIN_PRICE_BUDGET_PCT, RETUNE_MAX_PRICE_CHANGE_PCT] so a mis-configured
    // budget can never breach the ±60% hard cap. The full ±60% band survives
    // only as the SUGGESTION probe (spread-override `maxPriceChangePct` at the
    // call site — never the default plan / write artifact).
    maxPriceChangePct: Math.min(
      Math.max(i.priceBudgetPct, MIN_PRICE_BUDGET_PCT),
      RETUNE_MAX_PRICE_CHANGE_PCT,
    ),
    upwardPriceExtensionPct: 0,
    // Tagged win-rate accuracy scoring (0.01pp) — see the gate above.
    ...(tagged ? { taggedWinRate: i.targetWinRate } : {}),
    // WIN-RATE HOLD (owner-lens item 4): an UNTAGGED retune holds the achieved
    // win-rate within +5pp ({@link WINRATE_HOLD_BAND}) of the pack's
    // live-anchored design instead of floating far above it (Three Blades
    // 30%→37.5%). Applied at every candidate price; a price where the held
    // win-rate can't reach the edge errors and the search moves to one where it
    // can (a clean plan) — or the pack surfaces as the wide-probe / pool-edit
    // path. No-op in tagged mode (a tagged pack never floats — the tag pins the
    // win-rate). Both plan arms + both writes inherit it through this one
    // constructor, so preview ≡ write stays unconstructible skew.
    ...(tagged ? {} : { holdWinRate: true }),
    // LOSS-MASS DISPERSION (owner-lens item 10): every retune re-spreads the
    // free-dust loss band at fixed mass + EV (edge / win-rate / tag byte-for-byte
    // preserved) so the crush ladder's single-carrier collapse is loosened where
    // the pool has room. EV-forced crushes (Captive) are untouched (the pool-edit
    // path owns those). Safe for tagged packs too — it never moves the win band.
    disperseLoss: true,
    ...(pinnedShares !== null ? { pinnedShares } : {}),
  };
}
