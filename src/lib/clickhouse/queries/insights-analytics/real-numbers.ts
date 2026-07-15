import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  WAGER_TYPES,
  GAMING_PAYOUT_TYPES,
  REWARD_PAYOUT_TYPES,
  ledgerTypesToSqlList,
} from "@/lib/metrics/ledger-sets";

import { CH_DB, chDateTime, customerScopeCte, toNumber } from "../_shared";

/**
 * Phase 2B — /insights/real-numbers comparison-mode twin, read from the
 * ClickHouse prod game mirror (`packy_prod`, PeerDB CDC).
 *
 * The Postgres source is the bundle of helpers in
 * `src/lib/queries/insights-analytics/real-numbers.ts` + the hub wager
 * (`getInsightsHubWager`, `src/lib/queries/insights-analytics/hub-wager.ts`).
 * This twin reproduces each of those numbers by mirroring the EXACT same
 * canonical legs / predicates / scope the Postgres helpers use, so logged
 * comparison-mode drift reflects engine / CDC-lag only, never a definition
 * change. The page's cost-breakdown headline + lifetime realized-P&L snapshot
 * have their OWN twins (`getCostBreakdownComparableFromClickHouse`,
 * `getRealizedPnlSnapshotFromClickHouse`) + compare hooks; this module covers
 * only the real-numbers-SPECIFIC helpers that have no twin yet.
 *
 * ─── What each field mirrors (PG twin → CH leg) ─────────────────────
 *
 *   • hubWager  ← getInsightsHubWager: Σ |amount| over WAGER_TYPES
 *     (pack_opening + battle_bet + battle_sponsorship), real customers, NO
 *     WAGER_LEG_FILTER (the hub tile counts every wager type at its borrow-net
 *     ledger amount) + upgrader bet_amount. Creators dropped wholesale by role,
 *     so the PG `NOT in_session` predicate (creator-only) is always true →
 *     omitted here.
 *
 *   • game split (packs / battles / upgrader) ← getRealNumbersGameSplit:
 *       packWager   = Σ |amount| pack_opening under WAGER_LEG_FILTER
 *       battleWager = Σ |amount| battle_bet + battle_sponsorship
 *       packPayout  = Σ value_at_obtained source_type='pack' under PAYOUT_LEG_FILTER
 *       battlePayout= Σ value_at_obtained source_type='battle' under PAYOUT_LEG_FILTER
 *                     + Σ |amount| over GAMING_PAYOUT_TYPES (battle_refund +
 *                       battle_excess_to_voucher — battle-win settlement legs)
 *       upgrader{Wager,Payout} = upgrader_games bet/won amounts.
 *     ggr = wager − payout per line; totals sum the legs.
 *
 *   • reward spend ← getRewardSpendItemization: total = rewardCostExclRain
 *     + netRain, where rewardCostExclRain = Σ |amount| over
 *     (REWARD_PAYOUT_TYPES excl rain_win) + the manual-voucher carve-out
 *     (voucher_redeemed, metadata.origin='manual') + counted
 *     admin_balance_adjustment credits; netRain = max(0, Σ|rain_win| −
 *     Σ|rain_tip|). dailyPacks{Cost,Opens,Claimers} ← getDailyPacksTotalCost:
 *     Σ value_at_obtained of reward-pack (`packs.pack_type='reward'`) won cards
 *     joined through the originating game session, with uniqExact opens/claimers.
 *
 *   • pnlExclCreators ← getRealizedPnlCustomersExclCreators: the balance-sheet
 *     P&L formula on the canonical 3-role customer scope (deposits − withdrawals
 *     − onSiteBalance − inventory − vouchers − unclaimedRakeback).
 *
 *   • creator net cash ← getCreatorNetCashDetail: the SAME balance-sheet
 *     aggregates on the creator population (role='creator', not blacklisted);
 *     holdings = onSiteBalance + inventory + vouchers + rakeback; netCash =
 *     deposited − withdrawn − holdings.
 *
 *   • customer recycling ← getCustomerRecyclingDetail: deposits (Σ
 *     balances.total_deposited, customer scope) + card sell-backs (card_sale +
 *     reward_card_sale, and card_exchange + exchange_excess_credit).
 *
 *   • creator program cost ← getCreatorProgramCost: lifetime, ALL users (house
 *     program spend, not customer-scoped) — session tips, conversion vouchers
 *     (vouchers.origin='creator_fill_conversion'), leaderboard prizes, fill
 *     context.
 *
 * ClickHouse correctness (PeerDB / SharedReplacingMergeTree mirrors):
 *   • Dedup latest row per id with FINAL on every public_* table.
 *   • Drop soft-deleted rows with `_peerdb_is_deleted = 0` everywhere.
 *   • Money stays Decimal end-to-end — toString(sum(...)) in SQL, toNumber()
 *     in TS — never Float / toFloat. Every `if()` zero-branch over money uses
 *     `toDecimal128(0, 2)` (never the bare int `0`, which truncates the Decimal
 *     scale and drops cents — see clickhouse-rules.md §5b).
 *   • The Postgres `jsonb` `metadata` column is mirrored as a ClickHouse
 *     String; `metadata->>'key'` maps to `JSONExtractString`.
 *   • `type` / `origin` compared as plain strings (CH mirrors PG enums as
 *     String), so a label absent from prod simply matches zero rows — no
 *     22P02 enum-parse crash (the PG `::text` enum-safety concern is moot here).
 *
 * The blacklist is passed IN by the caller (resolved from the admin DB via
 * getExcludedUserIds) so this module never imports a Postgres/Prisma client
 * (directly or transitively) — it is a pure ClickHouse read. Each cutoff is the
 * SAME canonical 365d-capped value the Postgres path computed (carried in the
 * PG result objects' `cutoffIso`), reused verbatim so the window is identical.
 */

const WAGER_TYPES_SQL = ledgerTypesToSqlList(WAGER_TYPES);
const GAMING_PAYOUT_TYPES_SQL = ledgerTypesToSqlList(GAMING_PAYOUT_TYPES);
const REWARD_PAYOUT_TYPES_SQL = ledgerTypesToSqlList(REWARD_PAYOUT_TYPES);

/**
 * COUNTED adjustment-category keys — inlined as raw strings so this read never
 * imports `@/lib/balance-adjustment-categories` (which pulls the engine-free
 * Prisma `browser` sentinel), keeping the CQRS boundary Prisma-free. Canonical
 * source of truth: `COUNTED_ADJUSTMENT_CATEGORY_KEYS` (every CREDIT category
 * except `other`, `official_stream`, and the removal-only debits) — keep in
 * sync. Same list `window-metrics.ts` / `dashboard-cashflow.ts` inline.
 */
const COUNTED_ADJ_CATEGORY_KEYS = [
  "deposit_problem",
  "withdrawal_failed",
  "giveaway",
  "bonus",
  "deposit_bonus",
  "bugs",
  "reload",
  "trivia",
  "lossback",
] as const;
const COUNTED_ADJ_CATEGORIES_SQL = `(${COUNTED_ADJ_CATEGORY_KEYS.map(
  (k) => `'${k.replace(/'/g, "''")}'`,
).join(",")})`;

/** Manual-voucher carve-out (CH twin of `metadata->>'origin' = 'manual'`). */
const MANUAL_VOUCHER_PREDICATE_CH =
  `(lt.type = 'voucher_redeemed' AND JSONExtractString(lt.metadata, 'origin') = 'manual')`;

/** Counted-adjustment carve-out (CH twin of `countedAdjustmentSqlPredicate`). */
const COUNTED_ADJ_PREDICATE_CH = `(lt.type = 'admin_balance_adjustment' AND lt.amount > 0 AND JSONExtractString(lt.metadata, 'adjustment_category') IN ${COUNTED_ADJ_CATEGORIES_SQL})`;

/** WITHDRAWAL_LIABILITY_STATUSES (pnl.ts) — in-flight + done count as liability. */
const WITHDRAWAL_LIABILITY_STATUSES_SQL = "('pending','processing','shipped','completed')";

/** stats-excluded fake-balance carve-out category keys (signed-net subtract). */
const OFFICIAL_STREAM_CATEGORY = "official_stream";
const REMOVE_LOCKED_BALANCE_CATEGORY = "remove_locked_balance";

/**
 * Reward/daily-pack session set — `game_sessions` for reward-pack opens
 * (`game_type='pack'` → `packs.pack_type='reward'`). Mirrors
 * `@/lib/metrics/gaming-sql` `REWARD_PACK_SESSIONS`; used to drop $0-wager
 * giveaway opens from BOTH the wager leg (game_session_id) and won-card
 * inventory leg (source_id). FINAL + `_peerdb_is_deleted = 0` on both tables.
 */
function rewardPackSessionsSubquery(): string {
  return `(
        SELECT gs.id
        FROM ${CH_DB}.public_game_sessions AS gs FINAL
        INNER JOIN ${CH_DB}.public_packs AS p FINAL
          ON p.id = gs.game_id AND p._peerdb_is_deleted = 0 AND p.pack_type = 'reward'
        WHERE gs._peerdb_is_deleted = 0
          AND gs.game_type = 'pack'
      )`;
}

/** CH twin of WAGER_LEG_FILTER (borrow-net-inclusive; only reward packs excluded). */
function wagerLegFilterCh(rewardPackSessions: string): string {
  return `(
        lt.type NOT IN ('pack_opening','battle_bet','battle_sponsorship')
        OR (lt.type = 'pack_opening'
            AND (lt.game_session_id IS NULL OR lt.game_session_id NOT IN ${rewardPackSessions}))
        OR lt.type = 'battle_bet'
        OR lt.type = 'battle_sponsorship'
      )`;
}

/** CH twin of PAYOUT_LEG_FILTER (reward-pack won cards excluded by source_id). */
function payoutLegFilterCh(rewardPackSessions: string): string {
  return `(
        ui.source_type IN ('pack','battle')
      ) AND (ui.source_id IS NULL OR ui.source_id NOT IN ${rewardPackSessions})`;
}

/** The full comparable shape — flat numeric record for `computeDrift`. */
export type RealNumbersComparable = {
  // Hub wager (lifetime turnover headline tile).
  hubWager: number;
  // Per-game GGR split.
  packWager: number;
  battleWager: number;
  upgraderWager: number;
  packPayout: number;
  battlePayout: number;
  upgraderPayout: number;
  splitTotalWager: number;
  splitTotalPayout: number;
  splitTotalGgr: number;
  // Reward & bonus spend itemization.
  rewardTotal: number;
  rewardNetRain: number;
  rainWinGross: number;
  rainTipOffset: number;
  dailyPacksCost: number;
  dailyPacksOpens: number;
  dailyPacksClaimers: number;
  // Realized P&L on the customers-only (creators excluded) scope.
  pnlExclCreators: number;
  // Creator net-cash detail.
  creatorDeposited: number;
  creatorWithdrawn: number;
  creatorHoldings: number;
  creatorNetCash: number;
  // Customer recycling detail.
  recyclingDeposits: number;
  recyclingCardSaleLeg: number;
  recyclingCardExchangeLeg: number;
  recyclingCardSellBacks: number;
  // Creator program cost (gross, all users).
  programCreatorTip: number;
  programFillSpendTip: number;
  programSessionTips: number;
  programConversionVouchers: number;
  programConversionVoucherCount: number;
  programLeaderboardPrize: number;
  programLeaderboardPrizeCount: number;
  programCreatorSpecificSubtotal: number;
  programFillGrant: number;
  programFillActivation: number;
  programFillForfeiture: number;
};

export type RealNumbersClickHouseArgs = {
  /** Hub wager + per-game split + upgrader window (now − 365d, bucketed). */
  wagerCutoff: Date;
  /** Reward-spend itemization window. */
  rewardCutoff: Date;
  /** Customer-recycling card-leg window. */
  recyclingCutoff: Date;
  /** Daily-pack giveaway window (obtained_at >= now − 365d). */
  dailyPacksCutoff: Date;
  /**
   * Creator-program-cost window (created_at >= now − 365d). Mirrors the
   * PG twin's `getCreatorProgramCost` 365d house-convention cap so the
   * lifetime program-cost legs stay bounded on both engines for parity.
   */
  programCutoff: Date;
};

type BalanceSheetRaw = {
  deposited: number;
  balanceWithdrawn: number;
  cardWithdrawn: number;
  availableBalance: number;
  lockedBalance: number;
  inventory: number;
  vouchers: number;
  unclaimedRakeback: number;
  officialStreamNet: number;
  removeLockedNet: number;
};

/**
 * The balance-sheet aggregates over a given user-scope CTE — the SAME six
 * single-table sums the realized-P&L snapshot reads, shared by the
 * customers-excl-creators P&L leg and the creator-net-cash leg (only the scope
 * CTE differs). Money stays Decimal (toString(sum) → toNumber).
 */
async function balanceSheetRawFromClickHouse(
  scopeCte: string,
  params: Record<string, unknown>,
  tag: string,
): Promise<BalanceSheetRaw> {
  const balancesSql = `
    WITH ${scopeCte}
    SELECT
      toString(sum(b.total_deposited))   AS deposited,
      toString(sum(b.total_withdrawn))   AS balance_withdrawn,
      toString(sum(b.available_balance)) AS available_balance,
      toString(sum(b.locked_balance))    AS locked_balance
    FROM ${CH_DB}.public_balances AS b FINAL
    WHERE b._peerdb_is_deleted = 0
      AND b.user_id IN (SELECT id FROM real_users)`;

  const cardSql = `
    WITH ${scopeCte}
    SELECT toString(sum(cwr.total_value_usd)) AS card_withdrawn
    FROM ${CH_DB}.public_card_withdrawal_requests AS cwr FINAL
    WHERE cwr._peerdb_is_deleted = 0
      AND cwr.status IN ${WITHDRAWAL_LIABILITY_STATUSES_SQL}
      AND cwr.user_id IN (SELECT id FROM real_users)`;

  const invSql = `
    WITH ${scopeCte}
    SELECT toString(sum(ui.value_at_obtained)) AS inventory
    FROM ${CH_DB}.public_user_inventory AS ui FINAL
    WHERE ui._peerdb_is_deleted = 0
      AND ui.sold_at IS NULL
      AND ui.exchanged_at IS NULL
      AND ui.withdrawal_locked_at IS NULL
      AND ui.user_id IN (SELECT id FROM real_users)`;

  const vchSql = `
    WITH ${scopeCte}
    SELECT toString(sum(v.value)) AS vouchers
    FROM ${CH_DB}.public_vouchers AS v FINAL
    WHERE v._peerdb_is_deleted = 0
      AND v.claimed_at IS NULL
      AND v.user_id IN (SELECT id FROM real_users)`;

  const rakeSql = `
    WITH ${scopeCte}
    SELECT toString(sum(rc.rakeback_amount_usd)) AS unclaimed_rakeback
    FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
    WHERE rc._peerdb_is_deleted = 0
      AND rc.claimed_at IS NULL
      AND rc.user_id IN (SELECT id FROM real_users)`;

  // SIGNED NET (sum(amount), not ABS) so carve-outs self-reverse on clawback.
  const adjSql = `
    WITH ${scopeCte}
    SELECT
      toString(sum(if(JSONExtractString(lt.metadata, 'adjustment_category') = '${OFFICIAL_STREAM_CATEGORY}', lt.amount, toDecimal128(0, 2)))) AS official_stream_net,
      toString(sum(if(JSONExtractString(lt.metadata, 'adjustment_category') = '${REMOVE_LOCKED_BALANCE_CATEGORY}', lt.amount, toDecimal128(0, 2)))) AS remove_locked_net
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type = 'admin_balance_adjustment'
      AND lt.user_id IN (SELECT id FROM real_users)`;

  const [bal, card, inv, vch, rake, adj] = await Promise.all([
    clickhouseRead.query<{
      deposited: string;
      balance_withdrawn: string;
      available_balance: string;
      locked_balance: string;
    }>({ queryName: `${tag}.balances`, sql: balancesSql, params }),
    clickhouseRead.query<{ card_withdrawn: string }>({
      queryName: `${tag}.cardWithdrawals`,
      sql: cardSql,
      params,
    }),
    clickhouseRead.query<{ inventory: string }>({
      queryName: `${tag}.inventory`,
      sql: invSql,
      params,
    }),
    clickhouseRead.query<{ vouchers: string }>({
      queryName: `${tag}.vouchers`,
      sql: vchSql,
      params,
    }),
    clickhouseRead.query<{ unclaimed_rakeback: string }>({
      queryName: `${tag}.rakeback`,
      sql: rakeSql,
      params,
    }),
    clickhouseRead.query<{
      official_stream_net: string;
      remove_locked_net: string;
    }>({ queryName: `${tag}.adjustments`, sql: adjSql, params }),
  ]);

  return {
    deposited: toNumber(bal[0]?.deposited),
    balanceWithdrawn: toNumber(bal[0]?.balance_withdrawn),
    cardWithdrawn: toNumber(card[0]?.card_withdrawn),
    availableBalance: toNumber(bal[0]?.available_balance),
    lockedBalance: toNumber(bal[0]?.locked_balance),
    inventory: toNumber(inv[0]?.inventory),
    vouchers: toNumber(vch[0]?.vouchers),
    unclaimedRakeback: toNumber(rake[0]?.unclaimed_rakeback),
    officialStreamNet: toNumber(adj[0]?.official_stream_net),
    removeLockedNet: toNumber(adj[0]?.remove_locked_net),
  };
}

/**
 * ClickHouse twin of the real-numbers-specific helpers (see module header).
 * Returns the SAME numbers the Postgres helpers produce, mirroring their exact
 * predicates / scope / window. Read-only against the CDC mirror.
 */
export async function getRealNumbersComparableFromClickHouse(
  args: RealNumbersClickHouseArgs,
  blacklist: string[],
): Promise<RealNumbersComparable> {
  const hasBlacklist = blacklist.length > 0;
  const scopeCte = customerScopeCte({ hasBlacklist });
  const creatorScopeCte = `real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role = 'creator'
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;

  const wagerParams = { blacklist, cutoff: chDateTime(args.wagerCutoff) };
  const rewardParams = { blacklist, cutoff: chDateTime(args.rewardCutoff) };
  const recyclingParams = { blacklist, cutoff: chDateTime(args.recyclingCutoff) };
  const dpParams = { blacklist, cutoff: chDateTime(args.dailyPacksCutoff) };
  const programParams = { blacklist, cutoff: chDateTime(args.programCutoff) };
  const noWindowParams = { blacklist };

  const rewardPackSessions = rewardPackSessionsSubquery();
  const wagerLegFilter = wagerLegFilterCh(rewardPackSessions);
  const payoutLegFilter = payoutLegFilterCh(rewardPackSessions);

  // ── Per-game wager (ledger), under WAGER_LEG_FILTER ──
  const splitWagerSql = `
    WITH ${scopeCte}
    SELECT
      toString(sum(if(lt.type = 'pack_opening', abs(lt.amount), toDecimal128(0, 2)))) AS pack_wager,
      toString(sum(if(lt.type IN ('battle_bet','battle_sponsorship'), abs(lt.amount), toDecimal128(0, 2)))) AS battle_wager
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type IN ('pack_opening','battle_bet','battle_sponsorship')
      AND lt.user_id IN (SELECT id FROM real_users)
      AND lt.created_at >= {cutoff:DateTime64(6)}
      AND ${wagerLegFilter}`;

  // ── Per-game inventory payout, under PAYOUT_LEG_FILTER ──
  const splitInvSql = `
    WITH ${scopeCte}
    SELECT
      toString(sum(if(ui.source_type = 'pack', ui.value_at_obtained, toDecimal128(0, 2)))) AS pack_inv,
      toString(sum(if(ui.source_type = 'battle', ui.value_at_obtained, toDecimal128(0, 2)))) AS battle_inv
    FROM ${CH_DB}.public_user_inventory AS ui FINAL
    WHERE ui._peerdb_is_deleted = 0
      AND ${payoutLegFilter}
      AND ui.user_id IN (SELECT id FROM real_users)
      AND ui.obtained_at >= {cutoff:DateTime64(6)}`;

  // ── Ledger gaming-payout legs (battle settlement) ──
  const splitLedgerPayoutSql = `
    WITH ${scopeCte}
    SELECT toString(sum(abs(lt.amount))) AS battle_ledger_payout
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type IN ${GAMING_PAYOUT_TYPES_SQL}
      AND lt.user_id IN (SELECT id FROM real_users)
      AND lt.created_at >= {cutoff:DateTime64(6)}`;

  // ── Hub wager (every WAGER_TYPES row, NO leg filter) ──
  const hubWagerSql = `
    WITH ${scopeCte}
    SELECT toString(sum(abs(lt.amount))) AS wager
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type IN ${WAGER_TYPES_SQL}
      AND lt.user_id IN (SELECT id FROM real_users)
      AND lt.created_at >= {cutoff:DateTime64(6)}`;

  // ── Upgrader (bet/won amounts) ──
  const upgraderSql = `
    WITH ${scopeCte}
    SELECT
      toString(sum(ug.bet_amount)) AS upg_wager,
      toString(sum(ug.won_amount)) AS upg_payout
    FROM ${CH_DB}.public_upgrader_games AS ug FINAL
    WHERE ug._peerdb_is_deleted = 0
      AND ug.user_id IN (SELECT id FROM real_users)
      AND ug.created_at >= {cutoff:DateTime64(6)}`;

  // ── Reward-spend reconciling legs ──
  const rewardSql = `
    WITH ${scopeCte}
    SELECT
      toString(sum(if(
        (lt.type IN ${REWARD_PAYOUT_TYPES_SQL} AND lt.type != 'rain_win')
        OR ${MANUAL_VOUCHER_PREDICATE_CH}
        OR ${COUNTED_ADJ_PREDICATE_CH},
        abs(lt.amount), toDecimal128(0, 2)
      ))) AS reward_excl_rain,
      toString(sum(if(lt.type = 'rain_win', abs(lt.amount), toDecimal128(0, 2)))) AS rain_win,
      toString(sum(if(lt.type = 'rain_tip', abs(lt.amount), toDecimal128(0, 2)))) AS rain_tip
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.user_id IN (SELECT id FROM real_users)
      AND lt.created_at >= {cutoff:DateTime64(6)}`;

  // ── Daily / free-pack giveaway (reward-pack won cards) ──
  const dailyPacksSql = `
    WITH ${scopeCte},
    reward_cards AS (
      SELECT
        ui.user_id   AS user_id,
        ui.source_id AS session_id,
        ui.value_at_obtained AS card_value
      FROM ${CH_DB}.public_user_inventory AS ui FINAL
      INNER JOIN ${CH_DB}.public_game_sessions AS gs FINAL
        ON gs.id = ui.source_id AND gs._peerdb_is_deleted = 0 AND gs.game_type = 'pack'
      INNER JOIN ${CH_DB}.public_packs AS p FINAL
        ON p.id = gs.game_id AND p._peerdb_is_deleted = 0 AND p.pack_type = 'reward'
      WHERE ui._peerdb_is_deleted = 0
        AND ui.user_id IN (SELECT id FROM real_users)
        AND ui.obtained_at >= {cutoff:DateTime64(6)}
    )
    SELECT
      toString(sum(card_value))       AS giveaway_payout,
      toString(uniqExact(session_id)) AS opens,
      toString(uniqExact(user_id))    AS claimers
    FROM reward_cards`;

  // ── Customer recycling card legs ──
  const recyclingCardSql = `
    WITH ${scopeCte}
    SELECT
      toString(sum(if(lt.type IN ('card_sale','reward_card_sale'), abs(lt.amount), toDecimal128(0, 2)))) AS card_sale,
      toString(sum(if(lt.type IN ('card_exchange','exchange_excess_credit'), abs(lt.amount), toDecimal128(0, 2)))) AS card_exchange
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type IN ('card_sale','reward_card_sale','card_exchange','exchange_excess_credit')
      AND lt.user_id IN (SELECT id FROM real_users)
      AND lt.created_at >= {cutoff:DateTime64(6)}`;

  // Customer deposits — Σ balances.total_deposited (per-user total, no window).
  const recyclingDepositsSql = `
    WITH ${scopeCte}
    SELECT toString(sum(b.total_deposited)) AS deposits
    FROM ${CH_DB}.public_balances AS b FINAL
    WHERE b._peerdb_is_deleted = 0
      AND b.user_id IN (SELECT id FROM real_users)`;

  // ── Creator program cost (lifetime, ALL users) ──
  const programLedgerSql = `
    SELECT
      toString(sum(if(lt.type = 'creator_tip',                    abs(lt.amount), toDecimal128(0, 2)))) AS creator_tip,
      toString(sum(if(lt.type = 'creator_fill_spend_tip',         abs(lt.amount), toDecimal128(0, 2)))) AS fill_spend_tip,
      toString(sum(if(lt.type = 'affiliate_leaderboard_prize',    abs(lt.amount), toDecimal128(0, 2)))) AS leaderboard_prize,
      toString(sum(if(lt.type = 'affiliate_leaderboard_prize',    1, 0)))                               AS leaderboard_prize_count,
      toString(sum(if(lt.type = 'creator_deal_fill_grant',        abs(lt.amount), toDecimal128(0, 2)))) AS fill_grant,
      toString(sum(if(lt.type = 'creator_fill_activation',        abs(lt.amount), toDecimal128(0, 2)))) AS fill_activation,
      toString(sum(if(lt.type = 'creator_fill_forfeiture',        abs(lt.amount), toDecimal128(0, 2)))) AS fill_forfeiture
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type IN (
        'creator_tip','creator_fill_spend_tip','affiliate_leaderboard_prize',
        'creator_deal_fill_grant','creator_fill_activation','creator_fill_forfeiture'
      )
      AND lt.created_at >= {cutoff:DateTime64(6)}`;

  const programVoucherSql = `
    SELECT
      toString(sum(v.value)) AS conversion_value,
      toString(count())      AS conversion_count
    FROM ${CH_DB}.public_vouchers AS v FINAL
    WHERE v._peerdb_is_deleted = 0
      AND v.origin = 'creator_fill_conversion'
      AND v.created_at >= {cutoff:DateTime64(6)}`;

  const [
    splitWager,
    splitInv,
    splitLedgerPayout,
    hub,
    upg,
    reward,
    dailyPacks,
    recyclingCard,
    recyclingDeposits,
    pnlScope,
    creatorScope,
    programLedger,
    programVoucher,
  ] = await Promise.all([
    clickhouseRead.query<{ pack_wager: string; battle_wager: string }>({
      queryName: "insightsRealNumbers.split.wager",
      sql: splitWagerSql,
      params: wagerParams,
    }),
    clickhouseRead.query<{ pack_inv: string; battle_inv: string }>({
      queryName: "insightsRealNumbers.split.inventory",
      sql: splitInvSql,
      params: wagerParams,
    }),
    clickhouseRead.query<{ battle_ledger_payout: string }>({
      queryName: "insightsRealNumbers.split.ledgerPayout",
      sql: splitLedgerPayoutSql,
      params: wagerParams,
    }),
    clickhouseRead.query<{ wager: string }>({
      queryName: "insightsRealNumbers.hubWager",
      sql: hubWagerSql,
      params: wagerParams,
    }),
    clickhouseRead.query<{ upg_wager: string; upg_payout: string }>({
      queryName: "insightsRealNumbers.upgrader",
      sql: upgraderSql,
      params: wagerParams,
    }),
    clickhouseRead.query<{
      reward_excl_rain: string;
      rain_win: string;
      rain_tip: string;
    }>({
      queryName: "insightsRealNumbers.rewardSpend",
      sql: rewardSql,
      params: rewardParams,
    }),
    clickhouseRead.query<{
      giveaway_payout: string;
      opens: string;
      claimers: string;
    }>({
      queryName: "insightsRealNumbers.dailyPacks",
      sql: dailyPacksSql,
      params: dpParams,
    }),
    clickhouseRead.query<{ card_sale: string; card_exchange: string }>({
      queryName: "insightsRealNumbers.recycling.cards",
      sql: recyclingCardSql,
      params: recyclingParams,
    }),
    clickhouseRead.query<{ deposits: string }>({
      queryName: "insightsRealNumbers.recycling.deposits",
      sql: recyclingDepositsSql,
      params: noWindowParams,
    }),
    balanceSheetRawFromClickHouse(
      scopeCte,
      noWindowParams,
      "insightsRealNumbers.pnlExclCreators",
    ),
    balanceSheetRawFromClickHouse(
      creatorScopeCte,
      noWindowParams,
      "insightsRealNumbers.creatorNetCash",
    ),
    clickhouseRead.query<{
      creator_tip: string;
      fill_spend_tip: string;
      leaderboard_prize: string;
      leaderboard_prize_count: string;
      fill_grant: string;
      fill_activation: string;
      fill_forfeiture: string;
    }>({
      queryName: "insightsRealNumbers.program.ledger",
      sql: programLedgerSql,
      params: programParams,
    }),
    clickhouseRead.query<{
      conversion_value: string;
      conversion_count: string;
    }>({
      queryName: "insightsRealNumbers.program.vouchers",
      sql: programVoucherSql,
      params: programParams,
    }),
  ]);

  // ── Per-game split ──
  const packWager = toNumber(splitWager[0]?.pack_wager);
  const battleWager = toNumber(splitWager[0]?.battle_wager);
  const packInvPayout = toNumber(splitInv[0]?.pack_inv);
  const battleInvPayout = toNumber(splitInv[0]?.battle_inv);
  const battleLedgerPayout = toNumber(splitLedgerPayout[0]?.battle_ledger_payout);
  const upgraderWager = toNumber(upg[0]?.upg_wager);
  const upgraderPayout = toNumber(upg[0]?.upg_payout);

  const packPayout = packInvPayout;
  const battlePayout = battleInvPayout + battleLedgerPayout;
  const packGgr = packWager - packPayout;
  const battleGgr = battleWager - battlePayout;
  const upgraderGgr = upgraderWager - upgraderPayout;
  const splitTotalWager = packWager + battleWager + upgraderWager;
  const splitTotalPayout = packPayout + battlePayout + upgraderPayout;
  const splitTotalGgr = packGgr + battleGgr + upgraderGgr;

  // ── Hub wager (ledger + upgrader) ──
  const hubWager = toNumber(hub[0]?.wager) + upgraderWager;

  // ── Reward spend ──
  const rewardExclRain = toNumber(reward[0]?.reward_excl_rain);
  const rainWinGross = toNumber(reward[0]?.rain_win);
  const rainTipOffset = toNumber(reward[0]?.rain_tip);
  const rewardNetRain = Math.max(0, rainWinGross - rainTipOffset);
  const rewardTotal = rewardExclRain + rewardNetRain;
  const dailyPacksCost = toNumber(dailyPacks[0]?.giveaway_payout);
  const dailyPacksOpens = toNumber(dailyPacks[0]?.opens);
  const dailyPacksClaimers = toNumber(dailyPacks[0]?.claimers);

  // ── Realized P&L on the customers-excl-creators scope ──
  const pnlExclCreators = balanceSheetPnl(pnlScope);

  // ── Creator net cash ──
  const creatorWithdrawn =
    creatorScope.balanceWithdrawn + creatorScope.cardWithdrawn;
  const creatorOnSite =
    creatorScope.availableBalance +
    creatorScope.lockedBalance -
    creatorScope.officialStreamNet -
    creatorScope.removeLockedNet;
  const creatorHoldings =
    creatorOnSite +
    creatorScope.inventory +
    creatorScope.vouchers +
    creatorScope.unclaimedRakeback;
  const creatorNetCash =
    creatorScope.deposited - creatorWithdrawn - creatorHoldings;

  // ── Customer recycling ──
  const recyclingCardSaleLeg = toNumber(recyclingCard[0]?.card_sale);
  const recyclingCardExchangeLeg = toNumber(recyclingCard[0]?.card_exchange);
  const recyclingCardSellBacks =
    recyclingCardSaleLeg + recyclingCardExchangeLeg;
  const recyclingDepositsVal = toNumber(recyclingDeposits[0]?.deposits);

  // ── Creator program cost ──
  const programCreatorTip = toNumber(programLedger[0]?.creator_tip);
  const programFillSpendTip = toNumber(programLedger[0]?.fill_spend_tip);
  const programSessionTips = programCreatorTip + programFillSpendTip;
  const programConversionVouchers = toNumber(programVoucher[0]?.conversion_value);
  const programConversionVoucherCount = toNumber(
    programVoucher[0]?.conversion_count,
  );
  const programLeaderboardPrize = toNumber(programLedger[0]?.leaderboard_prize);
  const programLeaderboardPrizeCount = toNumber(
    programLedger[0]?.leaderboard_prize_count,
  );

  return {
    hubWager,
    packWager,
    battleWager,
    upgraderWager,
    packPayout,
    battlePayout,
    upgraderPayout,
    splitTotalWager,
    splitTotalPayout,
    splitTotalGgr,
    rewardTotal,
    rewardNetRain,
    rainWinGross,
    rainTipOffset,
    dailyPacksCost,
    dailyPacksOpens,
    dailyPacksClaimers,
    pnlExclCreators,
    creatorDeposited: creatorScope.deposited,
    creatorWithdrawn,
    creatorHoldings,
    creatorNetCash,
    recyclingDeposits: recyclingDepositsVal,
    recyclingCardSaleLeg,
    recyclingCardExchangeLeg,
    recyclingCardSellBacks,
    programCreatorTip,
    programFillSpendTip,
    programSessionTips,
    programConversionVouchers,
    programConversionVoucherCount,
    programLeaderboardPrize,
    programLeaderboardPrizeCount,
    programCreatorSpecificSubtotal: programSessionTips + programConversionVouchers,
    programFillGrant: toNumber(programLedger[0]?.fill_grant),
    programFillActivation: toNumber(programLedger[0]?.fill_activation),
    programFillForfeiture: toNumber(programLedger[0]?.fill_forfeiture),
  };
}

/**
 * The canonical balance-sheet house P&L (= computeHousePnl − unclaimedRakeback)
 * over the raw aggregates — IDENTICAL arithmetic to the PG twin
 * `getRealizedPnlCustomersExclCreators`.
 */
function balanceSheetPnl(r: BalanceSheetRaw): number {
  const totalWithdrawn = r.balanceWithdrawn + r.cardWithdrawn;
  const onSiteBalance =
    r.availableBalance +
    r.lockedBalance -
    r.officialStreamNet -
    r.removeLockedNet;
  return (
    r.deposited -
    totalWithdrawn -
    onSiteBalance -
    r.inventory -
    r.vouchers -
    r.unclaimedRakeback
  );
}
