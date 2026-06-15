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
 * ClickHouse twin of `getSignupFunnel`
 * (`src/lib/queries/insights-rewards/signup/funnel.ts`).
 *
 * Mirrors the 5-stage signup → repeat-wager funnel counts EXACTLY (each stage a
 * DISTINCT-user count over the in-window cohort, `role NOT IN ('admin','support')`
 * + blacklist):
 *   • signups       = COUNT(*) cohort
 *   • claimed       = users with ≥1 `balance_reward_claim`
 *   • firstDeposit  = users with ≥1 `deposit`
 *   • firstWager    = users with ≥1 wager-type ledger row (WAGER_TYPES_CH)
 *   • repeatDeposit = users with ≥2 `deposit` rows
 * all `status='completed'`. Pure counts → all gated cent/count-exact.
 */

export type SignupFunnelCh = {
  signups: number;
  claimed: number;
  firstDeposit: number;
  firstWager: number;
  repeatDeposit: number;
};

export async function getSignupFunnelFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<SignupFunnelCh> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };
  let windowClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * MS_PER_DAY));
    windowClause = "AND created_at >= {cutoff:DateTime64(6)}";
  }

  const rows = await clickhouseRead.query<{
    signups: string;
    claimed: string;
    first_deposit: string;
    first_wager: string;
    repeat_deposit: string;
  }>({
    queryName: "insights.signup.funnel",
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
        deposit_counts AS (
          SELECT lt.user_id, count() AS dep
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'deposit'
            AND lt.user_id IN (SELECT user_id FROM cohort)
          GROUP BY lt.user_id
        )
      SELECT
        toString((SELECT count() FROM cohort)) AS signups,
        toString((
          SELECT uniqExact(lt.user_id)
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'balance_reward_claim'
            AND lt.user_id IN (SELECT user_id FROM cohort)
        )) AS claimed,
        toString((SELECT count() FROM deposit_counts)) AS first_deposit,
        toString((
          SELECT uniqExact(lt.user_id)
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type IN ${WAGER_TYPES_CH}
            AND lt.user_id IN (SELECT user_id FROM cohort)
        )) AS first_wager,
        toString((SELECT countIf(dep >= 2) FROM deposit_counts)) AS repeat_deposit`,
    params,
  });

  const r = rows[0];
  return {
    signups: Number(r?.signups ?? "0"),
    claimed: Number(r?.claimed ?? "0"),
    firstDeposit: Number(r?.first_deposit ?? "0"),
    firstWager: Number(r?.first_wager ?? "0"),
    repeatDeposit: Number(r?.repeat_deposit ?? "0"),
  };
}
