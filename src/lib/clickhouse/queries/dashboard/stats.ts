import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, toNumber } from "../_shared";

/**
 * Phase 2B — Dashboard headline KPI composite (`getDashboardStats`), read from
 * the ClickHouse prod game mirror (`packy_prod`, PeerDB CDC).
 *
 * Twin of the SCALAR money/count legs of the canonical Postgres
 * `getDashboardStats` / `dashboardStatsInner` (src/lib/queries/dashboard.ts).
 * Returns the SAME payload-shaped numbers so comparison mode can diff
 * field-for-field. The chart-array legs (dailyWagers / dailyDeposits /
 * dailySignups / dailyFtds / dailyActiveDepositors / dailyWagerAttribution) are
 * NOT mirrored here — they are covered by the dedicated `dashboard_trend_series`
 * surface twin. The headline `ggr` leg is NOT mirrored here — it is covered by
 * the dedicated `dashboard_headline_ggr` surface twin (`getWindowMetrics`); and
 * the creator deal-payout cash-out leg (`creatorWithdrawals` / count) is
 * DEFERRED (a `card_withdrawal_requests.voucher_ids` array ⋈ `vouchers.origin`
 * pairing — see the compare module's defer note).
 *
 * ─── Per-leg scope (mirrors each PG sub-query EXACTLY — scope VARIES) ──
 *
 * The PG composite uses DIFFERENT customer scopes per sub-query, so this twin
 * replicates each one:
 *   • PERIOD aggregates (deposits / wager / withdrawal / balance-change /
 *     manual-wd) → 3-role WHOLESALE (`role NOT IN ('admin','support','creator')`)
 *     + blacklist. (getPeriodAggregates' `real_users` drops creators, so its
 *     creator-on-session carve-out can never fire — `wager_excl_session` ≡
 *     `wager`; we compute one value.)
 *   • UPGRADER wager → 3-role WHOLESALE + blacklist (canonical `upgraderMetrics`).
 *   • WINDOWED inventory/voucher delta, BALANCES totals, USER counts, lifetime
 *     deposit counts, unique depositors, FTDs, 24h activity counts → 2-role
 *     (`role NOT IN ('admin','support')`, creators KEPT) + blacklist.
 *
 * ClickHouse correctness (PeerDB / ReplacingMergeTree mirrors):
 *   • FINAL + `_peerdb_is_deleted = 0` on every table.
 *   • Money stays Decimal end-to-end — toString(sum(...)) in SQL, toNumber() in
 *     TS, never Float. `if()` zero-branches use `toDecimal128(0, 2)` to keep the
 *     cents (a bare `0` truncates scale).
 *   • The Postgres `jsonb` metadata column is mirrored as a String;
 *     `metadata->>'adjustment_category'` maps to
 *     `JSONExtractString(metadata,'adjustment_category')`.
 *   • Membership tests over a Nullable column (`referred_by IN (...)`) are
 *     wrapped in `ifNull(..., 0)` so a NULL maps to the "not a member" branch
 *     (matching a PG `EXISTS` boolean) instead of vanishing.
 *
 * The blacklist is passed IN by the caller (resolved from the admin DB) so this
 * module never imports a Postgres client (CQRS boundary).
 */

/** Canonical ledger WAGER_TYPES (pack + battle + sponsorship). Inlined so this
 *  pure CH read never pulls the Prisma-backed ledger-sets module. Mirrors
 *  WAGER_TYPES_SQL === "('pack_opening','battle_bet','battle_sponsorship')". */
const WAGER_TYPES_SQL = "('pack_opening','battle_bet','battle_sponsorship')";
const BATTLE_WAGER_TYPES_SQL = "('battle_bet','battle_sponsorship')";

export type DashboardStatsCh = {
  // ── counts (exact) ──
  usersTotal: number;
  usersToday: number;
  usersWeek: number;
  usersMonth: number;
  signups24h: number;
  uniqueDepositors: number;
  depositCountLifetime: number;
  depositCount24h: number;
  depositCount7d: number;
  depositCountPeriod: number;
  withdrawalCountPeriod: number;
  ftds24h: number;
  packsOpened24h: number;
  battlesPlayed24h: number;
  // ── money (cent-exact) ──
  deposits: number;
  withdrawals: number;
  wagers: number;
  wagersPacks: number;
  wagersBattles: number;
  wagersUpgrader: number;
  wagersOrganic: number;
  wagersRaw: number;
  realizedPnlPeriod: number;
  totalDeposited: number;
  totalWithdrawn: number;
  totalWagered: number;
  totalWon: number;
  ftdTotal24h: number;
  // realized-P&L intermediates (money — surfaced for drift diagnosis)
  balanceChangePeriod: number;
  manualWdPeriod: number;
  inventoryChangePeriod: number;
  voucherChangePeriod: number;
};

export type DashboardStatsChArgs = {
  /** SQL cutoff for the period-bound 3-role + 2-role-delta legs (epoch for "all"). */
  periodCutoff: Date;
  /** Canonical metric-window start for the upgrader wager leg (365d-capped for "all"). */
  upgraderSince: Date;
  /** Boundaries for the 2-role user-count legs. */
  startOfDay: Date;
  startOfWeek: Date;
  startOfMonth: Date;
  /** Rolling-24h cutoff (user signups, FTDs, activity counts, 24h deposit count). */
  rolling24h: Date;
  /** Rolling-7d cutoff (7d deposit count). */
  rolling7d: Date;
};

/** 3-role wholesale scope (creators dropped), carrying the under_creator flag. */
function realUsers3WithUnderCreator(hasBlacklist: boolean): string {
  return `creators AS (
      SELECT id FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0 AND role = 'creator'
    ),
    real_users AS (
      SELECT
        u.id,
        ifNull(u.referred_by IN (SELECT id FROM creators), 0) AS under_creator
      FROM ${CH_DB}.public_user AS u FINAL
      WHERE u._peerdb_is_deleted = 0
        AND u.role NOT IN ('admin','support','creator')
        ${hasBlacklist ? "AND u.id NOT IN {blacklist:Array(String)}" : ""}
    )`;
}

/** 3-role wholesale scope (id only) — for the upgrader leg. */
function realUsers3(hasBlacklist: boolean): string {
  return `real_users AS (
      SELECT id FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support','creator')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;
}

/** 2-role scope (creators KEPT, id only). */
function realUsers2(hasBlacklist: boolean): string {
  return `real_users AS (
      SELECT id FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;
}

type LedgerRow = {
  deposits: string;
  deposit_count: string;
  wager: string;
  pack_wager: string;
  battle_wager: string;
  wager_organic: string;
  balance_change: string;
  manual_wd: string;
};
type CardRow = { withdrawal: string; withdrawal_count: string };
type UpgRow = { upg_wager: string };
type BalRow = {
  total_deposited: string;
  total_withdrawn: string;
  total_wagered: string;
  total_won: string;
  unique_depositors: string;
};
type UserRow = {
  total: string;
  today: string;
  week: string;
  month: string;
  rolling24h: string;
};
type DepCountRow = { lifetime: string; h24: string; d7: string };
type FtdRow = { cnt: string; total: string };
type ActivityRow = { packs: string; battles: string };

export async function getDashboardStatsFromClickHouse(
  args: DashboardStatsChArgs,
  blacklist: string[],
): Promise<DashboardStatsCh> {
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = {
    blacklist,
    cutoff: chDateTime(args.periodCutoff),
    upgraderSince: chDateTime(args.upgraderSince),
    startOfDay: chDateTime(args.startOfDay),
    startOfWeek: chDateTime(args.startOfWeek),
    startOfMonth: chDateTime(args.startOfMonth),
    rolling24h: chDateTime(args.rolling24h),
    rolling7d: chDateTime(args.rolling7d),
  };

  // official_stream fake-balance carve-out for the balance-delta term (mirrors
  // officialStreamAdjustmentSqlPredicate — only official_stream, NOT the full
  // stats-excluded set). JSONExtractString returns '' for a missing/null key,
  // which never equals the category, so an uncategorized adjustment falls to
  // the ELSE (counted) branch — same as the PG `IS NOT NULL` 3VL guard.
  const officialStream = `lt.type = 'admin_balance_adjustment' AND JSONExtractString(lt.metadata, 'adjustment_category') = 'official_stream'`;

  // ── 3-role period ledger aggregates ──
  const ledgerSql = `
    WITH ${realUsers3WithUnderCreator(hasBlacklist)}
    SELECT
      toString(sum(if(lt.type = 'deposit', lt.amount, toDecimal128(0, 2)))) AS deposits,
      toString(countIf(lt.type = 'deposit')) AS deposit_count,
      toString(sum(if(lt.type IN ${WAGER_TYPES_SQL}, lt.amount, toDecimal128(0, 2)))) AS wager,
      toString(sum(if(lt.type = 'pack_opening', lt.amount, toDecimal128(0, 2)))) AS pack_wager,
      toString(sum(if(lt.type IN ${BATTLE_WAGER_TYPES_SQL}, lt.amount, toDecimal128(0, 2)))) AS battle_wager,
      toString(sum(if(lt.type IN ${WAGER_TYPES_SQL} AND ru.under_creator = 0, lt.amount, toDecimal128(0, 2)))) AS wager_organic,
      toString(sum(if(${officialStream}, toDecimal128(0, 2), lt.balance_after - lt.balance_before))) AS balance_change,
      toString(sum(if(
        lt.type = 'admin_balance_adjustment'
        AND lt.balance_after < lt.balance_before
        AND lt.description ILIKE 'Manual withdrawal:%',
        lt.amount, toDecimal128(0, 2)))) AS manual_wd
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    JOIN real_users AS ru ON ru.id = lt.user_id
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.created_at >= {cutoff:DateTime64(6)}`;

  // ── 3-role period card-withdrawals (effective_at = COALESCE(completed_at, shipped_at)) ──
  const cardSql = `
    WITH ${realUsers3(hasBlacklist)}
    SELECT
      toString(sum(if(coalesce(cwr.completed_at, cwr.shipped_at) >= {cutoff:DateTime64(6)}, cwr.total_value_usd, toDecimal128(0, 2)))) AS withdrawal,
      toString(countIf(coalesce(cwr.completed_at, cwr.shipped_at) >= {cutoff:DateTime64(6)})) AS withdrawal_count
    FROM ${CH_DB}.public_card_withdrawal_requests AS cwr FINAL
    WHERE cwr._peerdb_is_deleted = 0
      AND cwr.status IN ('completed','shipped')
      AND coalesce(cwr.completed_at, cwr.shipped_at) >= {cutoff:DateTime64(6)}
      AND cwr.user_id IN (SELECT id FROM real_users)`;

  // ── 3-role upgrader wager (canonical metric window) ──
  const upgSql = `
    WITH ${realUsers3(hasBlacklist)}
    SELECT toString(sum(ug.bet_amount)) AS upg_wager
    FROM ${CH_DB}.public_upgrader_games AS ug FINAL
    WHERE ug._peerdb_is_deleted = 0
      AND ug.created_at >= {upgraderSince:DateTime64(6)}
      AND ug.user_id IN (SELECT id FROM real_users)`;

  // ── 2-role windowed inventory + voucher deltas ──
  const deltaInvSql = `
    WITH ${realUsers2(hasBlacklist)}
    SELECT
      toString(sum(if(ui.obtained_at >= {cutoff:DateTime64(6)}, ui.value_at_obtained, toDecimal128(0, 2)))) AS inv_obtained,
      toString(sum(if(
        ifNull(ui.sold_at >= {cutoff:DateTime64(6)}, 0) = 1
        OR ifNull(ui.exchanged_at >= {cutoff:DateTime64(6)}, 0) = 1,
        ui.value_at_obtained, toDecimal128(0, 2)))) AS inv_disposed
    FROM ${CH_DB}.public_user_inventory AS ui FINAL
    WHERE ui._peerdb_is_deleted = 0
      AND ui.user_id IN (SELECT id FROM real_users)`;
  const deltaVchSql = `
    WITH ${realUsers2(hasBlacklist)}
    SELECT
      toString(sum(if(v.created_at >= {cutoff:DateTime64(6)}, v.value, toDecimal128(0, 2)))) AS vch_issued,
      toString(sum(if(ifNull(v.claimed_at >= {cutoff:DateTime64(6)}, 0) = 1, v.value, toDecimal128(0, 2)))) AS vch_claimed
    FROM ${CH_DB}.public_vouchers AS v FINAL
    WHERE v._peerdb_is_deleted = 0
      AND v.user_id IN (SELECT id FROM real_users)`;

  // ── 2-role balances totals + unique depositors ──
  const balSql = `
    WITH ${realUsers2(hasBlacklist)}
    SELECT
      toString(sum(b.total_deposited)) AS total_deposited,
      toString(sum(b.total_withdrawn)) AS total_withdrawn,
      toString(sum(b.total_wagered))   AS total_wagered,
      toString(sum(b.total_won))       AS total_won,
      toString(countIf(b.total_deposited > 0)) AS unique_depositors
    FROM ${CH_DB}.public_balances AS b FINAL
    WHERE b._peerdb_is_deleted = 0
      AND b.user_id IN (SELECT id FROM real_users)`;

  // ── 2-role user counts (total + today/week/month + rolling-24h signups) ──
  const userSql = `
    SELECT
      toString(count())                                                       AS total,
      toString(countIf(created_at >= {startOfDay:DateTime64(6)}))             AS today,
      toString(countIf(created_at >= {startOfWeek:DateTime64(6)}))            AS week,
      toString(countIf(created_at >= {startOfMonth:DateTime64(6)}))           AS month,
      toString(countIf(created_at >= {rolling24h:DateTime64(6)}))             AS rolling24h
    FROM ${CH_DB}.public_user FINAL
    WHERE _peerdb_is_deleted = 0
      AND role NOT IN ('admin','support')
      ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}`;

  // ── 2-role lifetime/24h/7d completed-deposit counts ──
  const depCountSql = `
    WITH ${realUsers2(hasBlacklist)}
    SELECT
      toString(count())                                            AS lifetime,
      toString(countIf(lt.created_at >= {rolling24h:DateTime64(6)})) AS h24,
      toString(countIf(lt.created_at >= {rolling7d:DateTime64(6)}))  AS d7
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.type = 'deposit'
      AND lt.status = 'completed'
      AND lt.user_id IN (SELECT id FROM real_users)`;

  // ── 2-role rolling-24h FTDs (first completed deposit per user) ──
  const ftdSql = `
    WITH ${realUsers2(hasBlacklist)},
    first_deposits AS (
      SELECT
        lt.user_id,
        argMin(lt.amount, lt.created_at) AS amount,
        min(lt.created_at) AS first_at
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.type = 'deposit'
        AND lt.status = 'completed'
        AND lt.user_id IN (SELECT id FROM real_users)
      GROUP BY lt.user_id
    )
    SELECT
      toString(countIf(first_at >= {rolling24h:DateTime64(6)})) AS cnt,
      toString(sum(if(first_at >= {rolling24h:DateTime64(6)}, amount, toDecimal128(0, 2)))) AS total
    FROM first_deposits`;

  // ── 2-role rolling-24h activity counts (pack opens + battles) ──
  const packsSql = `
    WITH ${realUsers2(hasBlacklist)}
    SELECT toString(count()) AS packs, toString(0) AS battles
    FROM ${CH_DB}.public_game_sessions AS gs FINAL
    WHERE gs._peerdb_is_deleted = 0
      AND gs.game_type = 'pack'
      AND gs.created_at >= {rolling24h:DateTime64(6)}
      AND gs.user_id IN (SELECT id FROM real_users)`;
  const battlesSql = `
    WITH ${realUsers2(hasBlacklist)}
    SELECT toString(0) AS packs, toString(count()) AS battles
    FROM ${CH_DB}.public_battles AS b FINAL
    WHERE b._peerdb_is_deleted = 0
      AND b.created_at >= {rolling24h:DateTime64(6)}
      AND b.user_id IN (SELECT id FROM real_users)`;

  const [ledger, card, upg, dInv, dVch, bal, users, depCount, ftd, packs, battles] =
    await Promise.all([
      clickhouseRead.query<LedgerRow>({ queryName: "dashboard.stats.ledger", sql: ledgerSql, params }),
      clickhouseRead.query<CardRow>({ queryName: "dashboard.stats.card", sql: cardSql, params }),
      clickhouseRead.query<UpgRow>({ queryName: "dashboard.stats.upgrader", sql: upgSql, params }),
      clickhouseRead.query<{ inv_obtained: string; inv_disposed: string }>({ queryName: "dashboard.stats.invDelta", sql: deltaInvSql, params }),
      clickhouseRead.query<{ vch_issued: string; vch_claimed: string }>({ queryName: "dashboard.stats.vchDelta", sql: deltaVchSql, params }),
      clickhouseRead.query<BalRow>({ queryName: "dashboard.stats.balances", sql: balSql, params }),
      clickhouseRead.query<UserRow>({ queryName: "dashboard.stats.users", sql: userSql, params }),
      clickhouseRead.query<DepCountRow>({ queryName: "dashboard.stats.depCounts", sql: depCountSql, params }),
      clickhouseRead.query<FtdRow>({ queryName: "dashboard.stats.ftd", sql: ftdSql, params }),
      clickhouseRead.query<ActivityRow>({ queryName: "dashboard.stats.packs", sql: packsSql, params }),
      clickhouseRead.query<ActivityRow>({ queryName: "dashboard.stats.battles", sql: battlesSql, params }),
    ]);

  const l = ledger[0];
  const deposits = toNumber(l?.deposits);
  const depositCountPeriod = toNumber(l?.deposit_count);
  // wager_excl_session ≡ wager in the 3-role scope (no creator rows ⇒ no
  // in-session carve-out), so `wagers` and `wagersRaw` share the same ledger
  // sum — matching the identical PG payload values. abs(sum) mirrors the PG
  // payload's `Math.abs(num(pa.wager_*))`.
  const wagerLedger = Math.abs(toNumber(l?.wager));
  const packWager = Math.abs(toNumber(l?.pack_wager));
  const battleWager = Math.abs(toNumber(l?.battle_wager));
  const wagerOrganic = Math.abs(toNumber(l?.wager_organic));
  const balanceChangePeriod = toNumber(l?.balance_change);
  const manualWdPeriod = toNumber(l?.manual_wd);

  const cardWdPeriod = Math.abs(toNumber(card[0]?.withdrawal));
  const withdrawalCountPeriod = toNumber(card[0]?.withdrawal_count);
  const upgraderWager = toNumber(upg[0]?.upg_wager);

  const invObtained = toNumber(dInv[0]?.inv_obtained);
  const invDisposed = toNumber(dInv[0]?.inv_disposed);
  const inventoryChangePeriod = invObtained - invDisposed;
  const vchIssued = toNumber(dVch[0]?.vch_issued);
  const vchClaimed = toNumber(dVch[0]?.vch_claimed);
  const voucherChangePeriod = vchIssued - vchClaimed;

  const realizedPnlPeriod =
    deposits -
    (manualWdPeriod + cardWdPeriod) -
    balanceChangePeriod -
    inventoryChangePeriod -
    voucherChangePeriod;

  const b = bal[0];
  const u = users[0];
  const dc = depCount[0];

  return {
    usersTotal: toNumber(u?.total),
    usersToday: toNumber(u?.today),
    usersWeek: toNumber(u?.week),
    usersMonth: toNumber(u?.month),
    signups24h: toNumber(u?.rolling24h),
    uniqueDepositors: toNumber(b?.unique_depositors),
    depositCountLifetime: toNumber(dc?.lifetime),
    depositCount24h: toNumber(dc?.h24),
    depositCount7d: toNumber(dc?.d7),
    depositCountPeriod,
    withdrawalCountPeriod,
    ftds24h: toNumber(ftd[0]?.cnt),
    packsOpened24h: toNumber(packs[0]?.packs),
    battlesPlayed24h: toNumber(battles[0]?.battles),

    deposits,
    withdrawals: cardWdPeriod,
    wagers: wagerLedger + upgraderWager,
    wagersPacks: packWager,
    wagersBattles: battleWager,
    wagersUpgrader: upgraderWager,
    wagersOrganic: wagerOrganic,
    wagersRaw: wagerLedger + upgraderWager,
    realizedPnlPeriod,
    totalDeposited: toNumber(b?.total_deposited),
    totalWithdrawn: toNumber(b?.total_withdrawn),
    totalWagered: toNumber(b?.total_wagered),
    totalWon: toNumber(b?.total_won),
    ftdTotal24h: toNumber(ftd[0]?.total),

    balanceChangePeriod,
    manualWdPeriod,
    inventoryChangePeriod,
    voucherChangePeriod,
  };
}
