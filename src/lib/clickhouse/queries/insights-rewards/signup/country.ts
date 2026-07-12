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
 * ClickHouse twin of `getSignupCountryBreakdown`
 * (`src/lib/queries/insights-rewards/signup/country.ts`).
 *
 * The PG twin partitions the in-window cohort by `country_code` (top-15 + an
 * "Other" tail bucket) and by `continent_code`. Both partitions are unbounded
 * (the country list has no LIMIT; the tail collapses into "Other" rather than
 * dropping), so each sums back to the cohort totals — what this twin mirrors:
 *   • signups   = COUNT(*) cohort  (== Σ country.signups == Σ continent.signups)
 *   • claimants = cohort users with a `balance_reward_claim` (== Σ *.claimants)
 *   • totalCost = SUM(ABS(amount)) of those claims (== Σ country.claimVolume)
 *
 * The per-country / per-continent split + the top-15 collapse are NOT mirrored
 * (bucket-level parity is out of scope for the drift gate). The retention-7d
 * share is also omitted (PG exposes only the derived share, not a raw count).
 * Scope mirrors PG: `role NOT IN ('admin','support')` + blacklist.
 */

type SignupCountryCh = {
  signups: number;
  claimants: number;
  totalCost: number;
};

export async function getSignupCountryFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<SignupCountryCh> {
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

  const [signupRows, claimRows] = await Promise.all([
    clickhouseRead.query<{ signups: string }>({
      queryName: "insights.signup.country.signups",
      sql: `WITH ${cohort} SELECT toString(count()) AS signups FROM cohort`,
      params,
    }),
    clickhouseRead.query<{ claimants: string; total_cost: string }>({
      queryName: "insights.signup.country.claims",
      sql: `
        WITH ${cohort}
        SELECT
          toString(uniqExact(lt.user_id)) AS claimants,
          toString(sum(abs(lt.amount)))   AS total_cost
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0
          AND lt.status = 'completed'
          AND lt.type = 'balance_reward_claim'
          AND lt.user_id IN (SELECT user_id FROM cohort)`,
      params,
    }),
  ]);

  return {
    signups: Number(signupRows[0]?.signups ?? "0"),
    claimants: Number(claimRows[0]?.claimants ?? "0"),
    totalCost: toNumber(claimRows[0]?.total_cost ?? "0"),
  };
}
