/**
 * House-perspective coloring for ledger transactions.
 *
 * The one rule (CLAUDE.md, "Finanz-Farben IMMER aus House-Perspektive"):
 *   User gains money     → HOUSE LOSS → rose
 *   User loses money     → HOUSE GAIN → emerald
 *   Neutral / info event → blue
 *
 * Mirrors `classifyLedgerKind` in `src/lib/queries/dashboard-live.ts` so the
 * Recent Activity feed and any other ledger-row UI stay in sync. Kept in a
 * shared util so transaction tables, timelines, audit pages and other
 * consumers never re-derive the mapping (which is exactly how the colors
 * drifted out of spec in the first place).
 */
export type LedgerDirection = "house-gain" | "house-loss" | "neutral";

/**
 * Classify a raw ledger `type` string into its house-perspective direction.
 * Unknown types default to "house-loss" so new payout-shaped events stay
 * visually flagged as red until a mapping is added explicitly — matches the
 * defensive default in dashboard-live's classifier.
 */
export function ledgerDirection(type: string): LedgerDirection {
  switch (type) {
    // ── House receives money from the user (balance shrinks, cash/
    // commitment flows into our coffers). ────────────────────────────
    case "deposit":
    case "deposit_bonus": // bonus shown next to its parent deposit row
    case "pack_opening":
    case "battle_bet":
    case "battle_sponsorship":
    case "vault_lock":
    case "withdrawal_shipping_fee":
    // User spends their own (withdrawable) balance to buy XP — balance
    // shrinks, value flows to us. From the house POV every dollar the user
    // gives up is a dollar we no longer owe → a house gain → emerald.
    case "xp_purchase":
      return "house-gain";

    // ── House pays money to the user (balance grows, a liability we
    // already owed is being settled out). ────────────────────────────
    case "card_withdrawal":
    case "balance_withdrawal": // cash leg of a crypto-balance withdrawal
    case "withdrawal":
    case "card_sale": // user sells card back → we credit them USD
    case "reward_card_sale":
    case "card_exchange":
    case "voucher_exchange":
    case "exchange_excess_credit":
    case "exchange_excess_to_voucher":
    case "battle_excess_to_voucher":
    case "battle_refund":
    case "rain_win":
    case "race_prize":
    case "challenge_prize": // user won + claimed a challenge prize → we pay it
    case "creator_tip":
    case "rakeback_claim":
    case "affiliate_claim":
    case "affiliate_leaderboard_prize": // creator-leaderboard win paid to user
    case "admin_balance_adjustment":
    case "balance_reward_claim":
    case "waitlist_prize":
    case "gift_card_redeemed":
    case "promo_code_redeemed":
    case "voucher_redeemed":
    case "vault_unlock":
      return "house-loss";

    // ── Non-monetary signals ──────────────────────────────────────────
    case "signup":
      return "neutral";

    default:
      return "house-loss";
  }
}

/**
 * Tailwind classes for the amount color of a ledger row. Kept as strings
 * (not a function returning `clsx(...)`) so the emitted CSS is JIT-friendly
 * and every call site ends up with the literal classes in the output.
 */
export function amountColorFor(direction: LedgerDirection): string {
  switch (direction) {
    case "house-gain":
      return "text-emerald-600 dark:text-emerald-400";
    case "house-loss":
      return "text-rose-600 dark:text-rose-400";
    case "neutral":
      return "text-blue-600 dark:text-blue-400";
  }
}

/** Sign for the amount from the house perspective. */
export function amountSignFor(direction: LedgerDirection): "+" | "-" | "" {
  switch (direction) {
    case "house-gain":
      return "+";
    case "house-loss":
      return "-";
    case "neutral":
      return "";
  }
}

/**
 * Sign for the amount from the USER's actual balance movement.
 *
 * The Amount must never contradict the Balance Before/After shown right next
 * to it: a row that CREDITS the user (balance goes up) reads "+", a row that
 * DEBITS the user (balance goes down) reads "−", and a balance-neutral leg
 * (card/voucher legs whose cash delta is $0 — e.g. card_withdrawal,
 * battle_refund's voucher leg) gets no sign. This is independent of the
 * house-perspective COLOR (`amountColorFor(ledgerDirection(type))`): a
 * rakeback claim CREDITS the user (+$X) yet is a house loss → still rose.
 *
 * Why this exists: signing the Amount off `ledgerDirection` (house POV) made
 * a rakeback_claim render as "−$64.93" even though the balance rose to
 * +$64.93 — the sign fought the adjacent Balance fields. The balance delta is
 * the single unambiguous source of truth for the SIGN.
 *
 * `before`/`after` are the cash balance at the row (Decimal already coerced to
 * number). A tiny epsilon guards against float dust so a true $0 delta reads
 * as neutral, not a spurious ±.
 */
export function balanceMovementSign(
  before: number,
  after: number,
): "+" | "-" | "" {
  return balanceDeltaSign(after - before);
}

/**
 * Sign for an already-computed signed balance delta (`balanceAfter −
 * balanceBefore`). Same contract as {@link balanceMovementSign} — used where
 * the caller holds the delta directly rather than the before/after pair (e.g.
 * the related-transactions mini-list, whose rows carry only the delta). The
 * 0.005 epsilon swallows float dust so a true $0 (balance-neutral) leg reads
 * as neutral, not a spurious ±.
 */
export function balanceDeltaSign(delta: number): "+" | "-" | "" {
  if (delta > 0.005) return "+";
  if (delta < -0.005) return "-";
  return "";
}
