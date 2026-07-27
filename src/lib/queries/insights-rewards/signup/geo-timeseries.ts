import { blacklistNotInSql, daysAgoFilter, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getReadDrizzleDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { SIGNUP_CACHE_TAG } from "./_shared";

/**
 * Geo time-series for /insights/rewards/signup.
 *
 * Top 5 countries by total signups in the window — for each, a daily
 * series of (signups, claimers). Lets admins compare cohort behaviour
 * across regions over time.
 *
 * The series spans the same window as the page's period selector. For
 * "all" (lifetime), the series caps at the last 90 days so the chart
 * stays readable; the country-tab page already covers lifetime totals.
 *
 * Days with zero activity ARE NOT zero-filled — the page does the
 * fill so the SQL response stays sparse for fewer wire bytes.
 */

export type GeoTimeSeriesCountry = {
  code: string;
  signups: number;
  claimers: number;
  daily: Array<{ date: string; signups: number; claimers: number }>;
};

async function computeGeoTimeSeries(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<GeoTimeSeriesCountry[]> {
  const db = await getReadDrizzleDb();
  const days = daysForInsightsPeriod(period);
  // Cap to 90 days on lifetime so we don't shovel years of points.
  const effectiveDays = days !== null ? days : 90;
  const dateFilter = daysAgoFilter("u.created_at", effectiveDays);
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);

  // Step 1: identify top 5 countries by signup count in window.
  type TopCountryRow = { code: string; signups: string };
  const topCountries = await queryRows<TopCountryRow[]>(db, sql`
    SELECT
      COALESCE(u.country_code, '??') AS code,
      COUNT(*)::text AS signups
    FROM "user" u
    WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
      ${dateFilter}
    GROUP BY COALESCE(u.country_code, '??')
    ORDER BY COUNT(*) DESC
    LIMIT 5
  `);

  if (topCountries.length === 0) return [];

  const topCodes = topCountries.map((r) => r.code);
  // Inline-quote since codes are ISO-2 alphanumeric (or our "??" / "Other"
  // sentinels) — same safety profile as the blacklist helper.
  const topCodesSql = sql.join(
    topCodes.map((code) => sql`${code}`),
    sql`, `,
  );

  // Step 2: daily series per top country.
  type SeriesRow = {
    code: string;
    date: Date;
    signups: string;
    claimers: string;
  };
  const seriesRows = await queryRows<SeriesRow[]>(db, sql`
    WITH cohort AS (
      SELECT
        u.id AS user_id,
        DATE(u.created_at) AS day,
        COALESCE(u.country_code, '??') AS code
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
        AND COALESCE(u.country_code, '??') IN (${topCodesSql})
    ),
    claim_users AS (
      SELECT DISTINCT c.user_id, c.day, c.code
      FROM cohort c
      JOIN ledger_transactions lt
        ON lt.user_id = c.user_id
       AND lt.status = 'completed'
       AND lt.type::text = 'balance_reward_claim'
    )
    SELECT
      c.code,
      c.day::date AS date,
      COUNT(*)::text AS signups,
      (SELECT COUNT(*) FROM claim_users cu WHERE cu.code = c.code AND cu.day = c.day)::text AS claimers
    FROM cohort c
    GROUP BY c.code, c.day
    ORDER BY c.code ASC, c.day ASC
  `);

  // Group by country code; preserve the order from topCountries.
  const byCode = new Map<string, GeoTimeSeriesCountry>();
  for (const tc of topCountries) {
    byCode.set(tc.code, {
      code: tc.code,
      signups: Number(tc.signups),
      claimers: 0,
      daily: [],
    });
  }
  for (const r of seriesRows) {
    const country = byCode.get(r.code);
    if (!country) continue;
    const claimers = Number(r.claimers);
    country.daily.push({
      date: new Date(r.date).toISOString().split("T")[0],
      signups: Number(r.signups),
      claimers,
    });
    country.claimers += claimers;
  }

  return [...byCode.values()];
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeGeoTimeSeries(period, blacklistIds),
  ["insights-rewards-signup-geo-timeseries-v1"],
  { revalidate: 60, tags: [SIGNUP_CACHE_TAG] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeGeoTimeSeries(period, blacklistIds),
  ["insights-rewards-signup-geo-timeseries-lifetime-v1"],
  { revalidate: 300, tags: [SIGNUP_CACHE_TAG] },
);

export async function getSignupGeoTimeSeries(
  period: InsightsRewardsPeriod,
): Promise<GeoTimeSeriesCountry[]> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const data = await (cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted));
  return data;
}
