import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { CodeSwitchRow } from "@/lib/queries/insights-rewards/affiliate/code-switch";

import { CH_DB, chDateTime } from "../../_shared";

/**
 * ClickHouse twin of `getAffiliateCodeSwitch`
 * (`src/lib/queries/insights-rewards/affiliate/code-switch.ts`).
 *
 * PARITY: each referred user active in the window is attributed to their FIRST
 * affiliate (earliest usage row, lifetime), and we measure how many of each
 * first-affiliate's cohort used ≥2 distinct codes lifetime / ended on a code
 * different from their first. Cohorts ≥5, top 25 by switch-away share, exactly
 * like PG. PG's correlated `ORDER BY created_at ASC/DESC LIMIT 1` first/last picks
 * are reproduced with `argMin`/`argMax(code, created_at)`; the distinct-codes
 * count with `uniqExact` over each user's lifetime completed usage.
 *
 * SCOPE (mirrors PG EXACTLY): admin/support only `role NOT IN ('admin','support')`
 * (creators KEPT) + blacklist on the first-affiliate `user.id`. The per-user
 * lifetime aggregation is unscoped by role (PG only scopes the joined affiliate).
 *
 * NOTE: the first/last-code picks break ties on equal `created_at` arbitrarily on
 * both engines, and the top-25 selection is by a ratio (share). The compare hook
 * diffs the row-set count + the summed cohort / switcher counts, stable whenever
 * the ranked shares are distinct and timestamps don't collide.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0`; `/` is float division in CH
 * (matches PG numeric division for the share ordering).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const COHORT_MIN_USERS = 5;
const ROW_LIMIT = 25;

type Row = {
  first_affiliate_user_id: string;
  username: string | null;
  cohort_size: string;
  switchers_any: string;
  switchers_away: string;
};

export async function getAffiliateCodeSwitchFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<CodeSwitchRow[]> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };
  let acuDate = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    acuDate = "AND acu.created_at >= {cutoff:DateTime64(6)}";
  }

  const rows = await clickhouseRead.query<Row>({
    queryName: "insights.affiliate.code-switch",
    sql: `
      WITH
        active_referred AS (
          SELECT DISTINCT acu.referred_user_id AS referred_user_id
          FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
          WHERE acu._peerdb_is_deleted = 0
            AND acu.status = 'completed'
            ${acuDate}
        ),
        per_user AS (
          SELECT
            acu.referred_user_id                          AS referred_user_id,
            argMin(acu.affiliate_user_id, acu.created_at) AS first_affiliate_user_id,
            argMin(acu.code, acu.created_at)              AS first_code,
            argMax(acu.code, acu.created_at)              AS last_code,
            uniqExact(acu.code)                           AS distinct_codes
          FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
          WHERE acu._peerdb_is_deleted = 0
            AND acu.status = 'completed'
            AND acu.referred_user_id IN (SELECT referred_user_id FROM active_referred)
          GROUP BY acu.referred_user_id
        ),
        grouped AS (
          SELECT
            first_affiliate_user_id,
            count()                              AS cohort_size,
            countIf(distinct_codes >= 2)         AS switchers_any,
            countIf(first_code != last_code)     AS switchers_away
          FROM per_user
          GROUP BY first_affiliate_user_id
        )
      SELECT
        g.first_affiliate_user_id     AS first_affiliate_user_id,
        u.username                    AS username,
        toString(g.cohort_size)       AS cohort_size,
        toString(g.switchers_any)     AS switchers_any,
        toString(g.switchers_away)    AS switchers_away
      FROM grouped AS g
      INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = g.first_affiliate_user_id
      WHERE u._peerdb_is_deleted = 0
        AND u.role NOT IN ('admin','support')
        ${hasBlacklist ? "AND u.id NOT IN {blacklist:Array(String)}" : ""}
        AND g.cohort_size >= ${COHORT_MIN_USERS}
      ORDER BY (g.switchers_away / g.cohort_size) DESC, g.cohort_size DESC
      LIMIT ${ROW_LIMIT}`,
    params,
  });

  return rows.map((r) => {
    const cohortSize = Number(r.cohort_size);
    const switchersAny = Number(r.switchers_any);
    const switchersAway = Number(r.switchers_away);
    return {
      affiliateUserId: r.first_affiliate_user_id,
      username: r.username,
      cohortSize,
      switchersAny,
      switchersAway,
      switchAwayShare: cohortSize > 0 ? switchersAway / cohortSize : 0,
      multiCodeShare: cohortSize > 0 ? switchersAny / cohortSize : 0,
    };
  });
}
