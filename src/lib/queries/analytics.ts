import { db } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getRealizedPnlSnapshot } from "./_realized-pnl";
// SQL fragment for user_id filtering — injected via string concat (safe: hardcoded role name)
const EXCL_STAFF_FRAG = `AND user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin','creator'))`;

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
    userBalance: number;
    inventory: number;
    vouchers: number;
    unclaimedRakeback: number;
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
    totalDeposit: number;
    totalBet: number;
    minDeposit: number;
    maxDeposit: number;
    minBet: number;
    maxBet: number;
    rewardRakeback: number;
    rewardSignupPacks: number;
    rewardLeaderboard: number;
    rewardRain: number;
    rewardPromo: number;
    rewardAffiliate: number;
  }[];
};

export async function getAnalyticsData(period: Period): Promise<AnalyticsData> {
  const dateFilter = periodToDateFilter(period);
  // Same filter, but without the leading "AND " because it'll be the only WHERE condition
  // Exclude battles created by admin/creator (support counts as normal user)
  const battleStaffExcl = `user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin','creator'))`;
  const battleStaffExclAliased = `b.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin','creator'))`;

  const battleDateWhere =
    period === "all"
      ? `WHERE ${battleStaffExcl}`
      : `WHERE created_at >= NOW() - INTERVAL '${parseDays(period)} days' AND ${battleStaffExcl}`;
  const battleDateWhereAliased =
    period === "all"
      ? `WHERE ${battleStaffExclAliased}`
      : `WHERE b.created_at >= NOW() - INTERVAL '${parseDays(period)} days' AND ${battleStaffExclAliased}`;

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
    realizedPnl,
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
        WHERE status = 'completed' ${dateFilter} ${EXCL_STAFF_FRAG}
      `),
      db.user.count({ where: { ...signupsDateFilter, role: { notIn: ["admin", "creator"] } } }),
      db.$queryRawUnsafe<{ count: string }[]>(`
        SELECT COUNT(DISTINCT user_id)::text AS count
        FROM ledger_transactions
        WHERE status = 'completed' ${dateFilter} ${EXCL_STAFF_FRAG}
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
          total_deposit: string;
          total_bet: string;
          min_deposit: string;
          max_deposit: string;
          min_bet: string;
          max_bet: string;
          reward_rakeback: string;
          reward_signup_packs: string;
          reward_leaderboard: string;
          reward_rain: string;
          reward_promo: string;
          reward_affiliate: string;
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
          COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY
            CASE WHEN type = 'deposit'
              THEN ABS(amount::numeric) END
          ), 0)::text AS avg_deposit,
          COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY
            CASE WHEN type IN ('pack_opening', 'battle_bet', 'battle_sponsorship')
              THEN ABS(amount::numeric) END
          ), 0)::text AS avg_bet,
          COALESCE(SUM(CASE
            WHEN type = 'deposit'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS total_deposit,
          COALESCE(SUM(CASE
            WHEN type IN ('pack_opening', 'battle_bet', 'battle_sponsorship')
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS total_bet,
          COALESCE(MIN(CASE
            WHEN type = 'deposit'
            THEN ABS(amount::numeric) END), 0)::text AS min_deposit,
          COALESCE(MAX(CASE
            WHEN type = 'deposit'
            THEN ABS(amount::numeric) END), 0)::text AS max_deposit,
          COALESCE(MIN(CASE
            WHEN type IN ('pack_opening', 'battle_bet', 'battle_sponsorship')
            THEN ABS(amount::numeric) END), 0)::text AS min_bet,
          COALESCE(MAX(CASE
            WHEN type IN ('pack_opening', 'battle_bet', 'battle_sponsorship')
            THEN ABS(amount::numeric) END), 0)::text AS max_bet,
          COALESCE(SUM(CASE
            WHEN type = 'rakeback_claim'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS reward_rakeback,
          COALESCE(SUM(CASE
            WHEN type = 'balance_reward_claim'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS reward_signup_packs,
          COALESCE(SUM(CASE
            WHEN type = 'race_prize'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS reward_leaderboard,
          COALESCE(SUM(CASE
            WHEN type = 'rain_win'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS reward_rain,
          COALESCE(SUM(CASE
            WHEN type = 'promo_code_redeemed'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS reward_promo,
          COALESCE(SUM(CASE
            WHEN type = 'affiliate_claim'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS reward_affiliate
        FROM ledger_transactions
        WHERE status = 'completed' ${dateFilter} ${EXCL_STAFF_FRAG}
        GROUP BY DATE(created_at)
        ORDER BY date
      `),
      db.$queryRawUnsafe<{ date: Date; count: string }[]>(`
        SELECT DATE(created_at) AS date, COUNT(*)::text AS count
        FROM "user"
        WHERE role NOT IN ('admin','creator') ${dateFilter}
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
          AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin','creator'))
        GROUP BY p.id, p.name
        ORDER BY COUNT(*) DESC
        LIMIT 20
      `),
      // Realized P&L is period-independent (balance-sheet snapshot). Uses the
      // shared helper so the number matches the Dashboard page exactly.
      getRealizedPnlSnapshot(),
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
      totalDeposit: toNumber(d.total_deposit),
      totalBet: toNumber(d.total_bet),
      minDeposit: toNumber(d.min_deposit),
      maxDeposit: toNumber(d.max_deposit),
      minBet: toNumber(d.min_bet),
      maxBet: toNumber(d.max_bet),
      rewardRakeback: toNumber(d.reward_rakeback),
      rewardSignupPacks: toNumber(d.reward_signup_packs),
      rewardLeaderboard: toNumber(d.reward_leaderboard),
      rewardRain: toNumber(d.reward_rain),
      rewardPromo: toNumber(d.reward_promo),
      rewardAffiliate: toNumber(d.reward_affiliate),
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
        totalDeposit: 0,
        totalBet: 0,
        minDeposit: 0,
        maxDeposit: 0,
        minBet: 0,
        maxBet: 0,
        rewardRakeback: 0,
        rewardSignupPacks: 0,
        rewardLeaderboard: 0,
        rewardRain: 0,
        rewardPromo: 0,
        rewardAffiliate: 0,
      });
    }
  }

  daily.sort((a, b) => a.date.localeCompare(b.date));

  return {
    ggr,
    ngr,
    realizedProfit: realizedPnl.pnl,
    realizedProfitBreakdown: {
      totalDeposits: realizedPnl.totalDeposited,
      totalWithdrawals: realizedPnl.totalWithdrawn,
      userBalance: realizedPnl.userBalance,
      inventory: realizedPnl.inventory,
      vouchers: realizedPnl.vouchers,
      unclaimedRakeback: realizedPnl.unclaimedRakeback,
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
