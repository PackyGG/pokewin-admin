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
} from "./_shared";

/**
 * ClickHouse twin of `getSignupTimeToClaim`
 * (`src/lib/queries/insights-rewards/signup/time-to-claim.ts`).
 *
 * For every cohort user that claimed, the gap (hours) between signup and their
 * FIRST `balance_reward_claim`. Mirrors the count-exact terms a drift gate can
 * validate:
 *   • claimants     — cohort users with a claim (histogram denominator)
 *   • cohortSignups — cohort size (→ neverClaimed = cohortSignups − claimants)
 *   • within1h/1d/7d/30d — claimants whose gap ≤ 1 / 24 / 168 / 720 hours
 * The interpolated percentiles (median, p25/p75/p95) + the 10-bucket histogram
 * are NOT mirrored (interpolated quantiles are out of scope for a drift gate).
 * The gap reuses microsecond precision (`toUnixTimestamp64Micro`) so it matches
 * PG's `EXTRACT(EPOCH FROM (first_claim_at − signed_up_at)) / 3600` exactly.
 * Scope mirrors PG: `role NOT IN ('admin','support')` + blacklist.
 */

export type SignupTimeToClaimCh = {
  claimants: number;
  cohortSignups: number;
  within1h: number;
  within1d: number;
  within7d: number;
  within30d: number;
};

export async function getSignupTimeToClaimFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<SignupTimeToClaimCh> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };
  let windowClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * MS_PER_DAY));
    windowClause = "AND created_at >= {cutoff:DateTime64(6)}";
  }

  const cohort = `cohort AS (
      SELECT id AS user_id, created_at AS signed_up_at
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND ${SIGNUP_ROLE_SCOPE}
        ${blacklistClause(hasBlacklist, "id")}
        ${windowClause}
    )`;

  const [cohortRows, gapRows] = await Promise.all([
    clickhouseRead.query<{ signups: string }>({
      queryName: "insights.signup.time_to_claim.cohort",
      sql: `WITH ${cohort} SELECT toString(count()) AS signups FROM cohort`,
      params,
    }),
    clickhouseRead.query<{
      claimants: string;
      w1h: string;
      w1d: string;
      w7d: string;
      w30d: string;
    }>({
      queryName: "insights.signup.time_to_claim.gap",
      sql: `
        WITH
          ${cohort},
          fc AS (
            SELECT lt.user_id, min(lt.created_at) AS first_claim_at
            FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
            WHERE lt._peerdb_is_deleted = 0
              AND lt.status = 'completed'
              AND lt.type = 'balance_reward_claim'
              AND lt.user_id IN (SELECT user_id FROM cohort)
            GROUP BY lt.user_id
          ),
          gap AS (
            SELECT
              (toUnixTimestamp64Micro(fc.first_claim_at) - toUnixTimestamp64Micro(c.signed_up_at))
                / 1000000.0 / 3600.0 AS hours
            FROM fc
            INNER JOIN cohort c ON c.user_id = fc.user_id
          )
        SELECT
          toString(count())                                AS claimants,
          toString(countIf(hours >= 0 AND hours <= 1))     AS w1h,
          toString(countIf(hours >= 0 AND hours <= 24))    AS w1d,
          toString(countIf(hours >= 0 AND hours <= 168))   AS w7d,
          toString(countIf(hours >= 0 AND hours <= 720))   AS w30d
        FROM gap`,
      params,
    }),
  ]);

  return {
    claimants: Number(gapRows[0]?.claimants ?? "0"),
    cohortSignups: Number(cohortRows[0]?.signups ?? "0"),
    within1h: Number(gapRows[0]?.w1h ?? "0"),
    within1d: Number(gapRows[0]?.w1d ?? "0"),
    within7d: Number(gapRows[0]?.w7d ?? "0"),
    within30d: Number(gapRows[0]?.w30d ?? "0"),
  };
}
