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
 * ClickHouse twin of `getSignupSourceBreakdown`
 * (`src/lib/queries/insights-rewards/signup/source.ts`).
 *
 * The PG twin partitions the in-window cohort by auth provider and by affiliate
 * code. The PROVIDER breakdown is unbounded (every cohort user maps to exactly
 * one provider, no LIMIT) so it sums back to the cohort totals — that is what
 * this twin mirrors (the cent-exact / count-exact underlying set):
 *   • signups   = COUNT(*) cohort  (== Σ provider.signups == totalSignups)
 *   • claimants = cohort users with a `balance_reward_claim` (== Σ provider.claimants)
 *   • totalCost = SUM(ABS(amount)) of those claims (== Σ provider.totalCost)
 *
 * The per-provider / per-affiliate split + the affiliate top-100→top-15+Other
 * collapse (a truncated, tie-sensitive top-N) are NOT mirrored — bucket-level
 * parity is out of scope for the drift gate (cf. the deposit-bonus time-of-day
 * grand-total twin). `public_account` is not touched because the provider
 * partition is irrelevant to the cohort-wide sums. Scope mirrors PG:
 * `role NOT IN ('admin','support')` + blacklist.
 */

export type SignupSourceCh = {
  signups: number;
  claimants: number;
  totalCost: number;
};

export async function getSignupSourceFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<SignupSourceCh> {
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
      queryName: "insights.signup.source.signups",
      sql: `WITH ${cohort} SELECT toString(count()) AS signups FROM cohort`,
      params,
    }),
    clickhouseRead.query<{ claimants: string; total_cost: string }>({
      queryName: "insights.signup.source.claims",
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
