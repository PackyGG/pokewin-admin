/**
 * ledger-sets.ts — the SINGLE canonical partition of every
 * `ledger_transaction_type` enum member into exactly one metric bucket.
 *
 * This is the WIRED, canonical partition — the live source of truth for
 * which ledger types are wager / fee / gaming-payout / neutral / reward /
 * residual. The SQL list helpers (`WAGER_TYPES_SQL`, `GAMING_PAYOUT_TYPES_SQL`,
 * `REWARD_PAYOUT_TYPES_SQL`, …) and the type sets are imported directly by
 * the dashboard, `/ggr`, the analytics surfaces, insights-analytics and
 * insights-games. Changing a member's bucket here changes GGR/NGR
 * everywhere — verify against the booking model below before editing.
 *
 * ─── THE VERIFIED BOOKING MODEL (ground truth) ──────────────────────
 *
 * A pack/battle open writes ONE ledger row = the gross stake
 * (`pack_opening` / `battle_bet` / `battle_sponsorship`, stored as a
 * positive magnitude debit). The WIN is NOT a ledger row at open — it is
 * recorded ONLY in `user_inventory.value_at_obtained`
 * (`source_type IN ('pack','battle')`, keyed by `obtained_at`). This is
 * "CASE (iii)": gross-in via ledger, win via inventory delta.
 *
 * Consequences that this partition encodes:
 *  • Card conversions (`card_sale`, `reward_card_sale`, `card_exchange`,
 *    excess-credit / voucher-exchange variants) are NEUTRAL
 *    inventory↔balance / voucher↔balance disposals — they move value the
 *    user already owns; they are NOT gaming payouts and must never be
 *    folded into the payout side of GGR. `voucher_redeemed` is likewise
 *    NEUTRAL (a voucher the user holds becomes balance), EXCEPT the
 *    per-row `metadata->>'origin'='manual'` carve-out (admin house-granted
 *    vouchers) which is REWARD_PAYOUT — see NEUTRAL_TYPES / REWARD_PAYOUT.
 *  • The DOMINANT pack/battle payout is the inventory delta, NOT a
 *    ledger type. The LEDGER-resident gaming payouts are `battle_refund`
 *    (a separate CASH winner leg on battles) and
 *    `battle_excess_to_voucher` (the voucher remainder of a battle win
 *    the inventory card under-counts — booked at settlement, completes
 *    the win), plus `upgrader_payout` IF AND ONLY IF prod writes it to
 *    the ledger (see UPGRADER note below — it is NOT in
 *    GAMING_PAYOUT_TYPES by default).
 *
 * This mirrors exactly what `src/lib/queries/pnl.ts` `getPackBattlePurePnl`
 * already implements (pnl.ts:749-945): wager from the ledger, payout from
 * `user_inventory`, borrow plays dropped on both sides.
 *
 * ─── ENUM SOURCE ────────────────────────────────────────────────────
 *
 * The full enum is `ledgerTransactionType` in the checked-in MAIN Drizzle schema.
 * — 53 members (the original 42 + 11 creator-multiplier / creator-
 * leaderboard legs profiled on prod 2026-06-11). This file is a
 * hand-maintained literal union built against the SCHEMA, not the
 * generated client, so a new prod enum member can be classified here
 * (via the `::text`-cast string membership the SQL helpers use) without
 * the generated application enum having to contain it yet. The compile-time
 * exhaustiveness check at the bottom
 * (`_EXHAUSTIVE`) fails the build if any enum member is added to the
 * schema-derived `LedgerTransactionType` union without being assigned to
 * exactly one set here — so a future migration that adds an enum member
 * cannot silently leave it unclassified.
 */

/**
 * The full `ledger_transaction_type` enum, as a literal union, in schema
 * order. Kept as a local literal (rather than importing the generated
 * generated enum) so this module stays a pure, dependency-light value layer
 * that the `__checks__` script and any client-safe consumer can import
 * without pulling the database client. The `_EXHAUSTIVE` guard below ties
 * it back to the partition so the two can never drift.
 */
export type LedgerTransactionType =
  | "deposit"
  | "pack_opening"
  | "battle_bet"
  | "battle_sponsorship"
  | "battle_refund"
  | "card_sale"
  | "reward_card_sale"
  | "card_exchange"
  | "exchange_excess_to_voucher"
  | "exchange_excess_credit"
  | "battle_excess_to_voucher"
  | "voucher_redeemed"
  | "voucher_exchange"
  | "deposit_bonus"
  | "vault_lock"
  | "vault_unlock"
  | "race_prize"
  | "gift_card_redeemed"
  | "promo_code_redeemed"
  | "rakeback_claim"
  | "balance_reward_claim"
  | "affiliate_claim"
  | "withdrawal_shipping_fee"
  | "admin_balance_adjustment"
  | "rain_tip"
  | "rain_win"
  | "creator_tip"
  | "waitlist_prize"
  | "pack_borrow_to_voucher"
  | "card_withdrawal"
  | "creator_deal_fill_grant"
  | "creator_fill_activation"
  | "creator_fill_spend_tip"
  | "creator_fill_spend_battle"
  | "creator_fill_refund"
  | "creator_fill_conversion"
  | "creator_fill_forfeiture"
  | "affiliate_leaderboard_creation"
  | "affiliate_leaderboard_refund"
  | "affiliate_leaderboard_prize"
  // Creator-multiplier deal + creator-leaderboard balance-sheet / escrow /
  // settlement legs (prod enum, confirmed 2026-06-11). All RESIDUAL — the
  // same family as `creator_fill_*` / `affiliate_leaderboard_*`. See
  // RESIDUAL_TYPES for the per-member reasoning.
  | "creator_multiplier_deposit_lock"
  | "creator_multiplier_deposit_topup"
  | "creator_multiplier_platform_credit"
  | "creator_multiplier_spend_wager"
  | "creator_multiplier_spend_tip"
  | "creator_multiplier_spend_battle"
  | "creator_multiplier_refund"
  | "creator_multiplier_settlement_payout"
  | "creator_multiplier_settlement_deposit_return"
  | "creator_multiplier_forfeiture"
  | "creator_lb_deposit"
  | "upgrader_bet"
  | "upgrader_payout"
  // Keno (prod enum, verified read-only 2026-07-22). UNLIKE upgrader, keno is
  // fully ON-ledger on both legs — keno.service.ts debits `keno_bet` on every
  // bet and credits `keno_payout` on every win — so they go straight onto the
  // active WAGER / GAMING_PAYOUT sets rather than being isolated behind a flag.
  // No `pnl.ts` balance-movement correction is needed for the same reason: the
  // win credit IS a ledger row, so `balance_after − balance_before` already
  // captures it.
  | "keno_bet"
  | "keno_payout";

// ─── WAGER ───────────────────────────────────────────────────────────

/**
 * WAGER_TYPES — real-money stake the user puts at risk on a game.
 *
 * Each of these is ONE ledger row per play, stored as a positive
 * magnitude debit (`ABS()` it in SQL). Sum of these = gross wager.
 *
 * `upgrader_bet` is deliberately NOT here — see the UPGRADER section.
 * `withdrawal_shipping_fee` is deliberately NOT here — it is revenue, not
 * a stake; it lives in `FEE_TYPES` so it can never be silently folded
 * into wager (resolves the M3 reconciliation gap where the dashboard
 * wager tile excluded the fee but the GGR wager leg included it).
 */
export const WAGER_TYPES = [
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  // Keno's stake leg. Safe to sit here (unlike `upgrader_bet`) because keno
  // writes BOTH legs to the ledger, so wager and payout stay symmetric — the
  // exact condition the upgrader isolation exists to avoid violating.
  // NOTE: this makes keno stake count toward headline wager/GGR for the first
  // time. Previously keno matched no set, so its revenue was invisible in
  // every GGR surface — not misattributed, just missing.
  "keno_bet",
] as const satisfies readonly LedgerTransactionType[];

// ─── FEE ─────────────────────────────────────────────────────────────

/**
 * FEE_TYPES — house revenue captured from the user that is NOT a game
 * stake. Today: the withdrawal shipping fee deducted when a card
 * withdrawal is shipped.
 *
 * Kept as its own set (not inside WAGER_TYPES) so a surface that wants
 * "stake placed on games" and a surface that wants "all revenue captured
 * from the user" can each be explicit. Folding it into wager is what
 * caused M3 (dashboard wager tile ≠ GGR wager leg). Whether a given GGR
 * surface adds fees to the wager side is then an explicit, single
 * decision at the call site — never an accident of the type list.
 */
export const FEE_TYPES = [
  "withdrawal_shipping_fee",
] as const satisfies readonly LedgerTransactionType[];

// ─── GAMING PAYOUT (ledger-resident only) ────────────────────────────

/**
 * GAMING_PAYOUT_TYPES — LEDGER rows that represent a game payout back to
 * the user.
 *
 * IMPORTANT: this set is small ON PURPOSE. Per the verified booking
 * model the DOMINANT pack/battle payout is NOT a ledger type — it is the
 * `user_inventory.value_at_obtained` delta (`source_type IN
 * ('pack','battle')`). The cash gaming-payout legs on the ledger are
 * `battle_refund` (the winner's cash leg on a battle; pack/battle wins
 * are otherwise cards) and `battle_excess_to_voucher` (see below).
 *
 * `battle_excess_to_voucher` is a GAMING_PAYOUT (reclassified from
 * NEUTRAL). It is the slice of a battle win the inventory card
 * UNDER-counts: a battle win's `expected_value = card_value +
 * voucher_value`, but the inventory row's `value_at_obtained` records
 * ONLY the card. The voucher remainder is booked at battle settlement as
 * `battle_excess_to_voucher`, so it COMPLETES the win and belongs on the
 * gaming payout side. It is counted ONCE here (at settlement); the later
 * `voucher_redeemed` redemption of that same voucher is therefore NEUTRAL
 * (see NEUTRAL_TYPES) — settlement and redemption are never both counted.
 *
 * Therefore the canonical gaming payout used by GGR is:
 *
 *   gamingPayout = Σ inventory.value_at_obtained[source='pack'|'battle']
 *                + Σ |battle_refund|
 *                + Σ |battle_excess_to_voucher|
 *                (+ upgrader payout, per the UPGRADER note)
 *
 * see `formulas.ts` `gamingPayoutTotal` and `queries.ts`
 * `getGamingLegs` / `getDailyGamingMetrics`. Do NOT add card_sale /
 * card_exchange here — those are NEUTRAL_TYPES (the M-series "card_sale
 * is 328k rows inside the payout side" divergence is resolved by keeping
 * them neutral).
 *
 * `upgrader_payout` is NOT here by default — see UPGRADER section.
 */
export const GAMING_PAYOUT_TYPES = [
  "battle_refund",
  "battle_excess_to_voucher",
  // Keno's win credit — the cash leg written by createKenoPayout. Pairs with
  // `keno_bet` in WAGER_TYPES so keno's GGR (stake − payout) reconciles the
  // same way battles do.
  "keno_payout",
] as const satisfies readonly LedgerTransactionType[];

// ─── NEUTRAL ─────────────────────────────────────────────────────────

/**
 * NEUTRAL_TYPES — inventory↔balance and voucher↔balance conversions of
 * value the user ALREADY owns. Net-neutral to GGR and NGR: they neither
 * stake money nor pay a game out; they just change the form value is held
 * in (a card becomes balance, a voucher becomes cards, rounding excess
 * becomes a voucher, etc.).
 *
 * These are EXCLUDED from the payout side of GGR — this partition is the
 * live canonical GGR's treatment of them (neutral). The legacy
 * dashboard-only set in `src/lib/queries/_wager-payout-types.ts`
 * (`WAGER_PAYOUT_PAYOUT_TYPES`) still folds most of them into ITS payout
 * side, but that is a separate, non-canonical "GGR" definition (closer to
 * NGR) — keeping `card_sale` (alone hundreds of thousands of rows) out of
 * the canonical payout side was the biggest single divergence the
 * canonical model fixed. They still appear in realized PnL via the
 * balance / inventory / voucher deltas — that is correct and intentional.
 *
 * `voucher_redeemed` is NEUTRAL (reclassified from REWARD_PAYOUT) — WITH A
 * PER-ROW CARVE-OUT. Redeeming a voucher just turns a voucher the user
 * already holds into balance; for vouchers PRODUCED BY GAMEPLAY (a battle
 * win's `battle_excess_to_voucher` remainder, a borrow remainder's
 * `pack_borrow_to_voucher`) the value was ALREADY booked when the voucher
 * was created — counting the redemption too would double-count. So
 * redemption is neutral.
 *
 * THE CARVE-OUT (implemented in SQL, NOT in this type partition, because
 * it is a per-ROW split, not a whole-type bucket): a `voucher_redeemed`
 * row whose `metadata->>'origin' = 'manual'` is an ADMIN HOUSE-GRANTED
 * voucher. Its ONLY ledger touchpoint is the redemption (there is no
 * earlier "grant" ledger row to book the cost against), so for those rows
 * the redemption IS the house cost and must be counted as REWARD_PAYOUT.
 * `queries.ts` `getRewardCost` / `getDailyGamingMetrics` add a
 * `type = 'voucher_redeemed' AND metadata->>'origin' = 'manual'` branch to
 * the reward-cost leg. Every OTHER `voucher_redeemed` row stays neutral
 * simply by NOT being summed into any gaming or reward leg (no explicit
 * complementary predicate is needed — neutrality is the default). The base
 * type bucket here is NEUTRAL (the common case); only the manual slice is
 * lifted into reward cost at the query layer.
 */
export const NEUTRAL_TYPES = [
  "card_sale",
  "reward_card_sale",
  "card_exchange",
  "exchange_excess_credit",
  "voucher_exchange",
  "exchange_excess_to_voucher",
  "voucher_redeemed",
] as const satisfies readonly LedgerTransactionType[];

// ─── REWARD PAYOUT ───────────────────────────────────────────────────

/**
 * REWARD_PAYOUT_TYPES — house-funded giveaways / retention spend. These
 * reduce NGR (NGR = GGR − Σ reward) but NOT GGR (GGR is gaming-only).
 *
 * `affiliate_leaderboard_prize` is INCLUDED here — it was previously in
 * NO set anywhere in `src/lib/queries` (invisible to GGR/NGR/cost
 * breakdown); this is the documented gap-fix.
 *
 * `voucher_redeemed` is NOT in this base set anymore — it is NEUTRAL (see
 * NEUTRAL_TYPES), EXCEPT for the per-row `metadata->>'origin'='manual'`
 * carve-out (admin house-granted vouchers, whose only ledger touchpoint
 * is redemption). That manual slice is lifted back into reward cost at
 * the QUERY layer (`queries.ts` `getRewardCost` / `getDailyGamingMetrics`),
 * not via this whole-type bucket — it is a per-row split.
 *
 * `creator_tip` is NOT here — it is a verified pure user→user
 * pass-through (both legs cancel to $0 net house cost) and lives in
 * RESIDUAL_TYPES. Counting it as a reward cost would fabricate a house
 * expense that does not exist.
 *
 * RAIN CAVEAT: `rain_win` is included as a reward type, but rain is
 * SYSTEM-AUTOMATIC and MIXED-funded (the platform auto-adds whatever the
 * pool pays out beyond the user/founder tip contributions; there is no
 * funding account behind it). The NGR helper does NOT hard-code the full
 * `rain_win` magnitude as house cost — it parameterises the rain
 * house-cost via a hook (see `formulas.ts` `ngr` / `RainHouseCost`), whose
 * canonical default is the OWNER-CONFIRMED net model
 * `rainHouseCost = max(0, Σ|rain_win| − Σ|rain_tip|)`. The funding leg
 * `rain_tip` is RESIDUAL (a transfer / the user+founder contribution that
 * is netted out of the house cost), not a reward.
 */
export const REWARD_PAYOUT_TYPES = [
  "deposit_bonus",
  "rakeback_claim",
  "gift_card_redeemed",
  "promo_code_redeemed",
  "race_prize",
  "rain_win",
  "waitlist_prize",
  "balance_reward_claim",
  "affiliate_claim",
  "affiliate_leaderboard_prize",
] as const satisfies readonly LedgerTransactionType[];

// ─── RESIDUAL ────────────────────────────────────────────────────────

/**
 * RESIDUAL_TYPES — balance-sheet / transfer / escrow / borrow / creator-
 * deal flows that are EXCLUDED from both GGR and NGR. They feed realized
 * PnL (via the balance-sheet snapshot) and the cost-breakdown residual,
 * never the gaming margin.
 *
 * Highlights:
 *  • `deposit` / `card_withdrawal` — cash in / cash out (balance sheet).
 *    (Authoritative withdrawals are `card_withdrawal_requests`
 *    completed/shipped + admin "Manual withdrawal" adjustments, not the
 *    `card_withdrawal` ledger type — see pnl.ts.)
 *  • `admin_balance_adjustment` — mixed semantics (manual-withdrawal
 *    debits vs corrections/credits). Routed through realized PnL's
 *    balance delta, not GGR/NGR. The precise debit/credit split is a
 *    cost-breakdown concern, not a gaming-margin one.
 *  • `vault_lock` / `vault_unlock` — balance↔vault transfer (cancel out).
 *  • `rain_tip` — rain pool FUNDING leg: the user + founder contribution
 *    into a pool. A transfer, not a reward cost. The house slice of rain
 *    cost is `max(0, Σ|rain_win| − Σ|rain_tip|)` (owner-confirmed), netted
 *    via the parameterised rain hook in `formulas.ts`; `rain_tip` is the
 *    amount subtracted there.
 *  • `creator_tip` — VERIFIED pure user→user pass-through; both legs
 *    cancel to $0 net house cost. NOT a reward cost.
 *  • `pack_borrow_to_voucher` — borrow-mode remainder → voucher (borrow
 *    plays are excluded from real-money P&L entirely).
 *  • `affiliate_leaderboard_creation` / `_refund` — escrow lock / unspent
 *    return for an affiliate leaderboard pool.
 *  • `creator_deal_fill_grant` / `creator_fill_*` — creator-deal fill
 *    balance lifecycle (grant / activate / spend / refund / convert /
 *    forfeit); house-funded promo balances, excluded from customer GGR.
 *  • `creator_multiplier_*` / `creator_lb_deposit` — creator-MULTIPLIER
 *    deal + creator-leaderboard balance-sheet / escrow / settlement legs
 *    (prod enum, profiled read-only 2026-06-11). Same family as
 *    `creator_fill_*` / `affiliate_leaderboard_*`: borrow-economy escrow,
 *    transfers, virtual top-ups and settlement legs — NONE is a customer
 *    wager, a gaming payout, or a house reward giveaway, so all are
 *    RESIDUAL (excluded from GGR/NGR). 10 of the 11 have a NET
 *    available-balance delta of ~$0 (lock/credit/refund/settlement legs
 *    offset), so they do not even move the windowed-P&L `balanceChange`;
 *    `creator_multiplier_deposit_lock` is a deposit→escrow lock (a
 *    transfer), the classic RESIDUAL case. Their realized house subsidy
 *    surfaces only at settlement (the payout voucher = an inventory item
 *    already captured by the voucher/inventory P&L snapshot, and the
 *    forfeiture haircut), exactly like the `creator_fill_*` netFill
 *    economics — never via this type bucket. Two members are flagged to
 *    the owner for a possible future standalone cost line (NOT a bucket
 *    change): `creator_multiplier_platform_credit` (the house's virtual
 *    funding boost) and `creator_multiplier_settlement_payout` (the
 *    settled voucher payout, already in the voucher P&L snapshot).
 */
export const RESIDUAL_TYPES = [
  "deposit",
  "card_withdrawal",
  "admin_balance_adjustment",
  "vault_lock",
  "vault_unlock",
  "rain_tip",
  "creator_tip",
  "pack_borrow_to_voucher",
  "affiliate_leaderboard_creation",
  "affiliate_leaderboard_refund",
  "creator_deal_fill_grant",
  "creator_fill_activation",
  "creator_fill_spend_tip",
  "creator_fill_spend_battle",
  "creator_fill_refund",
  "creator_fill_conversion",
  "creator_fill_forfeiture",
  // Creator-multiplier deal + creator-leaderboard balance-sheet / escrow /
  // settlement legs (prod enum, confirmed 2026-06-11). Same family as the
  // creator_fill_* / affiliate_leaderboard_* legs above — escrow / transfer
  // / virtual-credit / settlement, none a customer wager / gaming payout /
  // house reward giveaway. Net balance delta ≈ $0 (offsetting legs). See the
  // doc block above for the two owner-flagged members.
  "creator_multiplier_deposit_lock",
  "creator_multiplier_deposit_topup",
  "creator_multiplier_platform_credit",
  "creator_multiplier_spend_wager",
  "creator_multiplier_spend_tip",
  "creator_multiplier_spend_battle",
  "creator_multiplier_refund",
  "creator_multiplier_settlement_payout",
  "creator_multiplier_settlement_deposit_return",
  "creator_multiplier_forfeiture",
  "creator_lb_deposit",
] as const satisfies readonly LedgerTransactionType[];

// ─── UPGRADER (ISOLATED — prod-confirm pending) ──────────────────────

/**
 * UPGRADER_IN_LEDGER — the single switch for the upgrader source of truth.
 *
 * PROD-CONFIRMED (read-only, 2026-06-11): upgrader lives ONLY in
 * `upgrader_games`; prod does NOT write its WIN credit to the ledger. The
 * one query that resolved the old contradiction:
 *
 *   SELECT count(*) FROM ledger_transactions WHERE type = 'upgrader_payout';
 *   -- → 0 rows  (while upgrader_bet → 72,822 rows, upgrader_games present)
 *
 * So the ledger carries ONLY the `upgrader_bet` DEBIT; there is NO
 * `upgrader_payout` credit row at all. `upgrader_bet` / `upgrader_payout`
 * therefore stay OUT of WAGER_TYPES / GAMING_PAYOUT_TYPES, and upgrader
 * metrics are computed from `upgrader_games` (`queries.ts` `upgraderMetrics`
 * / `dashboard.ts` `cachedDailyUpgrader`, both `to_regclass`-guarded).
 *
 * CONSEQUENCE for windowed/daily P&L (see `pnl.ts`): because the win credit
 * is off-ledger, a `balanceChange = SUM(balance_after − balance_before)`
 * over the ledger MISSES every upgrader win credit. `pnl.ts` corrects for
 * that by adding the `upgrader_games.won_amount` window/day-bucketed credit
 * back into `balanceChange` (see `calculateWindowedPnl` / `getDailyPnl` /
 * `getPnlBreakdownWindows` / `users-windowed-pnl.ts`). This flag stays
 * `false` regardless — that correction is a balance-movement fix, NOT a
 * ledger-type reclassification.
 *
 * To flip (only if prod ever STARTS writing `upgrader_payout` ledger rows):
 * set this to `true`, move upgrader onto the ledger type sets via the
 * `*_WITH_UPGRADER` unions below, AND drop the `pnl.ts` upgrader_games
 * correction (it would then double-count). Do NOT flip without the prod
 * count above returning > 0.
 */
export const UPGRADER_IN_LEDGER = false as const;

/**
 * The two upgrader ledger members, kept as named constants so the
 * partition stays exhaustive (every enum member is assigned to exactly
 * one set) WITHOUT putting them on the active wager/payout side while
 * `UPGRADER_IN_LEDGER` is false. When the flag flips, consumers union
 * these in via `WAGER_TYPES_WITH_UPGRADER` / `GAMING_PAYOUT_TYPES_WITH_UPGRADER`.
 *
 * For the exhaustiveness guard these belong to a dedicated UPGRADER set
 * so they are neither lost (a gap) nor double-counted in wager/payout
 * (an overlap) while isolated.
 */
export const UPGRADER_LEDGER_TYPES = [
  "upgrader_bet",
  "upgrader_payout",
] as const satisfies readonly LedgerTransactionType[];

/**
 * Convenience unions for the post-flip world. Consumers that want
 * "wager including upgrader when the ledger carries it" import these
 * instead of `WAGER_TYPES`; while `UPGRADER_IN_LEDGER` is false they are
 * identical to the base sets, so importing them today is safe and
 * forward-compatible.
 */
export const WAGER_TYPES_WITH_UPGRADER: readonly LedgerTransactionType[] =
  UPGRADER_IN_LEDGER
    ? [...WAGER_TYPES, "upgrader_bet"]
    : [...WAGER_TYPES];

export const GAMING_PAYOUT_TYPES_WITH_UPGRADER: readonly LedgerTransactionType[] =
  UPGRADER_IN_LEDGER
    ? [...GAMING_PAYOUT_TYPES, "upgrader_payout"]
    : [...GAMING_PAYOUT_TYPES];

// ─── SQL list helpers (mirror _wager-payout-types.ts pattern) ────────

/**
 * Render a set of ledger-type literals as a parenthesised, single-quoted
 * SQL list ready to drop after `IN`. Values are hardcoded enum strings
 * (no external input) so injection is structurally impossible; the quote
 * escape is defence-in-depth.
 *
 * NOTE on snapshot safety: a BARE `type IN ('upgrader_payout', …)` throws
 * `22P02 invalid input value for enum` on a migration-lagged DB that
 * lacks the member. For sets that may contain not-yet-migrated members
 * (only the upgrader unions, while flipping), prefer the runtime-probe
 * approach (`insights-streamers/_schema-probe.ts` `safeLedgerTypeInList`)
 * or a `::text` cast at the call site. The base sets here
 * (WAGER/FEE/GAMING_PAYOUT/NEUTRAL/REWARD/RESIDUAL) contain only members
 * that exist on every migrated prod DB.
 */
export function ledgerTypesToSqlList(
  types: readonly LedgerTransactionType[],
): string {
  return `(${types.map((t) => `'${t.replace(/'/g, "''")}'`).join(",")})`;
}

export const WAGER_TYPES_SQL = ledgerTypesToSqlList(WAGER_TYPES);
export const FEE_TYPES_SQL = ledgerTypesToSqlList(FEE_TYPES);
export const GAMING_PAYOUT_TYPES_SQL = ledgerTypesToSqlList(GAMING_PAYOUT_TYPES);
export const NEUTRAL_TYPES_SQL = ledgerTypesToSqlList(NEUTRAL_TYPES);
export const REWARD_PAYOUT_TYPES_SQL = ledgerTypesToSqlList(REWARD_PAYOUT_TYPES);
export const RESIDUAL_TYPES_SQL = ledgerTypesToSqlList(RESIDUAL_TYPES);

// ─── Partition map + runtime/compile-time exhaustiveness ─────────────

/**
 * The full partition, one entry per set. Used by:
 *  • the compile-time `_EXHAUSTIVE` guard below (no gaps / no overlaps),
 *  • the `__checks__` runtime assertions,
 *  • `classifyLedgerType` for a single-lookup bucket of any type.
 *
 * UPGRADER_LEDGER_TYPES is its own bucket here so the partition is a true
 * disjoint cover of all 53 members while upgrader is isolated.
 */
export const LEDGER_SET_MEMBERS = {
  WAGER: WAGER_TYPES,
  FEE: FEE_TYPES,
  GAMING_PAYOUT: GAMING_PAYOUT_TYPES,
  NEUTRAL: NEUTRAL_TYPES,
  REWARD_PAYOUT: REWARD_PAYOUT_TYPES,
  RESIDUAL: RESIDUAL_TYPES,
  UPGRADER: UPGRADER_LEDGER_TYPES,
} as const;

export type LedgerSetName = keyof typeof LEDGER_SET_MEMBERS;

/**
 * Build the reverse map (type → set name) once. Throws at module load if
 * any type is assigned to more than one set — a hard, eager guard against
 * an accidental overlap introduced in a future edit.
 */
const TYPE_TO_SET: Record<string, LedgerSetName> = (() => {
  const map: Record<string, LedgerSetName> = {};
  for (const [setName, members] of Object.entries(LEDGER_SET_MEMBERS) as [
    LedgerSetName,
    readonly LedgerTransactionType[],
  ][]) {
    for (const t of members) {
      if (map[t]) {
        throw new Error(
          `[metrics/ledger-sets] ledger type "${t}" assigned to both ` +
            `${map[t]} and ${setName} — sets must be disjoint.`,
        );
      }
      map[t] = setName;
    }
  }
  return map;
})();

/**
 * Which bucket a ledger type belongs to. Returns `null` for an unknown
 * string (defensive — callers should pass a `LedgerTransactionType`).
 */
export function classifyLedgerType(
  type: string,
): LedgerSetName | null {
  return TYPE_TO_SET[type] ?? null;
}

/**
 * Compile-time exhaustiveness: the union of every set's members must
 * equal the full `LedgerTransactionType` union. If a future schema
 * migration adds an enum member to `LedgerTransactionType` above but it
 * is not added to exactly one set, this assignment fails to type-check
 * (the unassigned member is not in the union of set members) — so the
 * build breaks until the new type is classified.
 *
 * `AllAssignedTypes` is the union of the element types of every set.
 * `_EXHAUSTIVE` asserts both directions:
 *  • every set member is a real `LedgerTransactionType` (guaranteed by
 *    the `satisfies` on each set), and
 *  • every `LedgerTransactionType` is an assigned member (the line below).
 */
type AllAssignedTypes =
  | (typeof WAGER_TYPES)[number]
  | (typeof FEE_TYPES)[number]
  | (typeof GAMING_PAYOUT_TYPES)[number]
  | (typeof NEUTRAL_TYPES)[number]
  | (typeof REWARD_PAYOUT_TYPES)[number]
  | (typeof RESIDUAL_TYPES)[number]
  | (typeof UPGRADER_LEDGER_TYPES)[number];

// If this errors, an enum member is unassigned (gap). If the reverse
// assignment errors, a set has a member not in the enum (typo).
const _EXHAUSTIVE_FORWARD: AllAssignedTypes = null as unknown as LedgerTransactionType;
const _EXHAUSTIVE_REVERSE: LedgerTransactionType = null as unknown as AllAssignedTypes;
// Reference them so `noUnusedLocals`-style lints don't trip; this is a
// pure type-level assertion with no runtime effect.
void _EXHAUSTIVE_FORWARD;
void _EXHAUSTIVE_REVERSE;
