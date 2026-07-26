import { blacklistNotInSql, daysAgoFilter, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getDrizzleDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Active rakeback "subscribers" view — distinct claimants per week +
 * a simple cohort retention curve.
 *
 * Cohort retention: bucket users by their FIRST-ever rakeback claim date
 * (truncated to the start of the week). For each cohort, count the
 * users who remained active (claimed at least once) in week 0 / week 1
 * / week 2 / week 3 (relative to their first claim). Returned as a 4-row
 * matrix per cohort week, capped at 6 cohorts for chart readability.
 *
 * Plus distinct claimants in window + weekly-active rakebackers series.
 *
 * Source: `rakeback_claims`. Staff + blacklist excluded.
 */

export type RakebackActiveSubscribers = {
  /** Distinct claimants in window — headline number. */
  distinctClaimants: number;
  /** Weekly active (distinct claimants per ISO week) within the window. */
  weeklyActive: Array<{ weekStart: string; activeUsers: number }>;
  /**
   * Retention matrix — one row per cohort week (first-claim week), with
   * up to 4 cells (week 0 .. week 3 relative to first claim) showing
   * the cumulative pct of cohort still active that week. Capped at the
   * most recent 6 cohorts so the chart stays legible.
   */
  cohorts: Array<{
    cohortWeekStart: string;
    cohortSize: number;
    /** retention[i] = pct of cohort active in week i, 0–100. */
    retention: Array<{ weekOffset: number; activeCount: number; sharePct: number }>;
  }>;
};

async function computeActiveSubscribers(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RakebackActiveSubscribers> {
  const db = await getDrizzleDb();
  const days = daysForInsightsPeriod(period);
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);
  const dateFilter = daysAgoFilter("rc.claimed_at", days);

  // Headline + weekly active distinct claimants.
  const [headlineRows, weeklyRows] = await Promise.all([
    queryRows<{ distinct_users: string }[]>(db, sql`
      SELECT COUNT(DISTINCT rc.user_id)::text AS distinct_users
      FROM rakeback_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE rc.claimed_at IS NOT NULL
        AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
        ${dateFilter}
    `),
    queryRows<{ week_start: Date | string; active_users: string }[]>(db, sql`
      SELECT
        DATE_TRUNC('week', rc.claimed_at)::date AS week_start,
        COUNT(DISTINCT rc.user_id)::text AS active_users
      FROM rakeback_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE rc.claimed_at IS NOT NULL
        AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
        ${dateFilter}
      GROUP BY 1
      ORDER BY 1 ASC
    `),
  ]);
  const distinctClaimants = Number(headlineRows[0]?.distinct_users ?? 0);
  const weeklyActive = weeklyRows.map((r) => ({
    weekStart: new Date(r.week_start).toISOString().split("T")[0],
    activeUsers: Number(r.active_users),
  }));

  // Cohort retention — bucket users by their FIRST-EVER claim date
  // (truncated to ISO week start), then count how many of each cohort
  // were active in each subsequent week (0..3). Source is the entire
  // history of rakeback_claims for users whose first claim falls in
  // window; the period filter applies to the first-claim date not to
  // every individual claim, so we see retention beyond the window edge.
  const cohortFirstFilter = daysAgoFilter("first_claim_at", days);
  const cohortRows = await queryRows<
    {
      cohort_week: Date | string;
      week_offset: number;
      active_count: string;
      cohort_size: string;
    }[]
  >(db, sql`
    WITH first_claim AS (
      SELECT rc.user_id, MIN(rc.claimed_at) AS first_claim_at
      FROM rakeback_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE rc.claimed_at IS NOT NULL
        AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
      GROUP BY rc.user_id
    ),
    cohort AS (
      SELECT
        user_id,
        DATE_TRUNC('week', first_claim_at)::date AS cohort_week,
        first_claim_at
      FROM first_claim
      WHERE 1=1 ${cohortFirstFilter}
    ),
    cohort_size AS (
      SELECT cohort_week, COUNT(*)::text AS cohort_size
      FROM cohort
      GROUP BY cohort_week
    ),
    activity AS (
      SELECT
        c.cohort_week,
        c.user_id,
        FLOOR(EXTRACT(EPOCH FROM (rc.claimed_at - c.first_claim_at)) / (86400 * 7))::int AS week_offset
      FROM cohort c
      JOIN rakeback_claims rc ON rc.user_id = c.user_id AND rc.claimed_at IS NOT NULL
    )
    SELECT
      a.cohort_week,
      a.week_offset,
      COUNT(DISTINCT a.user_id)::text AS active_count,
      cs.cohort_size
    FROM activity a
    JOIN cohort_size cs ON cs.cohort_week = a.cohort_week
    WHERE a.week_offset BETWEEN 0 AND 3
    GROUP BY a.cohort_week, a.week_offset, cs.cohort_size
    ORDER BY a.cohort_week DESC, a.week_offset ASC
  `);

  // Group cohorts by week, then keep the 6 most recent for chart legibility.
  type CohortAcc = {
    cohortWeekStart: string;
    cohortSize: number;
    retention: Map<number, number>;
  };
  const byCohort = new Map<string, CohortAcc>();
  for (const row of cohortRows) {
    const wkStr = new Date(row.cohort_week).toISOString().split("T")[0];
    const existing =
      byCohort.get(wkStr) ??
      {
        cohortWeekStart: wkStr,
        cohortSize: Number(row.cohort_size),
        retention: new Map<number, number>(),
      };
    existing.retention.set(Number(row.week_offset), Number(row.active_count));
    byCohort.set(wkStr, existing);
  }

  const cohorts = [...byCohort.values()]
    .sort((a, b) => b.cohortWeekStart.localeCompare(a.cohortWeekStart))
    .slice(0, 6)
    .map((c) => ({
      cohortWeekStart: c.cohortWeekStart,
      cohortSize: c.cohortSize,
      retention: [0, 1, 2, 3].map((wk) => {
        const active = c.retention.get(wk) ?? 0;
        return {
          weekOffset: wk,
          activeCount: active,
          sharePct: c.cohortSize > 0 ? (active / c.cohortSize) * 100 : 0,
        };
      }),
    }));

  return {
    distinctClaimants,
    weeklyActive,
    cohorts,
  };
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeActiveSubscribers(period, blacklistIds),
  ["insights-rewards-rakeback-active-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards-rakeback"] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeActiveSubscribers(period, blacklistIds),
  ["insights-rewards-rakeback-active-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards-rakeback"] },
);

export async function getRakebackActiveSubscribers(
  period: InsightsRewardsPeriod,
): Promise<RakebackActiveSubscribers> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted);
}
