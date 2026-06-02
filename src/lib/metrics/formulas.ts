/**
 * formulas.ts — pure, side-effect-free metric arithmetic.
 *
 * Phase-1 foundation, UNWIRED. Mirrors the dep-free style of
 * `src/app/(admin)/insights/edge-calc/math.ts`: every input and output is
 * a primitive number, no Decimal objects cross this boundary, nothing
 * here touches the DB. Everything is unit-testable in isolation (see
 * `__checks__/run.ts`).
 *
 * All sign conventions are HOUSE perspective per CLAUDE.md:
 *   • GGR / NGR / house-edge POSITIVE  → house up   → 🟢 emerald
 *   • GGR / NGR / house-edge NEGATIVE  → house down → 🔴 rose
 *
 * The booking model these formulas encode is documented in
 * `ledger-sets.ts` (CASE iii): wager is a ledger debit; the dominant
 * pack/battle payout is the `user_inventory.value_at_obtained` delta, NOT
 * a ledger type; `battle_refund` is the only cash gaming-payout leg on
 * the ledger; card conversions are neutral.
 */

// ─── Sample-size guard for empirical per-bucket metrics ──────────────

/**
 * Minimum number of settled bets a bucket must have before an EMPIRICAL
 * (observed) RTP / house-edge is reported as fact. Below this, observed
 * RTP is dominated by variance — the historical −14.92% / 114.92%
 * upgrader edges and >100% per-pack RTPs (M7/M8) were small-sample noise,
 * not formula bugs. Below the threshold the empirical helpers return
 * `null` (an "insufficient sample" sentinel) so the UI can render
 * "n/a — insufficient sample" instead of a misleading number.
 *
 * Does NOT apply to THEORETICAL RTP/edge (computed from pool composition
 * in `math.ts`) — those are exact and need no sample guard.
 */
export const MIN_SAMPLE = 30 as const;

// ─── Gaming payout (inventory-aware) ─────────────────────────────────

export type GamingPayoutInput = {
  /**
   * Σ `user_inventory.value_at_obtained` for rows with
   * `source_type IN ('pack','battle')`, obtained inside the window,
   * borrow plays excluded. This is the DOMINANT pack/battle payout (the
   * cards the user kept). See `queries.ts` `gamingPayoutQuery`.
   */
  inventoryPayout: number;
  /**
   * Σ |amount| over GAMING_PAYOUT_TYPES inside the window — the LEDGER
   * cash gaming-payout legs: `battle_refund` (battle winner cash) AND
   * `battle_excess_to_voucher` (the voucher remainder of a battle win the
   * inventory card under-counts, booked at settlement). Field name kept as
   * `battleRefund` for call-site stability; it carries both legs. The
   * later `voucher_redeemed` redemption of the excess voucher is NEUTRAL,
   * so the win is counted exactly once (at settlement).
   */
  battleRefund: number;
  /**
   * Upgrader payout for the window. Source depends on
   * `UPGRADER_IN_LEDGER`: `upgrader_games.won_amount` (default, prod-
   * confirm pending) or `|upgrader_payout|` ledger rows (post-flip).
   * Pass 0 when upgrader is reported separately / out of scope.
   */
  upgraderPayout?: number;
};

/**
 * Total gaming payout returned to users over a window, per the verified
 * model:
 *
 *   gamingPayout = inventoryPayout (pack+battle cards kept)
 *                + ledger gaming-payout legs
 *                  (|battle_refund| + |battle_excess_to_voucher|)
 *                + upgraderPayout
 *
 * NEUTRAL conversions (card_sale, card_exchange, voucher_redeemed, …) are
 * intentionally NOT part of this — they are disposals of value the user
 * already owns, not game payouts (see `ledger-sets.ts` NEUTRAL_TYPES).
 */
export function gamingPayoutTotal(input: GamingPayoutInput): number {
  return (
    input.inventoryPayout +
    input.battleRefund +
    (input.upgraderPayout ?? 0)
  );
}

// ─── GGR ─────────────────────────────────────────────────────────────

export type GgrInput = {
  /** Σ wager over WAGER_TYPES (ABS'd), window + scope applied. */
  wager: number;
  /** Total gaming payout — see `gamingPayoutTotal`. */
  gamingPayout: number;
};

/**
 * Gross Gaming Revenue, house POV.
 *
 *   GGR = wager − gamingPayout
 *
 * GGR is GAMING-ONLY: reward/marketing giveaways do NOT reduce it (that's
 * NGR). NEUTRAL conversions are excluded from the payout side. Positive =
 * house up = 🟢.
 */
export function ggr(input: GgrInput): number {
  return input.wager - input.gamingPayout;
}

/**
 * Convenience: GGR straight from the raw legs, composing
 * `gamingPayoutTotal` for you.
 */
export function ggrFromLegs(input: {
  wager: number;
  inventoryPayout: number;
  battleRefund: number;
  upgraderPayout?: number;
}): number {
  return ggr({
    wager: input.wager,
    gamingPayout: gamingPayoutTotal({
      inventoryPayout: input.inventoryPayout,
      battleRefund: input.battleRefund,
      upgraderPayout: input.upgraderPayout,
    }),
  });
}

// ─── NGR ─────────────────────────────────────────────────────────────

/**
 * Rain is SYSTEM-AUTOMATIC and MIXED-funded: the platform auto-adds a base
 * to every rain pool (there is no funding account behind it — the system
 * tops the pool up to whatever it pays out beyond the user/founder tip
 * contributions), and users + founders also tip into the pool. So the full
 * `rain_win` magnitude is NOT a pure house cost: the slice that real users
 * (and founders) funded via `rain_tip` was never the house's money. The
 * NGR helper takes a `RainHouseCost` to resolve the HOUSE slice of rain
 * that should reduce NGR.
 *
 *   • `{ kind: "net", rainWinTotal, rainTipTotal }` — the OWNER-CONFIRMED
 *     model and the canonical default (see `queries.ts` `getWindowMetrics`):
 *     the house only funded the winnings beyond what tips covered, i.e.
 *
 *         rainHouseCost = max(0, Σ|rain_win| − Σ|rain_tip|)
 *
 *     `rain_tip` is the user/founder contribution; the house auto-added the
 *     remainder, so only that remainder is a house reward cost. `rain_tip`
 *     itself is RESIDUAL (a transfer, not a reward) — see `ledger-sets.ts`.
 *   • `{ kind: "amount", houseCost }` — caller already computed the house
 *     slice (e.g. from a more precise prod funding signal) and passes the
 *     dollar figure directly.
 *   • `{ kind: "fraction", fraction, rainWinTotal }` — apply a fraction
 *     of total `rain_win` as house cost (0..1).
 *   • `{ kind: "full", rainWinTotal }` — treat ALL of `rain_win` as house
 *     cost. The CONSERVATIVE upper bound (overstates cost), kept available
 *     for surfaces that deliberately want the worst-case rain figure; it is
 *     no longer the default now that the net model is owner-confirmed.
 */
export type RainHouseCost =
  | { kind: "net"; rainWinTotal: number; rainTipTotal: number }
  | { kind: "amount"; houseCost: number }
  | { kind: "fraction"; fraction: number; rainWinTotal: number }
  | { kind: "full"; rainWinTotal: number };

/**
 * Resolve the house-funded slice of rain cost from a `RainHouseCost`.
 *
 * Every branch is clamped at ≥ 0: rain can never be NEGATIVE house cost
 * (tips exceeding winnings do not make rain a house profit — the surplus
 * tip is residual, handled elsewhere), so `net` floors at 0 just like the
 * owner-confirmed formula `max(0, Σ|rain_win| − Σ|rain_tip|)`.
 */
export function resolveRainHouseCost(cost: RainHouseCost): number {
  switch (cost.kind) {
    case "net":
      return Math.max(0, cost.rainWinTotal - cost.rainTipTotal);
    case "amount":
      return Math.max(0, cost.houseCost);
    case "fraction":
      return (
        Math.max(0, Math.min(1, cost.fraction)) *
        Math.max(0, cost.rainWinTotal)
      );
    case "full":
      return Math.max(0, cost.rainWinTotal);
  }
}

export type NgrInput = {
  /** GGR (gaming-only), house POV. */
  ggr: number;
  /**
   * Σ over REWARD_PAYOUT_TYPES EXCLUDING `rain_win` — the reward/marketing
   * cost that is unambiguously house-funded ($-for-$). Rain is handled
   * separately via `rainHouseCost` because it is mixed-funded.
   *
   * `creator_tip` is NOT part of this (it is a RESIDUAL pass-through, not
   * a reward cost). `affiliate_leaderboard_prize` IS part of this.
   */
  rewardCostExclRain: number;
  /**
   * House slice of rain cost — see `RainHouseCost`. Defaults to 0 (no
   * rain cost) if omitted; pass a value to include rain in NGR. The
   * canonical query layer (`queries.ts` `getWindowMetrics`) supplies
   * `{ kind: "net", … }` (the owner-confirmed `max(0, rain_win − rain_tip)`
   * model) by default.
   */
  rainHouseCost?: RainHouseCost;
};

/**
 * Net Gaming Revenue, house POV — GGR net of house-funded reward spend.
 *
 *   NGR = GGR − rewardCostExclRain − resolveRainHouseCost(rainHouseCost)
 *
 * Positive = house up after giveaways = 🟢.
 */
export function ngr(input: NgrInput): number {
  const rain = input.rainHouseCost
    ? resolveRainHouseCost(input.rainHouseCost)
    : 0;
  return input.ggr - input.rewardCostExclRain - rain;
}

// ─── RTP / House edge (empirical, sample-guarded) ────────────────────

/**
 * `null` is the "insufficient sample" sentinel returned by the empirical
 * RTP/edge helpers when `bets < MIN_SAMPLE`. Callers render it as
 * "n/a — insufficient sample" rather than a misleading percentage.
 */
export type EmpiricalRatio = number | null;

/**
 * Empirical Return-To-Player as a 0..1 fraction.
 *
 *   RTP = gamingPayout / wager
 *
 * Gated on sample size: returns `null` when `bets < MIN_SAMPLE` (the
 * −14.92% / 114.92% upgrader and >100% pack figures were small-sample
 * variance, not formula bugs — M7/M8). Also returns `null` when wager is
 * 0 (RTP undefined).
 *
 * NOTE: this is the EMPIRICAL/observed RTP from realized wager+payout.
 * THEORETICAL RTP (from pool composition) lives in `math.ts` and needs no
 * sample guard.
 */
export function empiricalRtp(input: {
  gamingPayout: number;
  wager: number;
  bets: number;
}): EmpiricalRatio {
  if (input.bets < MIN_SAMPLE) return null;
  if (input.wager <= 0) return null;
  return input.gamingPayout / input.wager;
}

/**
 * Empirical house edge as a 0..1 fraction (can be negative if a bucket
 * paid out more than it took in over the sample).
 *
 *   houseEdge = 1 − RTP = GGR / wager
 *
 * Same sample guard as `empiricalRtp` (returns `null` below MIN_SAMPLE or
 * when wager is 0). Equivalent expression — both are provided so a caller
 * with GGR in hand and a caller with payout in hand each have a direct
 * route; they agree by construction (`ggr = wager − gamingPayout`).
 */
export function empiricalHouseEdge(input: {
  wager: number;
  gamingPayout?: number;
  ggr?: number;
  bets: number;
}): EmpiricalRatio {
  if (input.bets < MIN_SAMPLE) return null;
  if (input.wager <= 0) return null;
  const ggrValue =
    input.ggr ?? input.wager - (input.gamingPayout ?? 0);
  return ggrValue / input.wager;
}
