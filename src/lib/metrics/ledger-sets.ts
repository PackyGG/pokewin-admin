/**
 * ledger-sets.ts — the SINGLE canonical partition of every
 * `ledger_transaction_type` enum member into exactly one metric bucket.
 *
 * This is Phase-1 foundation. It is intentionally **UNWIRED** — nothing
 * in the live app imports it yet. Creating it changes no behaviour. The
 * existing canonical sets in `src/lib/queries/_wager-payout-types.ts`
 * stay the source of truth for live pages until a later, build-verified
 * migration step swaps each call site over. Do NOT edit
 * `_wager-payout-types.ts` from here.
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
 *    folded into the payout side of GGR.
 *  • The DOMINANT pack/battle payout is the inventory delta, NOT a
 *    ledger type. The only LEDGER-resident gaming payout is
 *    `battle_refund` (a small separate CASH winner leg on battles), plus
 *    `upgrader_payout` IF AND ONLY IF prod writes it to the ledger
 *    (see UPGRADER note below — it is NOT in GAMING_PAYOUT_TYPES by
 *    default).
 *
 * This mirrors exactly what `src/lib/queries/pnl.ts` `getPackBattlePurePnl`
 * already implements (pnl.ts:749-945): wager from the ledger, payout from
 * `user_inventory`, borrow plays dropped on both sides.
 *
 * ─── ENUM SOURCE ────────────────────────────────────────────────────
 *
 * The full enum is `prisma/schema.prisma` `enum ledger_transaction_type`
 * (lines 1221-1264) — 42 members. The stale worktree snapshot only
 * exposes 33 of them; this file is built against the SCHEMA, not the
 * snapshot. The compile-time exhaustiveness check at the bottom
 * (`_EXHAUSTIVE`) fails the build if any enum member is added to the
 * schema-derived `LedgerTransactionType` union without being assigned to
 * exactly one set here — so a future migration that adds an enum member
 * cannot silently leave it unclassified.
 */

/**
 * The full `ledger_transaction_type` enum, as a literal union, in schema
 * order. Kept as a local literal (rather than importing the generated
 * Prisma enum) so this module stays a pure, dependency-light value layer
 * that the `__checks__` script and any client-safe consumer can import
 * without pulling the Prisma client. The `_EXHAUSTIVE` guard below ties
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
  | "upgrader_bet"
  | "upgrader_payout";

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
 * ('pack','battle')`). The only cash gaming-payout leg on the ledger is
 * `battle_refund` (the winner's cash leg on a battle; pack/battle wins
 * are otherwise cards).
 *
 * Therefore the canonical gaming payout used by GGR is:
 *
 *   gamingPayout = Σ inventory.value_at_obtained[source='pack'|'battle']
 *                + Σ |battle_refund|
 *                (+ upgrader payout, per the UPGRADER note)
 *
 * see `formulas.ts` `gamingPayoutTotal` and `queries.ts`
 * `gamingPayoutQuery`. Do NOT add card_sale / card_exchange here — those
 * are NEUTRAL_TYPES (the M-series "card_sale is 328k rows inside the
 * payout side" divergence is resolved by keeping them neutral).
 *
 * `upgrader_payout` is NOT here by default — see UPGRADER section.
 */
export const GAMING_PAYOUT_TYPES = [
  "battle_refund",
] as const satisfies readonly LedgerTransactionType[];

// ─── NEUTRAL ─────────────────────────────────────────────────────────

/**
 * NEUTRAL_TYPES — inventory↔balance and voucher↔balance conversions of
 * value the user ALREADY owns. Net-neutral to GGR and NGR: they neither
 * stake money nor pay a game out; they just change the form value is held
 * in (a card becomes balance, a voucher becomes cards, rounding excess
 * becomes a voucher, etc.).
 *
 * These must be EXCLUDED from the payout side of GGR. Live code
 * (`_wager-payout-types.ts`) currently subtracts most of them inside GGR
 * (the biggest single divergence — `card_sale` alone is hundreds of
 * thousands of rows); this partition reclassifies them as neutral per the
 * verified model. They still appear in realized PnL via the balance /
 * inventory / voucher deltas — that is correct and intentional.
 */
export const NEUTRAL_TYPES = [
  "card_sale",
  "reward_card_sale",
  "card_exchange",
  "exchange_excess_credit",
  "voucher_exchange",
  "exchange_excess_to_voucher",
  "battle_excess_to_voucher",
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
 * `creator_tip` is NOT here — it is a verified pure user→user
 * pass-through (both legs cancel to $0 net house cost) and lives in
 * RESIDUAL_TYPES. Counting it as a reward cost would fabricate a house
 * expense that does not exist.
 *
 * RAIN CAVEAT: `rain_win` is included as a reward type, but rain is
 * MIXED-funded ($2/hr house base + user tips + founder tips). The NGR
 * helper does NOT hard-code the full `rain_win` magnitude as house cost —
 * it parameterises the rain house-cost via a hook (see `formulas.ts`
 * `ngr` / `RainHouseCost`). The funding leg `rain_tip` is RESIDUAL (a
 * transfer), not a reward.
 */
export const REWARD_PAYOUT_TYPES = [
  "deposit_bonus",
  "rakeback_claim",
  "voucher_redeemed",
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
 *  • `rain_tip` — rain pool FUNDING leg (user/house/founder mix). A
 *    transfer, not a reward cost; the house slice of rain cost is
 *    surfaced via the parameterised rain hook in `formulas.ts`.
 *  • `creator_tip` — VERIFIED pure user→user pass-through; both legs
 *    cancel to $0 net house cost. NOT a reward cost.
 *  • `pack_borrow_to_voucher` — borrow-mode remainder → voucher (borrow
 *    plays are excluded from real-money P&L entirely).
 *  • `affiliate_leaderboard_creation` / `_refund` — escrow lock / unspent
 *    return for an affiliate leaderboard pool.
 *  • `creator_deal_fill_grant` / `creator_fill_*` — creator-deal fill
 *    balance lifecycle (grant / activate / spend / refund / convert /
 *    forfeit); house-funded promo balances, excluded from customer GGR.
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
] as const satisfies readonly LedgerTransactionType[];

// ─── UPGRADER (ISOLATED — prod-confirm pending) ──────────────────────

/**
 * UPGRADER_IN_LEDGER — the single switch for the upgrader source-of-truth
 * contradiction.
 *
 * The owner states upgrader lives ONLY in `upgrader_games` and that prod
 * does NOT write `upgrader_bet` / `upgrader_payout` rows to the ledger.
 * But current `dashboard.ts` / `pnl.ts` assume the ledger DOES carry
 * them. This is an UNRESOLVED contradiction pending one prod query:
 *
 *   SELECT count(*) FROM ledger_transactions WHERE type = 'upgrader_payout';
 *
 * Until that returns > 0 in prod, `upgrader_bet` / `upgrader_payout` are
 * kept OUT of WAGER_TYPES / GAMING_PAYOUT_TYPES. Upgrader metrics are
 * instead computed from `upgrader_games` (see `queries.ts`
 * `upgraderMetricsQuery`, modelled on the verified
 * `dashboard-upgrader.ts`).
 *
 * To flip: set this to `true` AND add `upgrader_bet` to
 * `WAGER_TYPES_WITH_UPGRADER` / `upgrader_payout` to
 * `GAMING_PAYOUT_TYPES_WITH_UPGRADER` consumers (already wired below), and
 * switch upgrader surfaces from `upgrader_games` to the ledger. Do NOT
 * flip without the prod count above confirming the rows exist.
 *
 * The snapshot lacks `upgrader_games`, so the upgrader query cannot be
 * run here — it is built from schema + the existing `dashboard-upgrader.ts`
 * code and documented as prod-only.
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
 * disjoint cover of all 42 members while upgrader is isolated.
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
