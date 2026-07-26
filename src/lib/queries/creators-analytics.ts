import { unstable_cache } from "next/cache";
import { getDrizzleDb } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { realCustomerIdsSubquery } from "./_blacklist";
import type { AffiliateAnalyticsData } from "./creators-types";

type Period = "today" | "7d" | "30d" | "90d" | "all";

// Lifetime (`all`) is capped at this lookback rather than scanning the
// entire affiliate_code_usages / affiliate_clicks / affiliate_payouts
// history with no lower bound — the unbounded-lifetime pattern CLAUDE.md
// ("Performance & Daten-Laden") forbids. Mirrors the reward-side
// `INSIGHTS_LIFETIME_LOOKBACK_DAYS` (365d). No-op on current data
// (< 90d old); bounds pathological future scans.
const LIFETIME_LOOKBACK_DAYS = 365;

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
      return `AND created_at >= NOW() - INTERVAL '${LIFETIME_LOOKBACK_DAYS} days'`;
  }
}

async function computeAffiliateAnalytics(
  period: Period,
  excluded: string[],
): Promise<AffiliateAnalyticsData> {
  const queryDb = await getDrizzleDb();
  const dateFilter = periodToDateFilter(period);
  const referredScope = realCustomerIdsSubquery(excluded);
  const referredFilter = `AND referred_user_id IN ${referredScope}`;

  const [signupsAgg, payoutsAgg, usagesAgg, clicksAgg, activeCreators, dailyUsages, dailyClicks] =
    await Promise.all([
      // usage_type compared via ::text (NOT the bare enum): live prod's
      // usage_type enum has no 'signup' label, and a bare comparison
      // against an unknown label throws 22P02 at parse time (ffa61b5c
      // class) — taking the whole analytics page down. ::text compares
      // false instead, so a missing label just counts 0.
      queryRows<{ count: string }[]>(queryDb, `
        SELECT COUNT(*)::text AS count
        FROM affiliate_code_usages
        WHERE usage_type::text = 'signup' ${referredFilter} ${dateFilter}
      `),
      queryRows<{ total: string }[]>(queryDb, `
        SELECT COALESCE(SUM(amount_usd::numeric), 0)::text AS total
        FROM affiliate_payouts
        WHERE status = 'paid' ${dateFilter}
      `),
      queryRows<{ wager: string; deposit: string }[]>(queryDb, `
        SELECT
          COALESCE(SUM(wager_amount_usd::numeric), 0)::text AS wager,
          COALESCE(SUM(deposit_amount_usd::numeric), 0)::text AS deposit
        FROM affiliate_code_usages
        WHERE 1=1 ${referredFilter} ${dateFilter}
      `),
      queryRows<{ count: string }[]>(queryDb, `
        SELECT COUNT(*)::text AS count
        FROM affiliate_clicks
        WHERE 1=1 ${dateFilter}
      `),
      queryRows<{ count: string }[]>(
        queryDb,
        `SELECT COUNT(*)::text AS count
         FROM affiliate_accounts aa
         JOIN "user" u ON u.id = aa.user_id
         WHERE u.role::text = 'creator'
           AND u.affiliate_code_active = true`,
      ).then((rows) => Number(rows[0]?.count ?? 0)),
      queryRows<
        { date: Date; signups: string; wager: string; deposit: string; commission: string }[]
      >(queryDb, `
        SELECT
          DATE(created_at) AS date,
          COUNT(CASE WHEN usage_type::text = 'signup' THEN 1 END)::text AS signups,
          COALESCE(SUM(wager_amount_usd::numeric), 0)::text AS wager,
          COALESCE(SUM(deposit_amount_usd::numeric), 0)::text AS deposit,
          COALESCE(SUM(referrer_cut_usd::numeric), 0)::text AS commission
        FROM affiliate_code_usages
        WHERE 1=1 ${referredFilter} ${dateFilter}
        GROUP BY DATE(created_at)
        ORDER BY date
      `),
      queryRows<{ date: Date; clicks: string }[]>(queryDb, `
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

/**
 * Cross-request cache for the creator/affiliate analytics bundle that backs
 * `/creators/analytics`. The page re-runs its server component for every
 * viewer; without a shared cache the 7-query affiliate aggregate batch
 * (signups / payouts / usages / clicks / daily series) re-ran per render.
 * Two `unstable_cache` layers — 60s for the finite windows, 300s for the
 * lifetime view — both keyed on `(period, sortedBlacklist)` so an
 * excluded-users edit busts stale aggregates. Logic identical to
 * `computeAffiliateAnalytics`; mirrors the `getAnalyticsData` cache idiom in
 * `analytics.ts`.
 *
 * NOTE: the `all` window is bounded by the 365d house-convention cap
 * (`LIFETIME_LOOKBACK_DAYS`, see `periodToDateFilter`) rather than an
 * unbounded full-history scan. No-op on current data (< 90d old); bounds
 * pathological future scans.
 */
const cachedAffiliateAnalytics = unstable_cache(
  computeAffiliateAnalytics,
  ["creators-affiliate-analytics-v1"],
  { revalidate: 60, tags: ["creators-analytics"] },
);

const cachedAffiliateAnalyticsLifetime = unstable_cache(
  computeAffiliateAnalytics,
  ["creators-affiliate-analytics-lifetime-v1"],
  { revalidate: 300, tags: ["creators-analytics"] },
);

export async function getAffiliateAnalytics(
  period: Period,
): Promise<AffiliateAnalyticsData> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return period === "all"
    ? cachedAffiliateAnalyticsLifetime(period, sorted)
    : cachedAffiliateAnalytics(period, sorted);
}

export async function getAffiliateLevelConfigs() {
  const queryDb = await getDrizzleDb();
  const configs = await queryRows<{
    level: number;
    label: string;
    commission_rate: string;
    threshold: string;
  }[]>(
    queryDb,
    `SELECT level, label, commission_rate::text AS commission_rate,
            threshold::text AS threshold
     FROM affiliate_level_configs
     ORDER BY level ASC`,
  );
  return configs.map((c) => ({
    level: c.level,
    label: c.label,
    commission_rate: toNumber(c.commission_rate),
    threshold: toNumber(c.threshold),
  }));
}
