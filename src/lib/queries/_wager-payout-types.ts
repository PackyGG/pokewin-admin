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
 *
 * ─── GGR / NGR split (2026-06-01) ────────────────────────────────────
 * The dashboard splits its payout side into two buckets:
 *
 *   1. GGR_PAYOUT_TYPES — gaming returns. Same-round battle / upgrader
 *      settlements PLUS the four card-disposal types that mirror the
 *      "cards-won" payout for pack and battle wagers
 *      (card_sale / reward_card_sale / card_exchange /
 *      exchange_excess_credit). Without these, pack_opening +
 *      battle_bet wager volume has no corresponding payout in GGR and
 *      the headline overshoots wildly. They're time-shifted vs. the
 *      original wager (a Day-1 pack obtained card can be sold on
 *      Day 7), but until we compute synthetic cards-won credits at
 *      pack-open time from user_inventory.value_at_obtained (PROPOSED
 *      follow-up), they're the only payout we have for the inventory
 *      side of those wagers and must stay in GGR.
 *
 *   2. BONUS_PAYOUT_TYPES — promo / rakeback / voucher / rain / race /
 *      creator-tip costs. NOT gameplay returns; they're marketing and
 *      retention spend. Own aggregate, feeds NGR only.
 *
 * The dashboard reports:
 *   ggr = SUM(wagers) − SUM(GGR_PAYOUT_TYPES)   // gaming margin
 *   ngr = ggr        − SUM(BONUS_PAYOUT_TYPES)  // after promo cost
 *
 * The legacy `WAGER_PAYOUT_PAYOUT_TYPES` is kept as the UNION of both
 * partitions so any future surface that wants the old "everything
 * subtracted" shape has a single name for it and the partition stays
 * the source of truth.
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
 * Gaming payout-side ledger types — gameplay returns that subtract
 * from wagers in the GGR aggregate.
 *
 *  - battle_refund        — battle winner credit (peer-to-peer settle;
 *                           battle_bet + battle_sponsorship on the
 *                           wager side, battle_refund on the payout
 *                           side, net-zero across both legs).
 *  - upgrader_payout      — upgrader cash-out on a winning roll.
 *  - card_sale            — user sold a pack-/battle-won card back for
 *                           USD. Time-shifted vs. the original wager
 *                           (the card was obtained earlier), but the
 *                           only payout we have for pack / battle
 *                           inventory wins until synthetic
 *                           cards-won-at-pack-open credits land.
 *  - reward_card_sale     — same as card_sale for reward-issued cards.
 *  - card_exchange        — user exchanged inventory for a different
 *                           card (the credit leg of the exchange).
 *  - exchange_excess_credit — leftover USD credit from a card exchange.
 *
 * Anything that is NOT a gameplay return — promos, rakeback, voucher
 * redemptions, rain / race / leaderboard prizes, affiliate claims,
 * creator tips — lives in BONUS_PAYOUT_TYPES and feeds NGR, not GGR.
 *
 * Long-term PROPOSED follow-up: compute synthetic cards-won payouts at
 * pack-opening time via a JOIN on user_inventory.value_at_obtained.
 * That would let GGR book the inventory's spot value at wager time
 * (matching slot-pull convention) and remove the time-shift between
 * today's cashouts and today's wagers. Heavy query — not in scope yet.
 */
export const GGR_PAYOUT_TYPES = [
  "battle_refund",
  "upgrader_payout",
  "card_sale",
  "reward_card_sale",
  "card_exchange",
  "exchange_excess_credit",
] as const;

/**
 * BONUS / promo payout-side ledger types — costs the house incurs for
 * marketing / retention / loyalty surfaces, NOT gaming returns. These
 * fall under NGR (Net Gaming Revenue = GGR − bonus costs), not GGR.
 *
 *  - deposit_bonus            — bonus credited alongside a deposit
 *  - race_prize               — race / tournament prize
 *  - gift_card_redeemed       — user redeemed a gift card
 *  - promo_code_redeemed      — user redeemed a promo code
 *  - rakeback_claim           — user claimed rakeback rewards
 *  - balance_reward_claim     — user claimed a balance reward
 *  - affiliate_claim          — affiliate earnings paid out
 *  - rain_win                 — user won a rain pool
 *  - waitlist_prize           — waitlist conversion prize
 *  - creator_tip              — credit received via creator-tip surface
 *  - voucher_redeemed         — user redeemed a voucher for balance
 *  - voucher_exchange         — voucher converted to inventory
 *  - exchange_excess_to_voucher — exchange residue paid out as voucher
 *  - battle_excess_to_voucher   — battle residue paid out as voucher
 */
export const BONUS_PAYOUT_TYPES = [
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
 * Legacy union — every payout type the dashboard used to subtract from
 * GGR before the GGR / NGR split. Equal to
 * GGR_PAYOUT_TYPES ∪ BONUS_PAYOUT_TYPES, so the two partition the old
 * list completely. New code should pick the explicit slice it needs;
 * this union is exported for any cross-file consumer that still wants
 * the legacy shape.
 */
export const WAGER_PAYOUT_PAYOUT_TYPES = [
  ...GGR_PAYOUT_TYPES,
  ...BONUS_PAYOUT_TYPES,
] as const;

/**
 * SQL fragments — pre-quoted comma-separated lists for direct interpolation
 * into raw queries. The values are hardcoded ledger-type strings (no
 * external input), so injection is structurally impossible.
 */
export const WAGER_TYPES_SQL = `(${WAGER_PAYOUT_WAGER_TYPES.map((t) => `'${t}'`).join(",")})`;
export const GGR_PAYOUT_TYPES_SQL = `(${GGR_PAYOUT_TYPES.map((t) => `'${t}'`).join(",")})`;
export const BONUS_PAYOUT_TYPES_SQL = `(${BONUS_PAYOUT_TYPES.map((t) => `'${t}'`).join(",")})`;
/** Legacy union SQL fragment — kept for any consumer still reading the unsplit list. */
export const PAYOUT_TYPES_SQL = `(${WAGER_PAYOUT_PAYOUT_TYPES.map((t) => `'${t}'`).join(",")})`;
