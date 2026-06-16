import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";

/**
 * Retention / churn curves.
 *
 * We look at signups from the last ~180 days and ask, for each "days
 * since signup" bucket up to 90: what fraction of those signups were
 * still active (placed a wager) within that bucket?
 *
 * Unlike the cohort tab, retention here is a single aggregated curve,
 * not per-cohort. It answers "our average user looks like this after N
 * days". Staff excluded.
 *
 * Headline numbers (d7 / d30 / d90) are also returned for the hero
 * strip.
 */

const WAGER_TYPES = `('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')`;
const COHORT_WINDOW_DAYS = 180;
const CURVE_LENGTH = 91; // day 0 through day 90 inclusive

export type RetentionData = {
  // Curve: each point is day N + fraction still-active
  curve: { day: number; retained: number; pct: number; cohort: number }[];
  // Churn % at milestones
  d1: number;
  d7: number;
  d30: number;
  d90: number;
  // Total cohort sizes at each milestone (users old enough to be measured)
  cohortD1: number;
  cohortD7: number;
  cohortD30: number;
  cohortD90: number;
};

async function computeRetentionCurve(excluded: string[]): Promise<RetentionData> {
  const db = await getDb();
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);
  // Pull per-day retention in one shot. For each (cohort, day-offset)
  // bucket, count distinct users that wagered in that bucket. The
  // "eligible cohort" for day N is everyone who signed up at least N
  // days ago.
  const rows = await db.$queryRawUnsafe<
    {
      day: number;
      retained: string;
      eligible: string;
    }[]
  >(`
    WITH eligible AS (
      SELECT id AS user_id, created_at
      FROM "user"
      WHERE role NOT IN ('admin', 'support') ${blacklistIdNotIn}
        AND created_at >= NOW() - INTERVAL '${COHORT_WINDOW_DAYS} days'
    ),
    days AS (
      SELECT generate_series(0, ${CURVE_LENGTH - 1}) AS day
    ),
    activity AS (
      SELECT DISTINCT
        e.user_id,
        FLOOR(EXTRACT(EPOCH FROM (lt.created_at - e.created_at)) / 86400)::int AS day
      FROM eligible e
      JOIN ledger_transactions lt ON lt.user_id = e.user_id
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${WAGER_TYPES}
        AND lt.created_at >= e.created_at
        AND lt.created_at <= e.created_at + INTERVAL '${CURVE_LENGTH} days'
    )
    SELECT
      d.day,
      COALESCE(COUNT(DISTINCT a.user_id), 0)::text AS retained,
      COUNT(DISTINCT e.user_id)::text AS eligible
    FROM days d
    LEFT JOIN eligible e ON e.created_at <= NOW() - make_interval(days => d.day)
    LEFT JOIN activity a ON a.user_id = e.user_id AND a.day = d.day
    GROUP BY d.day
    ORDER BY d.day
  `);

  const curve = rows.map((r) => {
    const retained = Number(r.retained ?? 0);
    const cohort = Number(r.eligible ?? 0);
    const pct = cohort > 0 ? retained / cohort : 0;
    return { day: Number(r.day), retained, pct, cohort };
  });

  function at(day: number): { retained: number; cohort: number; pct: number } {
    const point = curve.find((c) => c.day === day);
    return point ?? { retained: 0, cohort: 0, pct: 0 };
  }

  const d1 = at(1);
  const d7 = at(7);
  const d30 = at(30);
  const d90 = at(90);

  return {
    curve,
    d1: d1.pct,
    d7: d7.pct,
    d30: d30.pct,
    d90: d90.pct,
    cohortD1: d1.cohort,
    cohortD7: d7.cohort,
    cohortD30: d30.cohort,
    cohortD90: d90.cohort,
  };
}

/**
 * Cross-request cache for the retention curve. `/analytics` re-runs every
 * server component on each 5-minute `AutoRefresh` tick for every viewer;
 * without a shared cache this 180-day cohort scan (generate_series ×
 * distinct-user activity join) re-ran per tick per viewer. The curve is a
 * rolling 180-day measurement that barely moves second-to-second, so a
 * single 300s layer keyed on the sorted blacklist (an admin edit to the
 * excluded-users list → a different key → fresh aggregate on the next tick)
 * is sufficient. Logic is byte-for-byte identical to `computeRetentionCurve`;
 * perf/consistency only, no number change. Mirrors the `getAnalyticsData`
 * cache idiom in `analytics.ts`.
 */
const cachedRetentionCurve = unstable_cache(
  computeRetentionCurve,
  ["analytics-retention-v1"],
  { revalidate: 300, tags: ["analytics"] },
);

export async function getRetentionCurve(): Promise<RetentionData> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return cachedRetentionCurve(sorted);
}
