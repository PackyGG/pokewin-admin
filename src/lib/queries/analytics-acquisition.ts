import "server-only";

import { unstable_cache } from "next/cache";
import { queryMainRows } from "@/lib/drizzle-query";
import { REWARD_QUERY_TIMEOUT_MS, safeQuery } from "@/lib/errors/safe-query";
import { getMetricsScope } from "@/lib/metrics/scope";
import type { AcquisitionWindow } from "@/app/(admin)/analytics/types";

export type AcquisitionTrendPoint = {
  date: string;
  signups: number;
  ftds: number;
  existingDepositors: number;
};

export type AcquisitionTrendResult = {
  points: AcquisitionTrendPoint[];
  available: boolean;
};

type AcquisitionTrendRow = {
  date: string;
  signups: string;
  ftds: string;
  existing_depositors: string;
};

const PERIOD_DAYS: Record<AcquisitionWindow, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

/**
 * One daily acquisition read for the active window only.
 *
 * FTDs are accounts whose first-ever completed deposit lands in the bucket.
 * Existing depositors are distinct accounts depositing in the bucket whose
 * first-ever completed deposit predates it. The two depositor series are
 * therefore mutually exclusive for every day.
 */
const cachedAcquisitionTrend = unstable_cache(
  async (
    period: AcquisitionWindow,
    userScopeSql: string,
  ): Promise<AcquisitionTrendRow[]> => {
    const days = PERIOD_DAYS[period];

    return queryMainRows<AcquisitionTrendRow[]>(
      `
      WITH bounds AS (
        SELECT
          (DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
            - ($1::int - 1) * INTERVAL '1 day')::date AS start_day,
          DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')::date AS end_day
      ),
      customers AS (
        SELECT u.id, u.created_at, u.is_locked
        FROM "user" u
        WHERE u.id IN ${userScopeSql}
      ),
      first_deposits AS (
        SELECT DISTINCT ON (lt.user_id)
          lt.user_id,
          lt.created_at AS first_deposit_at
        FROM ledger_transactions lt
        JOIN customers c ON c.id = lt.user_id
        WHERE lt.type::text = 'deposit'
          AND lt.status = 'completed'
        ORDER BY lt.user_id, lt.created_at ASC, lt.id ASC
      ),
      period_depositors AS (
        SELECT
          DATE_TRUNC('day', lt.created_at AT TIME ZONE 'UTC')::date AS day,
          lt.user_id,
          DATE_TRUNC(
            'day',
            fd.first_deposit_at AT TIME ZONE 'UTC'
          )::date AS first_deposit_day
        FROM ledger_transactions lt
        JOIN customers c ON c.id = lt.user_id
        JOIN first_deposits fd ON fd.user_id = lt.user_id
        CROSS JOIN bounds b
        WHERE lt.type::text = 'deposit'
          AND lt.status = 'completed'
          AND lt.created_at >= b.start_day AT TIME ZONE 'UTC'
        GROUP BY 1, lt.user_id, fd.first_deposit_at
      ),
      daily_depositors AS (
        SELECT
          day,
          COUNT(*) FILTER (WHERE first_deposit_day = day)::text AS ftds,
          COUNT(*) FILTER (WHERE first_deposit_day < day)::text
            AS existing_depositors
        FROM period_depositors
        GROUP BY day
      ),
      daily_signups AS (
        SELECT
          DATE_TRUNC('day', c.created_at AT TIME ZONE 'UTC')::date AS day,
          COUNT(*)::text AS signups
        FROM customers c
        CROSS JOIN bounds b
        WHERE c.created_at >= b.start_day AT TIME ZONE 'UTC'
          AND c.is_locked = false
        GROUP BY 1
      ),
      days AS (
        SELECT GENERATE_SERIES(
          (SELECT start_day FROM bounds),
          (SELECT end_day FROM bounds),
          INTERVAL '1 day'
        )::date AS day
      )
      SELECT
        TO_CHAR(days.day, 'YYYY-MM-DD') AS date,
        COALESCE(ds.signups, '0') AS signups,
        COALESCE(dd.ftds, '0') AS ftds,
        COALESCE(dd.existing_depositors, '0') AS existing_depositors
      FROM days
      LEFT JOIN daily_signups ds ON ds.day = days.day
      LEFT JOIN daily_depositors dd ON dd.day = days.day
      ORDER BY days.day
      `,
      days,
    );
  },
  ["analytics-acquisition-trend-v1"],
  {
    revalidate: 300,
    tags: ["analytics", "insights-analytics", "dashboard-lifetime"],
  },
);

export async function getAcquisitionTrend(
  period: AcquisitionWindow,
): Promise<AcquisitionTrendResult> {
  const scope = await getMetricsScope();
  const result = await safeQuery(
    () => cachedAcquisitionTrend(period, scope.userScopeSql),
    [] as AcquisitionTrendRow[],
    "analytics.acquisition-trend",
    REWARD_QUERY_TIMEOUT_MS,
  );

  return {
    available: result.error === null,
    points: result.data.map((row) => ({
      date: row.date,
      signups: Number(row.signups),
      ftds: Number(row.ftds),
      existingDepositors: Number(row.existing_depositors),
    })),
  };
}
