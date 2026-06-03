import "server-only";

import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";

/**
 * Signup-cohort retention + revenue trajectory.
 *
 * Users are grouped by signup bucket (week / month). For each cohort
 * we compute, per "period N after signup":
 *   • retained   — distinct users in cohort that placed a wager in
 *                  period N
 *   • wager      — total customer wager in period N
 *   • ggr        — wager − payouts in period N (house gain)
 *   • deposits   — total deposit amount in period N
 *
 * The cohort horizon is capped at 16 buckets so the heatmap stays
 * readable (~16 weeks ≈ 4 months / 16 months ≈ 1.3 years). Periods
 * past index 9 collapse into the last column.
 *
 * Staff (admin / support) and the manual blacklist are excluded.
 */

export type CohortsGranularity = "week" | "month";

export function parseCohortsGranularity(value: string | undefined): CohortsGranularity {
  return value === "month" ? "month" : "week";
}

export type CohortBucket = {
  cohort: string; // ISO date for bucket start
  label: string; // formatted label
  size: number;
  retained: number[]; // length === MAX_PERIODS
  wager: number[];
  ggr: number[];
  deposits: number[];
};

export type CohortData = {
  granularity: CohortsGranularity;
  maxPeriods: number;
  buckets: CohortBucket[];
};

const WAGER_TYPES_SQL = `('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')`;
const PAYOUT_TYPES_SQL = `('battle_refund','upgrader_payout','card_sale','reward_card_sale')`;

const MAX_COHORTS = 16;
const MAX_PERIODS = 10;

export async function getInsightsCohorts(
  granularity: CohortsGranularity,
): Promise<CohortData> {
  const db = await getDb();
  const dateTrunc = granularity === "week" ? "week" : "month";
  const periodInterval = granularity === "week" ? "7 days" : "1 month";
  const horizon = granularity === "week" ? "140 days" : "36 months";
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);

  const rows = await db.$queryRawUnsafe<
    {
      cohort: Date;
      size: string;
      period_index: number | null;
      retained: string | null;
      wager: string | null;
      payouts: string | null;
      deposits: string | null;
    }[]
  >(`
    WITH cohorts AS (
      SELECT date_trunc('${dateTrunc}', u.created_at)::date AS cohort,
             u.id AS user_id,
             u.created_at
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
        AND u.created_at >= NOW() - INTERVAL '${horizon}'
    ),
    cohort_sizes AS (
      SELECT cohort, COUNT(*)::text AS size FROM cohorts GROUP BY cohort
    ),
    activity AS (
      SELECT
        c.cohort,
        c.user_id,
        LEAST(${MAX_PERIODS - 1},
          FLOOR(EXTRACT(EPOCH FROM (date_trunc('${dateTrunc}', lt.created_at) - c.cohort))
            / EXTRACT(EPOCH FROM INTERVAL '${periodInterval}'))::int
        ) AS period_index,
        lt.type,
        lt.amount
      FROM cohorts c
      JOIN ledger_transactions lt ON lt.user_id = c.user_id
      WHERE lt.status = 'completed'
        AND lt.created_at >= c.created_at
        AND lt.type::text IN ${WAGER_TYPES_SQL}
    ),
    payouts AS (
      SELECT c.cohort,
        LEAST(${MAX_PERIODS - 1},
          FLOOR(EXTRACT(EPOCH FROM (date_trunc('${dateTrunc}', lt.created_at) - c.cohort))
            / EXTRACT(EPOCH FROM INTERVAL '${periodInterval}'))::int
        ) AS period_index,
        lt.amount
      FROM cohorts c
      JOIN ledger_transactions lt ON lt.user_id = c.user_id
      WHERE lt.status = 'completed'
        AND lt.created_at >= c.created_at
        AND lt.type::text IN ${PAYOUT_TYPES_SQL}
    ),
    deposits AS (
      SELECT c.cohort,
        LEAST(${MAX_PERIODS - 1},
          FLOOR(EXTRACT(EPOCH FROM (date_trunc('${dateTrunc}', lt.created_at) - c.cohort))
            / EXTRACT(EPOCH FROM INTERVAL '${periodInterval}'))::int
        ) AS period_index,
        lt.amount
      FROM cohorts c
      JOIN ledger_transactions lt ON lt.user_id = c.user_id
      WHERE lt.status = 'completed'
        AND lt.created_at >= c.created_at
        AND lt.type::text = 'deposit'
    ),
    retained AS (
      SELECT cohort, period_index,
        COUNT(DISTINCT user_id)::text AS retained,
        COALESCE(SUM(ABS(amount::numeric)), 0)::text AS wager
      FROM activity
      WHERE period_index >= 0
      GROUP BY cohort, period_index
    ),
    payouts_agg AS (
      SELECT cohort, period_index, COALESCE(SUM(ABS(amount::numeric)), 0)::text AS payouts
      FROM payouts
      WHERE period_index >= 0
      GROUP BY cohort, period_index
    ),
    deposits_agg AS (
      SELECT cohort, period_index, COALESCE(SUM(amount::numeric), 0)::text AS deposits
      FROM deposits
      WHERE period_index >= 0
      GROUP BY cohort, period_index
    )
    SELECT
      cs.cohort,
      cs.size,
      r.period_index,
      r.retained,
      r.wager,
      pa.payouts,
      da.deposits
    FROM cohort_sizes cs
    LEFT JOIN retained r ON r.cohort = cs.cohort
    LEFT JOIN payouts_agg pa ON pa.cohort = cs.cohort AND pa.period_index = r.period_index
    LEFT JOIN deposits_agg da ON da.cohort = cs.cohort AND da.period_index = r.period_index
    ORDER BY cs.cohort DESC, r.period_index ASC
  `);

  const byCohort = new Map<
    string,
    {
      date: Date;
      size: number;
      retained: number[];
      wager: number[];
      ggr: number[];
      deposits: number[];
    }
  >();

  for (const row of rows) {
    const key = row.cohort.toISOString().slice(0, 10);
    let entry = byCohort.get(key);
    if (!entry) {
      entry = {
        date: row.cohort,
        size: Number(row.size),
        retained: Array(MAX_PERIODS).fill(0),
        wager: Array(MAX_PERIODS).fill(0),
        ggr: Array(MAX_PERIODS).fill(0),
        deposits: Array(MAX_PERIODS).fill(0),
      };
      byCohort.set(key, entry);
    }
    if (row.period_index != null) {
      const idx = Math.max(0, Math.min(MAX_PERIODS - 1, row.period_index));
      const wager = Number(row.wager ?? 0);
      const payouts = Number(row.payouts ?? 0);
      entry.retained[idx] += Number(row.retained ?? 0);
      entry.wager[idx] += wager;
      entry.ggr[idx] += wager - payouts;
      entry.deposits[idx] += Number(row.deposits ?? 0);
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
    buckets: capped.map((c) => ({
      cohort: c.date.toISOString().slice(0, 10),
      label: labelFormatter.format(c.date),
      size: c.size,
      retained: c.retained,
      wager: c.wager,
      ggr: c.ggr,
      deposits: c.deposits,
    })),
  };
}
