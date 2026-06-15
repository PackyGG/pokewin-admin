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
  WAGER_TYPES_CH,
  blacklistClause,
  chDateTime,
} from "./_shared";

/**
 * ClickHouse twin of `getSignupRetention`
 * (`src/lib/queries/insights-rewards/signup/retention.ts`).
 *
 * Mirrors the raw retention COUNTS (claimer vs non-claimer cut, retained at
 * 24h / 7d / 30d after signup) — the shares + lift % are derived in TS from
 * these and need not be re-diffed. "Retained" = ≥1 `deposit` OR wager-type
 * ledger row with `created_at <= signed_up_at + INTERVAL N` (status='completed').
 * Cohort scope mirrors PG: `role NOT IN ('admin','support')` + blacklist.
 *
 * Implementation: the EXISTS-per-window test becomes a LEFT JOIN of the cohort
 * to the pre-filtered (deposit OR wager) ledger, then `max(if(created_at IS NOT
 * NULL AND created_at <= signed_up_at + INTERVAL N, 1, 0))` per user. The query
 * runs with `SETTINGS join_use_nulls = 1` so an unmatched LEFT JOIN row yields a
 * NULL `created_at` (not the DateTime default `1970-01-01`, which the `<=` test
 * would otherwise count as retained) — a user with no activity correctly scores
 * 0. All fields are exact counts.
 */

export type SignupRetentionCh = {
  claimerTotal: number;
  nonClaimerTotal: number;
  claimer24h: number;
  claimer7d: number;
  claimer30d: number;
  nonClaimer24h: number;
  nonClaimer7d: number;
  nonClaimer30d: number;
};

export async function getSignupRetentionFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<SignupRetentionCh> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };
  let windowClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * MS_PER_DAY));
    windowClause = "AND created_at >= {cutoff:DateTime64(6)}";
  }

  const rows = await clickhouseRead.query<{
    claimer_total: string;
    nonclaimer_total: string;
    claimer_r24: string;
    claimer_r7: string;
    claimer_r30: string;
    nonclaimer_r24: string;
    nonclaimer_r7: string;
    nonclaimer_r30: string;
  }>({
    queryName: "insights.signup.retention",
    sql: `
      WITH
        cohort AS (
          SELECT id AS user_id, created_at AS signed_up_at
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
            max(if(a.created_at IS NOT NULL AND a.created_at <= c.signed_up_at + INTERVAL 1 DAY, 1, 0)) AS r24,
            max(if(a.created_at IS NOT NULL AND a.created_at <= c.signed_up_at + INTERVAL 7 DAY, 1, 0)) AS r7,
            max(if(a.created_at IS NOT NULL AND a.created_at <= c.signed_up_at + INTERVAL 30 DAY, 1, 0)) AS r30
          FROM cohort c
          LEFT JOIN activity a ON a.user_id = c.user_id
          GROUP BY c.user_id, c.signed_up_at
        )
      SELECT
        toString(countIf(had_claim))         AS claimer_total,
        toString(countIf(NOT had_claim))     AS nonclaimer_total,
        toString(sumIf(r24, had_claim))      AS claimer_r24,
        toString(sumIf(r7, had_claim))       AS claimer_r7,
        toString(sumIf(r30, had_claim))      AS claimer_r30,
        toString(sumIf(r24, NOT had_claim))  AS nonclaimer_r24,
        toString(sumIf(r7, NOT had_claim))   AS nonclaimer_r7,
        toString(sumIf(r30, NOT had_claim))  AS nonclaimer_r30
      FROM (
        SELECT
          pu.r24, pu.r7, pu.r30,
          pu.user_id IN (SELECT user_id FROM claim_users) AS had_claim
        FROM per_user pu
      )
      SETTINGS join_use_nulls = 1`,
    params,
  });

  const r = rows[0];
  return {
    claimerTotal: Number(r?.claimer_total ?? "0"),
    nonClaimerTotal: Number(r?.nonclaimer_total ?? "0"),
    claimer24h: Number(r?.claimer_r24 ?? "0"),
    claimer7d: Number(r?.claimer_r7 ?? "0"),
    claimer30d: Number(r?.claimer_r30 ?? "0"),
    nonClaimer24h: Number(r?.nonclaimer_r24 ?? "0"),
    nonClaimer7d: Number(r?.nonclaimer_r7 ?? "0"),
    nonClaimer30d: Number(r?.nonclaimer_r30 ?? "0"),
  };
}
