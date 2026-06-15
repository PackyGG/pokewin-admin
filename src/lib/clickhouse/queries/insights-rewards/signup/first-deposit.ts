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
 * ClickHouse twin of `getSignupFirstDeposit`
 * (`src/lib/queries/insights-rewards/signup/first-deposit.ts`).
 *
 * Splits the in-window cohort's FIRST deposit (earliest `deposit` by created_at,
 * ABS amount) by whether the user ever claimed, mirroring the cent-exact /
 * count-exact terms:
 *   • claimerUsers / nonClaimerUsers     — count with a first deposit
 *   • claimerTotal / nonClaimerTotal     — SUM of first-deposit amounts (money)
 *   • bucketClaimer / bucketNonClaimer   — first-deposit amount-band counts,
 *       first-match edges ≤10 / ≤50 / ≤100 / ≤500 / >500 (matches PG)
 * The avg / median are derived in TS (median is an interpolated percentile, out
 * of scope for a drift gate). Scope mirrors PG: `role NOT IN ('admin','support')`
 * + blacklist.
 */

export type SignupFirstDepositCh = {
  claimerUsers: number;
  claimerTotal: number;
  nonClaimerUsers: number;
  nonClaimerTotal: number;
  /** 5 amount-band counts for the claimer cut (≤10/≤50/≤100/≤500/>500). */
  bucketClaimer: number[];
  bucketNonClaimer: number[];
};

export async function getSignupFirstDepositFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<SignupFirstDepositCh> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };
  let windowClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * MS_PER_DAY));
    windowClause = "AND created_at >= {cutoff:DateTime64(6)}";
  }

  const rows = await clickhouseRead.query<{
    claimer_users: string;
    claimer_total: string;
    nonclaimer_users: string;
    nonclaimer_total: string;
    c0: string;
    c1: string;
    c2: string;
    c3: string;
    c4: string;
    n0: string;
    n1: string;
    n2: string;
    n3: string;
    n4: string;
  }>({
    queryName: "insights.signup.first_deposit",
    sql: `
      WITH
        cohort AS (
          SELECT id AS user_id
          FROM ${CH_DB}.public_user FINAL
          WHERE _peerdb_is_deleted = 0
            AND ${SIGNUP_ROLE_SCOPE}
            ${blacklistClause(hasBlacklist, "id")}
            ${windowClause}
        ),
        claim_users AS (
          SELECT DISTINCT lt.user_id
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'balance_reward_claim'
            AND lt.user_id IN (SELECT user_id FROM cohort)
        ),
        fd AS (
          SELECT lt.user_id, argMin(abs(lt.amount), lt.created_at) AS amount
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'deposit'
            AND lt.user_id IN (SELECT user_id FROM cohort)
          GROUP BY lt.user_id
        )
      SELECT
        toString(countIf(had_claim))             AS claimer_users,
        toString(sumIf(amount, had_claim))       AS claimer_total,
        toString(countIf(NOT had_claim))         AS nonclaimer_users,
        toString(sumIf(amount, NOT had_claim))   AS nonclaimer_total,
        toString(countIf(had_claim AND bucket = 0))     AS c0,
        toString(countIf(had_claim AND bucket = 1))     AS c1,
        toString(countIf(had_claim AND bucket = 2))     AS c2,
        toString(countIf(had_claim AND bucket = 3))     AS c3,
        toString(countIf(had_claim AND bucket = 4))     AS c4,
        toString(countIf(NOT had_claim AND bucket = 0)) AS n0,
        toString(countIf(NOT had_claim AND bucket = 1)) AS n1,
        toString(countIf(NOT had_claim AND bucket = 2)) AS n2,
        toString(countIf(NOT had_claim AND bucket = 3)) AS n3,
        toString(countIf(NOT had_claim AND bucket = 4)) AS n4
      FROM (
        SELECT
          amount,
          user_id IN (SELECT user_id FROM claim_users) AS had_claim,
          multiIf(amount <= 10, 0, amount <= 50, 1, amount <= 100, 2, amount <= 500, 3, 4) AS bucket
        FROM fd
      )`,
    params,
  });

  const r = rows[0];
  return {
    claimerUsers: Number(r?.claimer_users ?? "0"),
    claimerTotal: toNumber(r?.claimer_total ?? "0"),
    nonClaimerUsers: Number(r?.nonclaimer_users ?? "0"),
    nonClaimerTotal: toNumber(r?.nonclaimer_total ?? "0"),
    bucketClaimer: [r?.c0, r?.c1, r?.c2, r?.c3, r?.c4].map((v) => Number(v ?? "0")),
    bucketNonClaimer: [r?.n0, r?.n1, r?.n2, r?.n3, r?.n4].map((v) => Number(v ?? "0")),
  };
}
