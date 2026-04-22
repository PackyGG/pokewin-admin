import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { AffiliateAnalyticsData } from "./creators-types";

type Period = "today" | "7d" | "30d" | "90d" | "all";

function periodToDateFilter(period: Period): string {
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

export async function getAffiliateAnalytics(period: Period): Promise<AffiliateAnalyticsData> {
  const db = await getDb();
  const dateFilter = periodToDateFilter(period);

  const [signupsAgg, payoutsAgg, usagesAgg, clicksAgg, activeCreators, dailyUsages, dailyClicks] =
    await Promise.all([
      // Signups = rows with the dedicated `signup` usage_type written
      // when a new user registers via an affiliate code. Previously
      // this query counted `deposit` rows under the "signups" label,
      // which double-counted every deposit and ignored users who
      // signed up but never deposited.
      db.$queryRawUnsafe<{ count: string }[]>(`
        SELECT COUNT(*)::text AS count
        FROM affiliate_code_usages
        WHERE usage_type = 'signup' ${dateFilter}
      `),
      db.$queryRawUnsafe<{ total: string }[]>(`
        SELECT COALESCE(SUM(amount_usd::numeric), 0)::text AS total
        FROM affiliate_payouts
        WHERE status = 'paid' ${dateFilter}
      `),
      db.$queryRawUnsafe<{ wager: string; deposit: string }[]>(`
        SELECT
          COALESCE(SUM(wager_amount_usd::numeric), 0)::text AS wager,
          COALESCE(SUM(deposit_amount_usd::numeric), 0)::text AS deposit
        FROM affiliate_code_usages
        WHERE 1=1 ${dateFilter}
      `),
      db.$queryRawUnsafe<{ count: string }[]>(`
        SELECT COUNT(*)::text AS count
        FROM affiliate_clicks
        WHERE 1=1 ${dateFilter}
      `),
      db.affiliate_accounts.count({
        where: {
          user: { role: "creator", affiliate_code_active: true },
        },
      }),
      db.$queryRawUnsafe<
        { date: Date; signups: string; wager: string; deposit: string; commission: string }[]
      >(`
        SELECT
          DATE(created_at) AS date,
          COUNT(CASE WHEN usage_type = 'signup' THEN 1 END)::text AS signups,
          COALESCE(SUM(wager_amount_usd::numeric), 0)::text AS wager,
          COALESCE(SUM(deposit_amount_usd::numeric), 0)::text AS deposit,
          COALESCE(SUM(referrer_cut_usd::numeric), 0)::text AS commission
        FROM affiliate_code_usages
        WHERE 1=1 ${dateFilter}
        GROUP BY DATE(created_at)
        ORDER BY date
      `),
      db.$queryRawUnsafe<{ date: Date; clicks: string }[]>(`
        SELECT DATE(created_at) AS date, COUNT(*)::text AS clicks
        FROM affiliate_clicks
        WHERE 1=1 ${dateFilter}
        GROUP BY DATE(created_at)
        ORDER BY date
      `),
    ]);

  const clicksMap = new Map(
    dailyClicks.map((d) => [new Date(d.date).toISOString().split("T")[0], Number(d.clicks)])
  );

  const daily = dailyUsages.map((d) => {
    const dateStr = new Date(d.date).toISOString().split("T")[0];
    return {
      date: dateStr,
      signups: Number(d.signups),
      commission: toNumber(d.commission),
      wagerVolume: toNumber(d.wager),
      depositVolume: toNumber(d.deposit),
      clicks: clicksMap.get(dateStr) ?? 0,
    };
  });

  for (const [dateStr, clicks] of clicksMap) {
    if (!daily.find((d) => d.date === dateStr)) {
      daily.push({ date: dateStr, signups: 0, commission: 0, wagerVolume: 0, depositVolume: 0, clicks });
    }
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));

  return {
    totalSignups: Number(signupsAgg[0]?.count ?? 0),
    totalCommissionPaid: toNumber(payoutsAgg[0]?.total),
    totalWagerVolume: toNumber(usagesAgg[0]?.wager),
    totalDepositVolume: toNumber(usagesAgg[0]?.deposit),
    totalClicks: Number(clicksAgg[0]?.count ?? 0),
    activeCreators,
    daily,
  };
}

export async function getAffiliateLevelConfigs() {
  const db = await getDb();
  const configs = await db.affiliate_level_configs.findMany({
    orderBy: { level: "asc" },
  });
  return configs.map((c) => ({
    level: c.level,
    label: c.label,
    commission_rate: toNumber(c.commission_rate),
    threshold: toNumber(c.threshold),
  }));
}
