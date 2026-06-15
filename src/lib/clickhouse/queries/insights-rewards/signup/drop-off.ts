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
 * ClickHouse twin of `getSignupDropOff`
 * (`src/lib/queries/insights-rewards/signup/drop-off.ts`).
 *
 * Splits the in-window cohort into the SAME 6 mutually-prioritised buckets the
 * PG twin computes (claimers + 5 drop-off causes), all exact counts:
 *   • claimers          — ≥1 `balance_reward_claim`
 *   • bannedOrLocked    — no claim, `is_banned` OR `is_locked`
 *   • dormant           — no claim, not banned/locked, no completed ledger row
 *   • depositedNoClaim  — no claim, not banned/locked, has a `deposit`
 *   • wageredNoClaim    — no claim, not banned/locked, no deposit, has a wager
 *   • other             — no claim, not banned/locked, has a ledger row but no
 *                         deposit / wager
 * Bucket priority + predicates replicate the PG CASE expression VERBATIM. Scope
 * mirrors PG: `role NOT IN ('admin','support')` + blacklist.
 */

export type SignupDropOffCh = {
  cohortSize: number;
  claimers: number;
  dormant: number;
  depositedNoClaim: number;
  wageredNoClaim: number;
  bannedOrLocked: number;
  other: number;
};

export async function getSignupDropOffFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<SignupDropOffCh> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };
  let windowClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * MS_PER_DAY));
    windowClause = "AND created_at >= {cutoff:DateTime64(6)}";
  }

  const rows = await clickhouseRead.query<{
    cohort_size: string;
    claimers: string;
    banned_or_locked: string;
    dormant: string;
    deposited_no_claim: string;
    wagered_no_claim: string;
    other: string;
  }>({
    queryName: "insights.signup.drop_off",
    sql: `
      WITH
        cohort AS (
          SELECT id AS user_id, is_banned, is_locked
          FROM ${CH_DB}.public_user FINAL
          WHERE _peerdb_is_deleted = 0
            AND ${SIGNUP_ROLE_SCOPE}
            ${blacklistClause(hasBlacklist, "id")}
            ${windowClause}
        ),
        has_claim AS (
          SELECT DISTINCT lt.user_id FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed'
            AND lt.type = 'balance_reward_claim' AND lt.user_id IN (SELECT user_id FROM cohort)
        ),
        has_deposit AS (
          SELECT DISTINCT lt.user_id FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed'
            AND lt.type = 'deposit' AND lt.user_id IN (SELECT user_id FROM cohort)
        ),
        has_wager AS (
          SELECT DISTINCT lt.user_id FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed'
            AND lt.type IN ${WAGER_TYPES_CH} AND lt.user_id IN (SELECT user_id FROM cohort)
        ),
        has_any AS (
          SELECT DISTINCT lt.user_id FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed'
            AND lt.user_id IN (SELECT user_id FROM cohort)
        )
      SELECT
        toString(count())                                                              AS cohort_size,
        toString(countIf(hc))                                                          AS claimers,
        toString(countIf(NOT hc AND banned))                                           AS banned_or_locked,
        toString(countIf(NOT hc AND NOT banned AND NOT hal))                           AS dormant,
        toString(countIf(NOT hc AND NOT banned AND hd))                                AS deposited_no_claim,
        toString(countIf(NOT hc AND NOT banned AND NOT hd AND hw))                     AS wagered_no_claim,
        toString(countIf(NOT hc AND NOT banned AND hal AND NOT hd AND NOT hw))         AS other
      FROM (
        SELECT
          (user_id IN (SELECT user_id FROM has_claim))   AS hc,
          (user_id IN (SELECT user_id FROM has_deposit)) AS hd,
          (user_id IN (SELECT user_id FROM has_wager))   AS hw,
          (user_id IN (SELECT user_id FROM has_any))     AS hal,
          (is_banned OR is_locked)                       AS banned
        FROM cohort
      )`,
    params,
  });

  const r = rows[0];
  return {
    cohortSize: Number(r?.cohort_size ?? "0"),
    claimers: Number(r?.claimers ?? "0"),
    dormant: Number(r?.dormant ?? "0"),
    depositedNoClaim: Number(r?.deposited_no_claim ?? "0"),
    wageredNoClaim: Number(r?.wagered_no_claim ?? "0"),
    bannedOrLocked: Number(r?.banned_or_locked ?? "0"),
    other: Number(r?.other ?? "0"),
  };
}
