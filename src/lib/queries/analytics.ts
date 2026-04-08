import { db } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

type Period = "today" | "7d" | "30d" | "90d" | "all";

function periodToDateFilter(period: Period): string {
  // Values are hardcoded — no injection risk with $queryRawUnsafe
  switch (period) {
    case "today":
      return "AND created_at >= NOW() - INTERVAL '1 day'";
    case "7d":
      return "AND created_at >= NOW() - INTERVAL '7 days'";
    case "30d":
      return "AND created_at >= NOW() - INTERVAL '30 days'";
    case "90d":
      return "AND created_at >= NOW() - INTERVAL '90 days'";
    case "all":
      return "";
  }
}

export type BattleModeStats = {
  totalBattles: number;
  byMode: { mode: string; count: number }[];
  bySetting: { setting: string; count: number }[];
  byFormat: { format: string; count: number }[];
  borrowCount: number;
  sponsoredCount: number;
  privateCount: number;
  topBattlePacks: { id: string; name: string; count: number }[];
};

export type PackPopularityStats = {
  topPacks: {
    id: string;
    name: string;
    opensTotal: number;
    opensBorrowed: number;
    opensNormal: number;
  }[];
  topBorrowedPacks: {
    id: string;
    name: string;
    opensBorrowed: number;
    opensTotal: number;
  }[];
};

export type AnalyticsData = {
  ggr: number;
  ngr: number;
  realizedProfit: number;
  realizedProfitBreakdown: {
    totalDeposits: number;
    totalWithdrawals: number;
    openBalances: number;
    rewardsClaimed: number;
  };
  uniqueVisitors: number;
  newSignups: number;
  packWager: number;
  battleWager: number;
  packWagerBorrowed: number;
  battleWagerBorrowed: number;
  battleStats: BattleModeStats;
  packStats: PackPopularityStats;
  daily: {
    date: string;
    ggr: number;
    ngr: number;
    packWager: number;
    battleWager: number;
    uniqueVisitors: number;
    newSignups: number;
    avgDeposit: number;
    avgBet: number;
  }[];
};

export async function getAnalyticsData(period: Period): Promise<AnalyticsData> {
  const dateFilter = periodToDateFilter(period);
  // Same filter, but without the leading "AND " because it'll be the only WHERE condition
  const battleDateWhere =
    period === "all"
      ? ""
      : `WHERE created_at >= NOW() - INTERVAL '${parseDays(period)} days'`;
  const battleDateWhereAliased =
    period === "all"
      ? ""
      : `WHERE b.created_at >= NOW() - INTERVAL '${parseDays(period)} days'`;

  const signupsDateFilter =
    period !== "all"
      ? { created_at: { gte: new Date(Date.now() - parseDays(period) * 86_400_000) } }
      : {};

  const [
    aggregates,
    signups,
    visitors,
    dailyTx,
    dailySignups,
    battleModeRows,
    battleSettingRows,
    battleFlags,
    battleFormatRows,
    topBattlePackRows,
    topPacksRows,
    realizedProfitRow,
  ] = await Promise.all([
      db.$queryRawUnsafe<
        {
          total_wagers: string;
          total_payouts: string;
          total_bonuses: string;
          pack_wager: string;
          battle_wager: string;
          pack_wager_borrowed: string;
          battle_wager_borrowed: string;
        }[]
      >(`
        SELECT
          COALESCE(SUM(CASE
            WHEN type IN ('pack_opening', 'battle_bet', 'battle_sponsorship')
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS total_wagers,
          COALESCE(SUM(CASE
            WHEN type IN ('battle_refund', 'card_sale', 'reward_card_sale')
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS total_payouts,
          COALESCE(SUM(CASE
            WHEN type IN ('deposit_bonus', 'promo_code_redeemed', 'gift_card_redeemed',
              'rakeback_claim', 'affiliate_claim', 'rain_win', 'race_prize',
              'creator_tip', 'waitlist_prize', 'voucher_redeemed', 'voucher_exchange',
              'exchange_excess_credit', 'exchange_excess_to_voucher', 'battle_excess_to_voucher')
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS total_bonuses,
          COALESCE(SUM(CASE
            WHEN type = 'pack_opening'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager,
          COALESCE(SUM(CASE
            WHEN type IN ('battle_bet', 'battle_sponsorship')
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager,
          COALESCE(SUM(CASE
            WHEN type = 'pack_opening' AND description ILIKE '%borrow%'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager_borrowed,
          COALESCE(SUM(CASE
            WHEN type = 'battle_bet' AND description ILIKE '%borrow%'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager_borrowed
        FROM ledger_transactions
        WHERE status = 'completed' ${dateFilter}
      `),
      db.user.count({ where: signupsDateFilter }),
      db.$queryRawUnsafe<{ count: string }[]>(`
        SELECT COUNT(DISTINCT user_id)::text AS count
        FROM ledger_transactions
        WHERE status = 'completed' ${dateFilter}
      `),
      db.$queryRawUnsafe<
        {
          date: Date;
          total_wagers: string;
          total_payouts: string;
          total_bonuses: string;
          pack_wager: string;
          battle_wager: string;
          unique_visitors: string;
          avg_deposit: string;
          avg_bet: string;
        }[]
      >(`
        SELECT
          DATE(created_at) AS date,
          COALESCE(SUM(CASE
            WHEN type IN ('pack_opening', 'battle_bet', 'battle_sponsorship')
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS total_wagers,
          COALESCE(SUM(CASE
            WHEN type IN ('battle_refund', 'card_sale', 'reward_card_sale')
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS total_payouts,
          COALESCE(SUM(CASE
            WHEN type IN ('deposit_bonus', 'promo_code_redeemed', 'gift_card_redeemed',
              'rakeback_claim', 'affiliate_claim', 'rain_win', 'race_prize',
              'creator_tip', 'waitlist_prize', 'voucher_redeemed', 'voucher_exchange',
              'exchange_excess_credit', 'exchange_excess_to_voucher', 'battle_excess_to_voucher')
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS total_bonuses,
          COALESCE(SUM(CASE
            WHEN type = 'pack_opening'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager,
          COALESCE(SUM(CASE
            WHEN type IN ('battle_bet', 'battle_sponsorship')
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager,
          COUNT(DISTINCT user_id)::text AS unique_visitors,
          COALESCE(AVG(CASE
            WHEN type = 'deposit'
            THEN ABS(amount::numeric) END), 0)::text AS avg_deposit,
          COALESCE(AVG(CASE
            WHEN type IN ('pack_opening', 'battle_bet', 'battle_sponsorship')
            THEN ABS(amount::numeric) END), 0)::text AS avg_bet
        FROM ledger_transactions
        WHERE status = 'completed' ${dateFilter}
        GROUP BY DATE(created_at)
        ORDER BY date
      `),
      db.$queryRawUnsafe<{ date: Date; count: string }[]>(`
        SELECT DATE(created_at) AS date, COUNT(*)::text AS count
        FROM "user"
        WHERE 1=1 ${dateFilter}
        GROUP BY DATE(created_at)
        ORDER BY date
      `),
      db.$queryRawUnsafe<{ mode: string; count: string }[]>(`
        SELECT mode::text AS mode, COUNT(*)::text AS count
        FROM battles
        ${battleDateWhere}
        GROUP BY mode
        ORDER BY COUNT(*) DESC
      `),
      db.$queryRawUnsafe<{ setting: string; count: string }[]>(`
        SELECT setting, COUNT(*)::text AS count
        FROM battles, UNNEST(additional_settings) AS setting
        ${battleDateWhere}
        GROUP BY setting
        ORDER BY COUNT(*) DESC
      `),
      db.$queryRawUnsafe<
        {
          total_battles: string;
          borrow_count: string;
          sponsored_count: string;
          private_count: string;
        }[]
      >(`
        SELECT
          COUNT(*)::text AS total_battles,
          COUNT(*) FILTER (WHERE borrow_percentage > 0)::text AS borrow_count,
          COUNT(*) FILTER (WHERE sponsorship_percentage > 0)::text AS sponsored_count,
          COUNT(*) FILTER (WHERE password IS NOT NULL)::text AS private_count
        FROM battles
        ${battleDateWhere}
      `),
      db.$queryRawUnsafe<{ teams: number; players_per_team: number; count: string }[]>(`
        SELECT teams, players_per_team, COUNT(*)::text AS count
        FROM battles
        ${battleDateWhere}
        GROUP BY teams, players_per_team
        ORDER BY COUNT(*) DESC
      `),
      db.$queryRawUnsafe<{ id: string; name: string; count: string }[]>(`
        SELECT p.id::text AS id, p.name AS name, COUNT(*)::text AS count
        FROM battles b
        CROSS JOIN LATERAL UNNEST(b.pack_ids::uuid[]) AS pid
        JOIN packs p ON p.id = pid
        ${battleDateWhereAliased}
        GROUP BY p.id, p.name
        ORDER BY COUNT(*) DESC
        LIMIT 10
      `),
      db.$queryRawUnsafe<
        {
          id: string;
          name: string;
          opens_total: string;
          opens_borrowed: string;
        }[]
      >(`
        SELECT
          p.id::text AS id,
          p.name AS name,
          COUNT(*)::text AS opens_total,
          COUNT(*) FILTER (WHERE lt.description ILIKE '%borrow%')::text AS opens_borrowed
        FROM ledger_transactions lt
        JOIN game_sessions gs ON lt.game_session_id = gs.id AND gs.game_type = 'pack'
        JOIN packs p ON gs.game_id = p.id
        WHERE lt.type = 'pack_opening' AND lt.status = 'completed' ${dateFilter.replace(/created_at/g, "lt.created_at")}
        GROUP BY p.id, p.name
        ORDER BY COUNT(*) DESC
        LIMIT 20
      `),
      db.$queryRawUnsafe<
        {
          total_deposits: string;
          total_withdrawals: string;
          open_balances: string;
          rewards_claimed: string;
        }[]
      >(`
        SELECT
          (SELECT COALESCE(SUM(ABS(amount::numeric)), 0)
             FROM ledger_transactions
             WHERE type = 'deposit' AND status = 'completed')::text AS total_deposits,
          (SELECT COALESCE(SUM(total_value_usd::numeric), 0)
             FROM card_withdrawal_requests
             WHERE status IN ('completed', 'shipped'))::text AS total_withdrawals,
          (SELECT COALESCE(SUM(available_balance::numeric + locked_balance::numeric), 0)
             FROM balances)::text AS open_balances,
          (SELECT COALESCE(SUM(ABS(amount::numeric)), 0)
             FROM ledger_transactions
             WHERE status = 'completed'
               AND type IN (
                 'deposit_bonus','promo_code_redeemed','gift_card_redeemed',
                 'rakeback_claim','balance_reward_claim','affiliate_claim',
                 'rain_win','race_prize','creator_tip','waitlist_prize'
               ))::text AS rewards_claimed
      `),
    ]);

  const agg = aggregates[0];
  const totalWagers = toNumber(agg?.total_wagers);
  const totalPayouts = toNumber(agg?.total_payouts);
  const totalBonuses = toNumber(agg?.total_bonuses);
  const ggr = totalWagers - totalPayouts;
  const ngr = ggr - totalBonuses;

  // Merge daily transaction data with daily signups
  const signupsMap = new Map(
    dailySignups.map((d) => [
      new Date(d.date).toISOString().split("T")[0],
      Number(d.count),
    ])
  );

  const daily = dailyTx.map((d) => {
    const dateStr = new Date(d.date).toISOString().split("T")[0];
    const dayWagers = toNumber(d.total_wagers);
    const dayPayouts = toNumber(d.total_payouts);
    const dayBonuses = toNumber(d.total_bonuses);
    return {
      date: dateStr,
      ggr: dayWagers - dayPayouts,
      ngr: dayWagers - dayPayouts - dayBonuses,
      packWager: toNumber(d.pack_wager),
      battleWager: toNumber(d.battle_wager),
      uniqueVisitors: Number(d.unique_visitors),
      newSignups: signupsMap.get(dateStr) ?? 0,
      avgDeposit: toNumber(d.avg_deposit),
      avgBet: toNumber(d.avg_bet),
    };
  });

  // Add days that have signups but no transactions
  for (const [dateStr, count] of signupsMap) {
    if (!daily.find((d) => d.date === dateStr)) {
      daily.push({
        date: dateStr,
        ggr: 0,
        ngr: 0,
        packWager: 0,
        battleWager: 0,
        uniqueVisitors: 0,
        newSignups: count,
        avgDeposit: 0,
        avgBet: 0,
      });
    }
  }

  daily.sort((a, b) => a.date.localeCompare(b.date));

  const rp = realizedProfitRow[0];
  const totalDeposits = toNumber(rp?.total_deposits);
  const totalWithdrawals = toNumber(rp?.total_withdrawals);
  const openBalances = toNumber(rp?.open_balances);
  const rewardsClaimed = toNumber(rp?.rewards_claimed);
  const realizedProfit = totalDeposits - totalWithdrawals - openBalances;

  return {
    ggr,
    ngr,
    realizedProfit,
    realizedProfitBreakdown: {
      totalDeposits,
      totalWithdrawals,
      openBalances,
      rewardsClaimed,
    },
    uniqueVisitors: Number(visitors[0]?.count ?? 0),
    newSignups: signups,
    packWager: toNumber(agg?.pack_wager),
    battleWager: toNumber(agg?.battle_wager),
    packWagerBorrowed: toNumber(agg?.pack_wager_borrowed),
    battleWagerBorrowed: toNumber(agg?.battle_wager_borrowed),
    battleStats: {
      totalBattles: Number(battleFlags[0]?.total_battles ?? 0),
      byMode: battleModeRows.map((r) => ({ mode: r.mode, count: Number(r.count) })),
      bySetting: battleSettingRows.map((r) => ({
        setting: r.setting,
        count: Number(r.count),
      })),
      byFormat: battleFormatRows.map((r) => ({
        format:
          r.teams === 2 && r.players_per_team === 1
            ? "1v1"
            : Array(Number(r.teams))
                .fill(String(Number(r.players_per_team)))
                .join("v"),
        count: Number(r.count),
      })),
      borrowCount: Number(battleFlags[0]?.borrow_count ?? 0),
      sponsoredCount: Number(battleFlags[0]?.sponsored_count ?? 0),
      privateCount: Number(battleFlags[0]?.private_count ?? 0),
      topBattlePacks: topBattlePackRows.map((r) => ({
        id: r.id,
        name: r.name,
        count: Number(r.count),
      })),
    },
    packStats: {
      topPacks: topPacksRows.map((r) => {
        const total = Number(r.opens_total);
        const borrowed = Number(r.opens_borrowed);
        return {
          id: r.id,
          name: r.name,
          opensTotal: total,
          opensBorrowed: borrowed,
          opensNormal: total - borrowed,
        };
      }),
      topBorrowedPacks: [...topPacksRows]
        .map((r) => ({
          id: r.id,
          name: r.name,
          opensBorrowed: Number(r.opens_borrowed),
          opensTotal: Number(r.opens_total),
        }))
        .filter((p) => p.opensBorrowed > 0)
        .sort((a, b) => b.opensBorrowed - a.opensBorrowed)
        .slice(0, 10),
    },
    daily,
  };
}

function parseDays(period: Period): number {
  switch (period) {
    case "today":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      return 36500;
  }
}
