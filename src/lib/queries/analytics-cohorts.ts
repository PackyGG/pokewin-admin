import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

/**
 * Cohort retention analysis.
 *
 * Users are grouped by signup bucket (week or month). For each bucket we
 * compute the per-period retention: the % of users in that cohort that
 * still placed a wager (pack_opening / battle_bet / battle_sponsorship)
 * in weeks/months N after signup. Revenue retention is the GGR generated
 * by the cohort in that same period.
 *
 * Staff (admin/creator) are excluded — they skew every cohort.
 *
 * Buckets are truncated to the start of the week (Monday) or month. We cap
 * the cohort count so a small-to-medium-sized DB doesn't explode into
 * thousands of rows; cohorts older than the cap fall off the top.
 */

export type CohortGranularity = "week" | "month";

export type CohortRow = {
  cohort: string; // ISO date of bucket start
  label: string; // pretty label for axis ("Feb 5" / "Jan 2024")
  size: number; // count of users in cohort
  // 10 columns: period 0 through period 9+
  retained: number[];
  revenue: number[];
};

export type CohortData = {
  granularity: CohortGranularity;
  maxPeriods: number;
  rows: CohortRow[];
};

const WAGER_TYPES_SQL = `('pack_opening','battle_bet','battle_sponsorship')`;
const PAYOUT_TYPES_SQL = `('battle_refund','card_sale','reward_card_sale')`;

const MAX_COHORTS = 16;
const MAX_PERIODS = 10;

export async function getCohortRetention(
  granularity: CohortGranularity,
): Promise<CohortData> {
  const db = await getDb();
  const dateTrunc = granularity === "week" ? "week" : "month";
  const periodInterval = granularity === "week" ? "7 days" : "1 month";
  const cohortHorizon = granularity === "week" ? "140 days" : "36 months";
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn =
    excluded.length > 0
      ? `AND u.id NOT IN (${excluded.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`
      : "";

  // Pull cohorts + activity in a single pass. `period_index` is integer
  // distance between activity bucket and signup bucket; clamp to the last
  // bucket so "9+" collapses long-tail activity.
  const rows = await db.$queryRawUnsafe<
    {
      cohort: Date;
      size: string;
      period_index: number | null;
      retained: string | null;
      revenue: string | null;
    }[]
  >(`
    WITH cohorts AS (
      SELECT
        date_trunc('${dateTrunc}', u.created_at)::date AS cohort,
        u.id AS user_id,
        u.created_at
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
        AND u.created_at >= NOW() - INTERVAL '${cohortHorizon}'
    ),
    cohort_sizes AS (
      SELECT cohort, COUNT(*)::text AS size
      FROM cohorts
      GROUP BY cohort
    ),
    activity AS (
      SELECT
        c.cohort,
        LEAST(
          ${MAX_PERIODS - 1},
          FLOOR(EXTRACT(EPOCH FROM (date_trunc('${dateTrunc}', lt.created_at) - c.cohort))
            / EXTRACT(EPOCH FROM INTERVAL '${periodInterval}'))::int
        ) AS period_index,
        c.user_id,
        lt.type,
        lt.amount
      FROM cohorts c
      JOIN ledger_transactions lt ON lt.user_id = c.user_id
      WHERE lt.status = 'completed'
        AND lt.type IN ${WAGER_TYPES_SQL}
        AND lt.created_at >= c.created_at
    ),
    payout_activity AS (
      SELECT
        c.cohort,
        LEAST(
          ${MAX_PERIODS - 1},
          FLOOR(EXTRACT(EPOCH FROM (date_trunc('${dateTrunc}', lt.created_at) - c.cohort))
            / EXTRACT(EPOCH FROM INTERVAL '${periodInterval}'))::int
        ) AS period_index,
        lt.amount
      FROM cohorts c
      JOIN ledger_transactions lt ON lt.user_id = c.user_id
      WHERE lt.status = 'completed'
        AND lt.type IN ${PAYOUT_TYPES_SQL}
        AND lt.created_at >= c.created_at
    ),
    retained AS (
      SELECT cohort, period_index, COUNT(DISTINCT user_id)::text AS retained_count,
        COALESCE(SUM(ABS(amount::numeric)), 0)::text AS wager
      FROM activity
      WHERE period_index >= 0
      GROUP BY cohort, period_index
    ),
    payouts AS (
      SELECT cohort, period_index, COALESCE(SUM(ABS(amount::numeric)), 0)::text AS payout
      FROM payout_activity
      WHERE period_index >= 0
      GROUP BY cohort, period_index
    )
    SELECT
      cs.cohort,
      cs.size,
      r.period_index,
      r.retained_count AS retained,
      (COALESCE(r.wager::numeric, 0) - COALESCE(p.payout::numeric, 0))::text AS revenue
    FROM cohort_sizes cs
    LEFT JOIN retained r ON r.cohort = cs.cohort
    LEFT JOIN payouts p ON p.cohort = cs.cohort AND p.period_index = r.period_index
    ORDER BY cs.cohort DESC, r.period_index ASC
  `);

  // Group rows by cohort.
  const byCohort = new Map<
    string,
    { date: Date; size: number; retained: number[]; revenue: number[] }
  >();

  for (const row of rows) {
    const key = row.cohort.toISOString().slice(0, 10);
    let entry = byCohort.get(key);
    if (!entry) {
      entry = {
        date: row.cohort,
        size: Number(row.size),
        retained: Array(MAX_PERIODS).fill(0),
        revenue: Array(MAX_PERIODS).fill(0),
      };
      byCohort.set(key, entry);
    }
    if (row.period_index != null) {
      const idx = Math.max(0, Math.min(MAX_PERIODS - 1, row.period_index));
      entry.retained[idx] += Number(row.retained ?? 0);
      entry.revenue[idx] += Number(row.revenue ?? 0);
    }
  }

  const sorted = Array.from(byCohort.values()).sort(
    (a, b) => b.date.getTime() - a.date.getTime(),
  );
  const capped = sorted.slice(0, MAX_COHORTS).reverse();

  const labelFormatter =
    granularity === "week"
      ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" })
      : new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" });

  return {
    granularity,
    maxPeriods: MAX_PERIODS,
    rows: capped.map((c) => ({
      cohort: c.date.toISOString().slice(0, 10),
      label: labelFormatter.format(c.date),
      size: c.size,
      retained: c.retained,
      revenue: c.revenue,
    })),
  };
}
