/**
 * Canonical sets of ledger transaction types used by GGR-style aggregates.
 *
 * Pre-existing dashboard.ts and creators-pnl.ts each kept their own
 * inline list. They drifted: the dashboard's payout list included
 * `withdrawal_shipping_fee`, `card_sale`, `reward_card_sale`,
 * `card_exchange`, `exchange_excess_credit`, `exchange_excess_to_voucher`,
 * `battle_excess_to_voucher`, plus `voucher_redeemed` /
 * `voucher_exchange`. The creator-PnL list was a strict subset. Result:
 * the same user's wagers contributed differently to the global GGR
 * vs. the per-creator GGR for that user — making the two surfaces
 * impossible to reconcile.
 *
 * Default behaviour: align them. Per-creator GGR uses the same payout
 * set as the dashboard's gross gaming revenue. If a future divergence is
 * intentional, declare it here as a separate constant rather than letting
 * each call site drift its own way.
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
  "withdrawal_shipping_fee",
] as const;

/**
 * Payout-side ledger types — money flowing back to the user (winnings,
 * refunds, prizes, redemptions, claims). Subtracted from wagers to
 * compute GGR.
 */
export const WAGER_PAYOUT_PAYOUT_TYPES = [
  "battle_refund",
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
