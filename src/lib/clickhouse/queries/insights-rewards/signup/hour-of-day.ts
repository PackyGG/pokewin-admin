import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

import {
  CH_DB,
  MS_PER_DAY,
  SIGNUP_ROLE_SCOPE,
  blacklistClause,
  chDateTime,
  toNumber,
} from "./_shared";

/**
 * ClickHouse twin of `getSignupHourOfDay`
 * (`src/lib/queries/insights-rewards/signup/hour-of-day.ts`).
 *
 * The PG twin buckets cohort `balance_reward_claim` events into a 24×7 hour /
 * day-of-week heatmap (+ marginals). This twin mirrors the GRAND TOTALS those
 * cells sum to — the underlying set a drift gate validates (cf. the
 * deposit-bonus time-of-day twin):
 *   • totalCount  = COUNT(*)         of cohort claim rows
 *   • totalVolume = SUM(ABS(amount)) of cohort claim rows
 *
 * The per-cell DOW/HOUR split is NOT mirrored (CH `toDayOfWeek` is 1=Mon..7=Sun
 * vs PG `EXTRACT(DOW)` 0=Sun..6=Sat — a labelling difference irrelevant to the
 * totals). Scope mirrors PG: `role NOT IN ('admin','support')` + blacklist.
 */

export type SignupHourOfDayCh = {
  totalCount: number;
  totalVolume: number;
};

export async function getSignupHourOfDayFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<SignupHourOfDayCh> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };
  let windowClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * MS_PER_DAY));
    windowClause = "AND created_at >= {cutoff:DateTime64(6)}";
  }

  const rows = await clickhouseRead.query<{ cnt: string; volume: string }>({
    queryName: "insights.signup.hour_of_day.totals",
    sql: `
      WITH cohort AS (
        SELECT id AS user_id
        FROM ${CH_DB}.public_user FINAL
        WHERE _peerdb_is_deleted = 0
          AND ${SIGNUP_ROLE_SCOPE}
          ${blacklistClause(hasBlacklist, "id")}
          ${windowClause}
      )
      SELECT
        toString(count())             AS cnt,
        toString(sum(abs(lt.amount))) AS volume
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'balance_reward_claim'
        AND lt.user_id IN (SELECT user_id FROM cohort)`,
    params,
  });

  return {
    totalCount: Number(rows[0]?.cnt ?? "0"),
    totalVolume: toNumber(rows[0]?.volume ?? "0"),
  };
}
