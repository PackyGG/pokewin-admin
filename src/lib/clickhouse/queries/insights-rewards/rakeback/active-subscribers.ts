import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { RakebackActiveSubscribers } from "@/lib/queries/insights-rewards/rakeback/active-subscribers";

import { CH_DB, chDateTime, customerScopeCte } from "../../_shared";

/**
 * ClickHouse twin of `getRakebackActiveSubscribers`
 * (`src/lib/queries/insights-rewards/rakeback/active-subscribers.ts`).
 *
 * PARITY: distinct claimants in window, the weekly-active series
 * (`DATE_TRUNC('week', claimed_at)` → `toMonday`, distinct claimants per ISO
 * week), and the cohort-retention matrix (users bucketed by their first-claim
 * week, then % still active in weeks 0..3). The retention grouping + 6-cohort
 * cap is computed in TS with the BYTE-IDENTICAL logic the PG twin uses, off the
 * SAME cohort rows. `week_offset = floor(microsΔ / (7d in micros))` matches the
 * PG `FLOOR(EXTRACT(EPOCH …)/(86400*7))`.
 *
 * SCOPE (mirrors PG EXACTLY): `role NOT IN ('admin','support','creator')` +
 * blacklist — `customerScopeCte`.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0`, `uniqExact` for distinct
 * counts, `toNumber` in TS. The window cutoff is derived from a single
 * caller-supplied `now`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MICROS = "604800e6";

type HeadlineRow = { distinct_users: string };
type WeeklyRow = { week_start: string; active_users: string };
type CohortRow = {
  cohort_week: string;
  week_offset: number | string;
  active_count: string;
  cohort_size: string;
};

export async function getRakebackActiveSubscribersFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RakebackActiveSubscribers> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const scope = customerScopeCte({ hasBlacklist });

  const params: Record<string, unknown> = { blacklist };
  let dateClause = "";
  let cohortFirstFilter = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    dateClause = "AND rc.claimed_at >= {cutoff:DateTime64(6)}";
    cohortFirstFilter = "AND first_claim_at >= {cutoff:DateTime64(6)}";
  }

  const [headlineRows, weeklyRows, cohortRows] = await Promise.all([
    clickhouseRead.query<HeadlineRow>({
      queryName: "insights.rewards.rakeback.active.headline",
      sql: `
        WITH ${scope}
        SELECT toString(uniqExact(rc.user_id)) AS distinct_users
        FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
        WHERE rc._peerdb_is_deleted = 0
          AND rc.claimed_at IS NOT NULL
          AND rc.user_id IN (SELECT id FROM real_users)
          ${dateClause}`,
      params,
    }),
    clickhouseRead.query<WeeklyRow>({
      queryName: "insights.rewards.rakeback.active.weekly",
      sql: `
        WITH ${scope}
        SELECT
          toString(toMonday(rc.claimed_at)) AS week_start,
          toString(uniqExact(rc.user_id))   AS active_users
        FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
        WHERE rc._peerdb_is_deleted = 0
          AND rc.claimed_at IS NOT NULL
          AND rc.user_id IN (SELECT id FROM real_users)
          ${dateClause}
        GROUP BY toMonday(rc.claimed_at)
        ORDER BY week_start ASC`,
      params,
    }),
    clickhouseRead.query<CohortRow>({
      queryName: "insights.rewards.rakeback.active.cohort",
      sql: `
        WITH
          ${scope},
          first_claim AS (
            SELECT
              rc.user_id AS user_id,
              min(assumeNotNull(rc.claimed_at)) AS first_claim_at
            FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
            WHERE rc._peerdb_is_deleted = 0
              AND rc.claimed_at IS NOT NULL
              AND rc.user_id IN (SELECT id FROM real_users)
            GROUP BY rc.user_id
          ),
          cohort AS (
            SELECT
              user_id,
              toMonday(first_claim_at) AS cohort_week,
              first_claim_at
            FROM first_claim
            WHERE 1 = 1 ${cohortFirstFilter}
          ),
          cohort_size AS (
            SELECT cohort_week, count() AS cohort_size
            FROM cohort
            GROUP BY cohort_week
          ),
          claims AS (
            SELECT rc.user_id AS user_id, assumeNotNull(rc.claimed_at) AS ca
            FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
            WHERE rc._peerdb_is_deleted = 0
              AND rc.claimed_at IS NOT NULL
          ),
          activity AS (
            SELECT
              c.cohort_week AS cohort_week,
              c.user_id AS user_id,
              toInt32(floor(
                (toUnixTimestamp64Micro(cl.ca) - toUnixTimestamp64Micro(c.first_claim_at)) / ${WEEK_MICROS}
              )) AS week_offset
            FROM cohort AS c
            INNER JOIN claims AS cl ON cl.user_id = c.user_id
          )
        SELECT
          toString(a.cohort_week)        AS cohort_week,
          a.week_offset                  AS week_offset,
          toString(uniqExact(a.user_id)) AS active_count,
          toString(cs.cohort_size)       AS cohort_size
        FROM activity AS a
        INNER JOIN cohort_size AS cs ON cs.cohort_week = a.cohort_week
        WHERE a.week_offset BETWEEN 0 AND 3
        GROUP BY a.cohort_week, a.week_offset, cs.cohort_size
        ORDER BY a.cohort_week DESC, a.week_offset ASC`,
      params,
    }),
  ]);

  const distinctClaimants = Number(headlineRows[0]?.distinct_users ?? 0);
  const weeklyActive = weeklyRows.map((r) => ({
    weekStart: new Date(r.week_start).toISOString().split("T")[0],
    activeUsers: Number(r.active_users),
  }));

  // Identical post-processing to the PG twin's cohort grouping.
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
