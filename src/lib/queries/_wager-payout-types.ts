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
 * ─── GGR vs NGR split (2026-06-01) ───────────────────────────────────
 * The original `WAGER_PAYOUT_PAYOUT_TYPES` lumped pure gaming payouts
 * (battle wins, upgrader wins, card cashouts) together with
 * bonus / promo / rakeback costs (deposit bonuses, voucher redemptions,
 * rain prizes, rakeback claims, etc.). Under the industry-standard
 * definition that is NGR territory — GGR should only net wager against
 * gaming-side returns. Merging the two surfaced a "GGR" headline that
 * dragged negative whenever bonus volume spiked, even when pure gaming
 * margin was positive (e.g. the dashboard's -$128k 24h drift after
 * commit e213b75 fixed the unrelated upgrader double-count).
 *
 * The two arrays below partition the payout set so the dashboard can
 * expose:
 *   ggr  = SUM(wagers) − SUM(GGR_PAYOUT_TYPES)         // pure gaming margin
 *   ngr  = ggr        − SUM(BONUS_PAYOUT_TYPES)        // after promo costs
 *
 * The legacy `WAGER_PAYOUT_PAYOUT_TYPES` is kept as the UNION of both
 * lists so any future surface that wants the old "everything subtracted"
 * shape has a single name for it and the partition stays the source of
 * truth.
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
 * GAMING payout-side ledger types — wins and inventory cashouts that
 * settle a real gameplay round. These are the legitimate GGR-subtractors:
 * money the house had to return because of how a wager played out.
 *
 *  - battle_refund        — battle winner credit
 *  - upgrader_payout      — upgrader cash-out
 *  - card_sale            — user sold a card back for USD
 *  - reward_card_sale     — user sold a reward-issued card back for USD
 *  - card_exchange        — user exchanged inventory for a different card
 *  - exchange_excess_credit — leftover USD credit from a card exchange
 *
 * Anything that is NOT the direct return on a gameplay round — promos,
 * rakeback, voucher redemptions, rain/race/leaderboard prizes,
 * affiliate claims, creator tips — belongs in BONUS_PAYOUT_TYPES.
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
 * GGR before the GGR/NGR split. Equal to GGR_PAYOUT_TYPES ∪
 * BONUS_PAYOUT_TYPES, so the two partition the old list completely. New
 * code should pick the explicit half it needs; this union is exported
 * for any cross-file consumer that still wants the legacy shape.
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
