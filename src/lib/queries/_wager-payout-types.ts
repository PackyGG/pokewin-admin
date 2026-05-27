/**
 * Canonical sets of ledger transaction types used by GGR-style aggregates.
 *
 * dashboard.ts previously inlined these lists (repeated across every
 * period branch). They're centralized here so the gross-gaming-revenue
 * definition lives in one place and can't drift between dashboard call
 * sites.
 *
 * IMPORTANT — not every GGR surface shares this set:
 *  - creators-pnl.ts computes per-creator GGR from
 *    `affiliate_code_usages.wager_amount_usd`, NOT from these ledger
 *    types — a different mechanism, intentionally not coupled here.
 *  - analytics.ts / analytics-cohorts.ts use their own smaller payout
 *    lists (a known divergence pending a product decision).
 * Don't assume importing these constants makes a surface match the
 * dashboard's GGR; only dashboard.ts is wired to them today.
 */

/**
 * Wager-side ledger types — money the user puts at risk. ABS()'d in queries
 * because user-side ledger amounts are stored negative for debits.
 *
 * `withdrawal_shipping_fee` is included on the wager side (per dashboard.ts
 * lines 96-138) — it's revenue captured from the user when shipping costs
 * are deducted from the withdrawal amount.
 */
export const WAGER_PAYOUT_WAGER_TYPES = [
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  "upgrader_bet",
  "withdrawal_shipping_fee",
] as const;

/**
 * Payout-side ledger types — money flowing back to the user (winnings,
 * refunds, prizes, redemptions, claims). Subtracted from wagers to
 * compute GGR.
 */
export const WAGER_PAYOUT_PAYOUT_TYPES = [
  "battle_refund",
  "upgrader_payout",
  "card_sale",
  "reward_card_sale",
  "card_exchange",
  "exchange_excess_credit",
  "deposit_bonus",
  "race_prize",
  "gift_card_redeemed",
  "promo_code_redeemed",
  "rakeback_claim",
  "balance_reward_claim",
  "affiliate_claim",
  "rain_win",
  "waitlist_prize",
  "creator_tip",
  "voucher_redeemed",
  "voucher_exchange",
  "exchange_excess_to_voucher",
  "battle_excess_to_voucher",
] as const;

/**
 * SQL fragments — pre-quoted comma-separated lists for direct interpolation
 * into raw queries. The values are hardcoded ledger-type strings (no
 * external input), so injection is structurally impossible.
 */
export const WAGER_TYPES_SQL = `(${WAGER_PAYOUT_WAGER_TYPES.map((t) => `'${t}'`).join(",")})`;
export const PAYOUT_TYPES_SQL = `(${WAGER_PAYOUT_PAYOUT_TYPES.map((t) => `'${t}'`).join(",")})`;
