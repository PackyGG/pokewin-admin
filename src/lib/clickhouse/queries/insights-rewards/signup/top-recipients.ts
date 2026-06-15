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
 * ClickHouse twin of `getSignupTopRecipients`
 * (`src/lib/queries/insights-rewards/signup/top-recipients.ts`).
 *
 * The PG twin returns the top-25 `balance_reward_claim` recipients by claim
 * volume (window applies to the CLAIM `created_at`, NOT the signup time;
 * deposit totals are lifetime). This twin mirrors the leaderboard aggregate:
 *   • rowCount         — number of recipients returned (≤25)
 *   • claimVolumeSum   — Σ claim volume across the top-25 (money)
 *   • claimCountSum    — Σ claim count across the top-25
 *   • depositTotalSum  — Σ lifetime deposit total across the top-25 (money)
 *
 * NOTE (top-N tie): the served PG `ORDER BY claim_volume DESC` has no explicit
 * tie-break, so a tie straddling the 25th slot can perturb the row set; the
 * aggregate is robust whenever the top-25 volumes are distinct (the parity
 * harness pins a deterministic tie-break on both sides to prove structural
 * parity). Scope mirrors PG: `role NOT IN ('admin','support')` + blacklist
 * (applied at the user join; the deposit-totals CTE is unfiltered, exactly as PG).
 */

export type SignupTopRecipientsCh = {
  rowCount: number;
  claimVolumeSum: number;
  claimCountSum: number;
  depositTotalSum: number;
};

export async function getSignupTopRecipientsFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<SignupTopRecipientsCh> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };
  let claimDateClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * MS_PER_DAY));
    claimDateClause = "AND lt.created_at >= {cutoff:DateTime64(6)}";
  }

  const rows = await clickhouseRead.query<{
    claim_count: string;
    claim_volume: string;
    deposit_total: string;
  }>({
    queryName: "insights.signup.top_recipients",
    sql: `
      WITH
        claims AS (
          SELECT
            lt.user_id,
            count()             AS claim_count,
            sum(abs(lt.amount)) AS claim_volume
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'balance_reward_claim'
            ${claimDateClause}
          GROUP BY lt.user_id
        ),
        deposit_totals AS (
          SELECT lt.user_id, sum(abs(lt.amount)) AS deposit_total
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'deposit'
          GROUP BY lt.user_id
        )
      SELECT
        toString(c.claim_count)                              AS claim_count,
        toString(c.claim_volume)                             AS claim_volume,
        toString(coalesce(dt.deposit_total, toDecimal128(0, 2))) AS deposit_total
      FROM claims AS c
      INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = c.user_id
      LEFT JOIN deposit_totals AS dt ON dt.user_id = c.user_id
      WHERE u._peerdb_is_deleted = 0
        AND u.${SIGNUP_ROLE_SCOPE}
        ${blacklistClause(hasBlacklist, "u.id")}
      ORDER BY c.claim_volume DESC, c.user_id ASC
      LIMIT 25`,
    params,
  });

  return {
    rowCount: rows.length,
    claimVolumeSum: rows.reduce((a, r) => a + toNumber(r.claim_volume), 0),
    claimCountSum: rows.reduce((a, r) => a + Number(r.claim_count), 0),
    depositTotalSum: rows.reduce((a, r) => a + toNumber(r.deposit_total), 0),
  };
}
