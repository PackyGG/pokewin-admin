/**
 * Human-readable label + description for every ledger transaction type
 * that participates in the headline GGR formula.
 *
 * Keys MUST be the raw `ledger_transactions.type` string the SQL writes
 * (e.g. "pack_opening", "battle_refund") so the map can be indexed
 * directly with rows returned by `getGgrBreakdown`. Same set the
 * canonical type lists in `_wager-payout-types.ts` enforce — keep this
 * file in sync whenever a new GGR ledger type is added there.
 *
 * `label` is the title-cased name shown on the per-type card on the
 * `/ggr` page. `description` is the 1–2 sentence explanation rendered
 * below the hero number. Wording is house-perspective consistent with
 * CLAUDE.md (User gewinnt → rot, User verliert → grün) — descriptions
 * describe the USER's action so the colour intent stays unambiguous.
 *
 * Lookup helper falls back to a humanised version of the raw type
 * (snake_case → Title Case) and an empty description, so an unknown
 * key on the page never throws.
 */

export type LedgerTypeDescription = {
  label: string;
  description: string;
};

export const LEDGER_TYPE_DESCRIPTIONS: Record<string, LedgerTypeDescription> = {
  // ── Wagers ──────────────────────────────────────────────────────
  pack_opening: {
    label: "Pack Opening",
    description:
      "User pays for a pack and receives a random card. The pack cost is the wager; the card lands in inventory.",
  },
  battle_bet: {
    label: "Battle Bet",
    description:
      "User bets into a battle pool. Winner takes the entire pool.",
  },
  battle_sponsorship: {
    label: "Battle Sponsorship",
    description:
      "Creator adds money to a battle pool out of their own balance. Boosts the prize without changing the bet of other participants.",
  },
  upgrader_bet: {
    label: "Upgrader Bet",
    description:
      "User wagers money on the upgrader for a chance at a target multiplier. House edge is built into the win/lose probability.",
  },
  withdrawal_shipping_fee: {
    label: "Withdrawal Shipping Fee",
    description:
      "Flat fee paid by the user to ship physical cards from their inventory. Counted as wager because it reduces user balance.",
  },

  // ── Payouts ─────────────────────────────────────────────────────
  battle_refund: {
    label: "Battle Refund",
    description:
      "Battle winner's payout — total of losers' bets + any sponsorship. Net-zero against battle_bet + battle_sponsorship for a balanced battle.",
  },
  upgrader_payout: {
    label: "Upgrader Payout",
    description:
      "User won the upgrader. Payout is bet × target multiplier.",
  },
  card_sale: {
    label: "Card Sale",
    description:
      "User sold a card back to the house for balance credit. The sale price reflects the card's current spot value.",
  },
  reward_card_sale: {
    label: "Reward Card Sale",
    description:
      "User sold a card received as a reward (not opened from a pack).",
  },
  card_exchange: {
    label: "Card Exchange",
    description:
      "User exchanged cards via the exchange system. Net debit/credit settles on balance.",
  },
  exchange_excess_credit: {
    label: "Exchange Excess Credit",
    description:
      "Leftover balance credit when an exchange isn't perfectly even.",
  },
  deposit_bonus: {
    label: "Deposit Bonus",
    description:
      "First-deposit or matched-deposit bonus granted to user balance. Pure marketing cost.",
  },
  rakeback_claim: {
    label: "Rakeback Claim",
    description:
      "Rakeback rewards claimed by user. Percentage of wager volume returned as balance credit.",
  },
  promo_code_redeemed: {
    label: "Promo Code Redeemed",
    description:
      "Promo code value redeemed (admin-issued or marketing-issued code).",
  },
  gift_card_redeemed: {
    label: "Gift Card Redeemed",
    description:
      "Gift card value redeemed (admin-issued physical/digital gift card).",
  },
  balance_reward_claim: {
    label: "Balance Reward Claim",
    description:
      "Daily / weekly / one-time balance reward claimed by user.",
  },
  affiliate_claim: {
    label: "Affiliate Claim",
    description:
      "Affiliate commission claimed by a creator from their referred users' activity.",
  },
  race_prize: {
    label: "Race Prize",
    description:
      "Wager race prize paid to a top-tier finisher.",
  },
  rain_win: {
    label: "Rain Win",
    description:
      "Rain event prize won (random distribution to entrants).",
  },
  waitlist_prize: {
    label: "Waitlist Prize",
    description:
      "Waitlist queue prize paid to a user.",
  },
  creator_tip: {
    label: "Creator Tip",
    description:
      "Tip from a user to a creator, routed through the platform.",
  },
  voucher_redeemed: {
    label: "Voucher Redeemed",
    description:
      "Voucher value claimed as balance credit.",
  },
  voucher_exchange: {
    label: "Voucher Exchange",
    description:
      "Voucher exchanged for cards or balance via the voucher system.",
  },
  exchange_excess_to_voucher: {
    label: "Exchange Excess to Voucher",
    description:
      "Excess from a card exchange routed to a new voucher instead of balance.",
  },
  battle_excess_to_voucher: {
    label: "Battle Excess to Voucher",
    description:
      "Excess from a battle (rounding remainder) routed to a new voucher.",
  },
};

/**
 * Resolve a ledger type to its label + description. Unknown keys fall
 * back to a humanised version of the raw type ("foo_bar" → "Foo Bar")
 * with an empty description. Defensive — the page renders rows
 * straight from the DB, so an unrecognised type should never throw.
 */
export function describeLedgerType(type: string): LedgerTypeDescription {
  const known = LEDGER_TYPE_DESCRIPTIONS[type];
  if (known) return known;
  // Humanise an unknown snake_case type as a fallback label so the UI
  // still reads cleanly while the new type's description is being added
  // here.
  const label = type
    .split("_")
    .map((p) => (p.length === 0 ? p : p[0].toUpperCase() + p.slice(1)))
    .join(" ");
  return { label, description: "" };
}
