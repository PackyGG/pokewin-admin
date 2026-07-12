import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";

import {
  CH_DB,
  SIGNUP_ROLE_SCOPE,
  WAGER_TYPES_CH,
  blacklistClause,
  signupCohortMatrixCutoff,
} from "./_shared";

/**
 * ClickHouse twin of `getSignupCohortMatrix`
 * (`src/lib/queries/insights-rewards/signup/cohort-matrix.ts`).
 *
 * The PG twin emits one ISO-week cohort row (signups / claimers / 30d-retention
 * splits). This twin mirrors the WINDOW AGGREGATE those weekly rows sum to —
 * exact counts:
 *   • signups               — cohort size
 *   • claimers              — cohort users with a `balance_reward_claim`
 *   • retained30d           — cohort users with a `deposit`/wager ≤ signup + 30d
 *   • claimerRetained30d    — retained30d ∩ claimers
 *   • nonClaimerRetained30d — retained30d ∩ non-claimers
 *
 * Window: rounded UP to whole weeks (`weeksBack*7` days, weeksBack=ceil(days/7)
 * or 52 lifetime) — matching the PG `DATE_TRUNC('week', …)` range. The weekly
 * bucketing itself is not mirrored (irrelevant to the sums). Scope mirrors PG:
 * `role NOT IN ('admin','support')` + blacklist.
 *
 * Runs with `SETTINGS join_use_nulls = 1` so an unmatched activity LEFT JOIN row
 * yields a NULL `created_at` (not the DateTime default `1970-01-01`, which the
 * `<=` retention test would otherwise count as retained) — a user with no
 * deposit/wager activity correctly scores 0.
 */

type SignupCohortMatrixCh = {
  signups: number;
  claimers: number;
  retained30d: number;
  claimerRetained30d: number;
  nonClaimerRetained30d: number;
};

export async function getSignupCohortMatrixFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<SignupCohortMatrixCh> {
  const hasBlacklist = blacklist.length > 0;
  const cutoff = signupCohortMatrixCutoff(period, now);
  const params: Record<string, unknown> = { blacklist, cutoff };

  const rows = await clickhouseRead.query<{
    signups: string;
    claimers: string;
    retained30d: string;
    claimer_retained: string;
    nonclaimer_retained: string;
  }>({
    queryName: "insights.signup.cohort_matrix",
    sql: `
      WITH
        cohort AS (
          SELECT id AS user_id, created_at AS signed_up_at
          FROM ${CH_DB}.public_user FINAL
          WHERE _peerdb_is_deleted = 0
            AND ${SIGNUP_ROLE_SCOPE}
            ${blacklistClause(hasBlacklist, "id")}
            AND created_at >= {cutoff:DateTime64(6)}
        ),
        claim_users AS (
          SELECT DISTINCT lt.user_id
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'balance_reward_claim'
            AND lt.user_id IN (SELECT user_id FROM cohort)
        ),
        activity AS (
          SELECT user_id, created_at
          FROM ${CH_DB}.public_ledger_transactions FINAL
          WHERE _peerdb_is_deleted = 0
            AND status = 'completed'
            AND (type = 'deposit' OR type IN ${WAGER_TYPES_CH})
            AND user_id IN (SELECT user_id FROM cohort)
        ),
        per_user AS (
          SELECT
            c.user_id AS user_id,
            max(if(a.created_at IS NOT NULL AND a.created_at <= c.signed_up_at + INTERVAL 30 DAY, 1, 0)) AS r30
          FROM cohort c
          LEFT JOIN activity a ON a.user_id = c.user_id
          GROUP BY c.user_id, c.signed_up_at
        )
      SELECT
        toString(count())                       AS signups,
        toString(countIf(had_claim))            AS claimers,
        toString(sum(r30))                      AS retained30d,
        toString(sumIf(r30, had_claim))         AS claimer_retained,
        toString(sumIf(r30, NOT had_claim))     AS nonclaimer_retained
      FROM (
        SELECT
          r30,
          user_id IN (SELECT user_id FROM claim_users) AS had_claim
        FROM per_user
      )
      SETTINGS join_use_nulls = 1`,
    params,
  });

  const r = rows[0];
  return {
    signups: Number(r?.signups ?? "0"),
    claimers: Number(r?.claimers ?? "0"),
    retained30d: Number(r?.retained30d ?? "0"),
    claimerRetained30d: Number(r?.claimer_retained ?? "0"),
    nonClaimerRetained30d: Number(r?.nonclaimer_retained ?? "0"),
  };
}
