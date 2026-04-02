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

export type AnalyticsData = {
  ggr: number;
  ngr: number;
  uniqueVisitors: number;
  newSignups: number;
  packWager: number;
  battleWager: number;
  daily: {
    date: string;
    ggr: number;
    ngr: number;
    packWager: number;
    battleWager: number;
    uniqueVisitors: number;
    newSignups: number;
  }[];
};

export async function getAnalyticsData(period: Period): Promise<AnalyticsData> {
  const dateFilter = periodToDateFilter(period);

  const signupsDateFilter =
    period !== "all"
      ? { created_at: { gte: new Date(Date.now() - parseDays(period) * 86_400_000) } }
      : {};

  const [aggregates, signups, visitors, dailyTx, dailySignups] =
    await Promise.all([
      db.$queryRawUnsafe<
        {
          total_wagers: string;
          total_payouts: string;
          total_bonuses: string;
          pack_wager: string;
          battle_wager: string;
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
              'creator_tip', 'waitlist_prize')
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS total_bonuses,
          COALESCE(SUM(CASE
            WHEN type = 'pack_opening'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager,
          COALESCE(SUM(CASE
            WHEN type IN ('battle_bet', 'battle_sponsorship')
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager
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
              'creator_tip', 'waitlist_prize')
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS total_bonuses,
          COALESCE(SUM(CASE
            WHEN type = 'pack_opening'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager,
          COALESCE(SUM(CASE
            WHEN type IN ('battle_bet', 'battle_sponsorship')
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager,
          COUNT(DISTINCT user_id)::text AS unique_visitors
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
      });
    }
  }

  daily.sort((a, b) => a.date.localeCompare(b.date));

  return {
    ggr,
    ngr,
    uniqueVisitors: Number(visitors[0]?.count ?? 0),
    newSignups: signups,
    packWager: toNumber(agg?.pack_wager),
    battleWager: toNumber(agg?.battle_wager),
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
