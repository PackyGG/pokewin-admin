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
 * ─── GGR / Inventory cashout / NGR split (2026-06-01) ────────────────
 * The dashboard's GGR aggregate now follows the industry-standard
 * narrow definition: PURE GAMING MARGIN ONLY. That means the payout
 * side of GGR is restricted to gameplay returns that settle in the
 * SAME moment as the wager — i.e. `battle_refund` and
 * `upgrader_payout`. Every other "credit-to-the-user" payout type is
 * filed under one of two sibling buckets:
 *
 *   1. INVENTORY_CASHOUT_TYPES — card sales, card exchanges, exchange
 *      excess credit. These are TIME-SHIFTED settlements: a user opens
 *      a $5 pack on Day 1 (debits pack_opening) and receives a card
 *      with value $X (NOT in the ledger — sits in user_inventory).
 *      On Day 7 they sell the card → `card_sale: +$X`. Summing today's
 *      `card_sale` against today's `pack_opening` overstates the
 *      house's "loss" on a busy cashout day, because today's sales
 *      correspond to a different day's wagers. Real casinos book the
 *      card-value-won at pack-opening time as a synthetic payout to
 *      avoid this drift. Until we do that (PROPOSED follow-up: JOIN
 *      pack_opening → cards.price at obtain time), the cleanest fix is
 *      to STOP counting inventory cashouts as gaming payouts. They
 *      get their own aggregate and feed NGR.
 *
 *   2. BONUS_PAYOUT_TYPES — promo / rakeback / voucher / rain / race
 *      / creator-tip costs. NOT gameplay returns; they're marketing
 *      and retention spend. Same treatment: own aggregate, feeds NGR.
 *
 * The dashboard now reports:
 *   ggr  = SUM(wagers) − SUM(GGR_PAYOUT_TYPES)                          // pure gaming margin
 *   ngr  = ggr        − SUM(INVENTORY_CASHOUT_TYPES) − SUM(BONUS_PAYOUT_TYPES)
 *
 * Important consequence to remember: pack_opening wager volume no
 * longer has a corresponding payout in the GGR aggregate (we removed
 * `card_sale` and friends, but never replaced them with a synthetic
 * cards-won credit at pack-open time). For pack-heavy windows the
 * headline GGR will look INFLATED relative to the eventual NGR. That's
 * the same trade brick-and-mortar casinos make: book the wager as
 * revenue, book the chip / card inventory liability separately. Until
 * the PROPOSED cards-won-at-pack-open computation lands, GGR is
 * "gaming margin from settled wins" and NGR is the closer figure to
 * "what the house keeps net of inventory cashouts and promo spend".
 *
 * DO NOT add card_sale / reward_card_sale / card_exchange /
 * exchange_excess_credit / deposit_bonus / promo_code_redeemed / any
 * voucher or rakeback type back into `GGR_PAYOUT_TYPES`. They each
 * have a permanent home in INVENTORY_CASHOUT_TYPES or
 * BONUS_PAYOUT_TYPES — extend the right sibling array instead.
 *
 * The legacy `WAGER_PAYOUT_PAYOUT_TYPES` is kept as the UNION of all
 * three partitions so any future surface that wants the old
 * "everything subtracted" shape has a single name for it and the
 * partition stays the source of truth.
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
 * PURE GAMING payout-side ledger types — wins that settle at the
 * moment the wager resolves. These are the ONLY legitimate
 * GGR-subtractors (industry-standard gross gaming revenue): money the
 * house had to return because of how a wager played out in the SAME
 * round.
 *
 *  - battle_refund        — battle winner credit (peer-to-peer settle;
 *                           battle_bet + battle_sponsorship on the
 *                           wager side, battle_refund on the payout
 *                           side, net-zero across both legs).
 *  - upgrader_payout      — upgrader cash-out on a winning roll.
 *
 * Anything that is NOT a same-round gameplay return — card cashouts
 * (time-shifted vs. the original pack open), promos, rakeback, voucher
 * redemptions, rain / race / leaderboard prizes, affiliate claims,
 * creator tips — does NOT belong here. Card cashouts live in
 * INVENTORY_CASHOUT_TYPES; everything else lives in
 * BONUS_PAYOUT_TYPES. Both are subtracted by NGR, not GGR.
 *
 * If you find yourself wanting to add a new type here: it must be a
 * ledger credit issued in the same transaction-of-play as the wager
 * (e.g. a future provably-fair instant-resolve game's payout). If
 * there's any time-shift between the wager and the credit, it goes in
 * INVENTORY_CASHOUT_TYPES. If it's a promo / marketing surface, it
 * goes in BONUS_PAYOUT_TYPES.
 */
export const GGR_PAYOUT_TYPES = [
  "battle_refund",
  "upgrader_payout",
] as const;

/**
 * INVENTORY CASHOUT payout-side ledger types — credits from a user
 * disposing of a previously-obtained inventory item (or excess credit
 * from such a disposal). NOT a same-round gameplay return; the card
 * was obtained from a pack / battle on an earlier day and is being
 * cashed out NOW. Counting these as GGR-subtractors creates a
 * time-mismatch where today's `card_sale` volume drags against today's
 * `pack_opening` volume even though they're settling different wagers.
 *
 * These fall under NGR (Net Gaming Revenue) — the "after inventory
 * cashout and promo cost" headline — not GGR.
 *
 *  - card_sale              — user sold a card back for USD
 *  - reward_card_sale       — user sold a reward-issued card back for
 *                             USD
 *  - card_exchange          — user exchanged inventory for a different
 *                             card (the credit leg of the exchange)
 *  - exchange_excess_credit — leftover USD credit from a card exchange
 *
 * Long-term fix: compute `cards_won_from_packs` at pack-opening time
 * via a JOIN on user_inventory.value_at_obtained for source_type =
 * 'pack' / 'battle'. That would let GGR book the inventory's spot
 * value at wager time (matching slot-pull convention) and remove the
 * need for this bucket entirely. Heavy query — flagged as PROPOSED.
 */
export const INVENTORY_CASHOUT_TYPES = [
  "card_sale",
  "reward_card_sale",
  "card_exchange",
  "exchange_excess_credit",
] as const;

/**
 * BONUS / promo payout-side ledger types — costs the house incurs for
 * marketing / retention / loyalty surfaces, NOT gaming returns. These
 * fall under NGR (Net Gaming Revenue = GGR − inventory cashout −
 * bonus costs), not GGR.
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
 * GGR before the GGR / INVENTORY_CASHOUT / NGR split. Equal to
 * GGR_PAYOUT_TYPES ∪ INVENTORY_CASHOUT_TYPES ∪ BONUS_PAYOUT_TYPES, so
 * the three partition the old list completely. New code should pick
 * the explicit slice it needs; this union is exported for any
 * cross-file consumer that still wants the legacy shape.
 */
export const WAGER_PAYOUT_PAYOUT_TYPES = [
  ...GGR_PAYOUT_TYPES,
  ...INVENTORY_CASHOUT_TYPES,
  ...BONUS_PAYOUT_TYPES,
] as const;

/**
 * SQL fragments — pre-quoted comma-separated lists for direct interpolation
 * into raw queries. The values are hardcoded ledger-type strings (no
 * external input), so injection is structurally impossible.
 */
export const WAGER_TYPES_SQL = `(${WAGER_PAYOUT_WAGER_TYPES.map((t) => `'${t}'`).join(",")})`;
export const GGR_PAYOUT_TYPES_SQL = `(${GGR_PAYOUT_TYPES.map((t) => `'${t}'`).join(",")})`;
export const INVENTORY_CASHOUT_TYPES_SQL = `(${INVENTORY_CASHOUT_TYPES.map((t) => `'${t}'`).join(",")})`;
export const BONUS_PAYOUT_TYPES_SQL = `(${BONUS_PAYOUT_TYPES.map((t) => `'${t}'`).join(",")})`;
/** Legacy union SQL fragment — kept for any consumer still reading the unsplit list. */
export const PAYOUT_TYPES_SQL = `(${WAGER_PAYOUT_PAYOUT_TYPES.map((t) => `'${t}'`).join(",")})`;
