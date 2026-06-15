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
 * ClickHouse twin of `getSignupOverview`
 * (`src/lib/queries/insights-rewards/signup/overview.ts`).
 *
 * Mirrors the cent-exact / count-exact headline aggregates the PG Overview
 * computes over the in-window signup cohort (`role NOT IN ('admin','support')`
 * + blacklist; creators KEPT):
 *   • signups        = COUNT(*) of the cohort
 *   • claimants      = COUNT(DISTINCT user_id) of cohort users with a
 *                      `balance_reward_claim` row (status='completed', ANY time)
 *   • totalCost      = SUM(ABS(amount)) of those claim rows
 *   • firstDepositors= COUNT(DISTINCT user_id) of cohort users with a `deposit`
 *
 * The derived ratios (conversion %, avg per claim/signup), the interpolated
 * `medianHoursToClaim` (PERCENTILE_CONT), and the prior-window term are NOT
 * mirrored here — the PG twin exposes only the prior-window DELTAS (ratios, not
 * raw values), and an interpolated percentile is out of scope for a cent/count-
 * exact drift gate (see the deposit-bonus overview twin).
 */

export type SignupOverviewCh = {
  signups: number;
  claimants: number;
  totalCost: number;
  firstDepositors: number;
};

export async function getSignupOverviewFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<SignupOverviewCh> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };
  let windowClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * MS_PER_DAY));
    windowClause = "AND created_at >= {cutoff:DateTime64(6)}";
  }

  const cohort = `cohort AS (
      SELECT id AS user_id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND ${SIGNUP_ROLE_SCOPE}
        ${blacklistClause(hasBlacklist, "id")}
        ${windowClause}
    )`;

  const [signupRows, claimRows, depRows] = await Promise.all([
    clickhouseRead.query<{ signups: string }>({
      queryName: "insights.signup.overview.signups",
      sql: `WITH ${cohort} SELECT toString(count()) AS signups FROM cohort`,
      params,
    }),
    clickhouseRead.query<{ claimants: string; total_cost: string }>({
      queryName: "insights.signup.overview.claims",
      sql: `
        WITH ${cohort}
        SELECT
          toString(uniqExact(lt.user_id))  AS claimants,
          toString(sum(abs(lt.amount)))    AS total_cost
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0
          AND lt.status = 'completed'
          AND lt.type = 'balance_reward_claim'
          AND lt.user_id IN (SELECT user_id FROM cohort)`,
      params,
    }),
    clickhouseRead.query<{ depositors: string }>({
      queryName: "insights.signup.overview.first_depositors",
      sql: `
        WITH ${cohort}
        SELECT toString(uniqExact(lt.user_id)) AS depositors
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0
          AND lt.status = 'completed'
          AND lt.type = 'deposit'
          AND lt.user_id IN (SELECT user_id FROM cohort)`,
      params,
    }),
  ]);

  return {
    signups: Number(signupRows[0]?.signups ?? "0"),
    claimants: Number(claimRows[0]?.claimants ?? "0"),
    totalCost: toNumber(claimRows[0]?.total_cost ?? "0"),
    firstDepositors: Number(depRows[0]?.depositors ?? "0"),
  };
}
