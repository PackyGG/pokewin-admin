import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";

import {
  CH_DB,
  SIGNUP_ROLE_SCOPE,
  blacklistClause,
  signupCutoffCapped,
  toNumber,
} from "./_shared";

/**
 * ClickHouse twin of `getSignupDaily`
 * (`src/lib/queries/insights-rewards/signup/daily.ts`).
 *
 * The PG twin returns one row per UTC day (signups + cohort claims + cost),
 * merged in JS. This twin mirrors the WINDOW AGGREGATE those daily rows sum to
 * (the underlying set a drift gate validates):
 *   • totalSignups = COUNT(*) of the cohort (created_at within the capped window)
 *   • totalClaims  = COUNT(*) of cohort `balance_reward_claim` rows
 *   • totalCost    = SUM(ABS(amount)) of those claim rows
 *   • dayCount     = distinct UTC days that carry a signup OR a cohort claim
 *
 * Window: the cohort caps the lifetime (`all`) view at the last 365 days
 * exactly as the PG twin's `effectiveDays = days ?? 365`. Scope mirrors PG:
 * `role NOT IN ('admin','support')` + blacklist.
 */

const LIFETIME_CAP_DAYS = 365;

export type SignupDailyCh = {
  totalSignups: number;
  totalClaims: number;
  totalCost: number;
  dayCount: number;
};

export async function getSignupDailyFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<SignupDailyCh> {
  const hasBlacklist = blacklist.length > 0;
  const cutoff = signupCutoffCapped(period, now, LIFETIME_CAP_DAYS);
  const params: Record<string, unknown> = { blacklist, cutoff };

  const cohort = `cohort AS (
      SELECT id AS user_id, toDate(created_at) AS day
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND ${SIGNUP_ROLE_SCOPE}
        ${blacklistClause(hasBlacklist, "id")}
        AND created_at >= {cutoff:DateTime64(6)}
    )`;

  const [signupRows, claimRows, dayRows] = await Promise.all([
    clickhouseRead.query<{ signups: string }>({
      queryName: "insights.signup.daily.signups",
      sql: `WITH ${cohort} SELECT toString(count()) AS signups FROM cohort`,
      params,
    }),
    clickhouseRead.query<{ claims: string; total_cost: string }>({
      queryName: "insights.signup.daily.claims",
      sql: `
        WITH ${cohort}
        SELECT
          toString(count())             AS claims,
          toString(sum(abs(lt.amount))) AS total_cost
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0
          AND lt.status = 'completed'
          AND lt.type = 'balance_reward_claim'
          AND lt.user_id IN (SELECT user_id FROM cohort)`,
      params,
    }),
    clickhouseRead.query<{ day_count: string }>({
      queryName: "insights.signup.daily.day_count",
      sql: `
        WITH ${cohort}
        SELECT toString(uniqExact(day)) AS day_count
        FROM (
          SELECT day FROM cohort
          UNION ALL
          SELECT toDate(lt.created_at) AS day
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'balance_reward_claim'
            AND lt.user_id IN (SELECT user_id FROM cohort)
        )`,
      params,
    }),
  ]);

  return {
    totalSignups: Number(signupRows[0]?.signups ?? "0"),
    totalClaims: Number(claimRows[0]?.claims ?? "0"),
    totalCost: toNumber(claimRows[0]?.total_cost ?? "0"),
    dayCount: Number(dayRows[0]?.day_count ?? "0"),
  };
}
