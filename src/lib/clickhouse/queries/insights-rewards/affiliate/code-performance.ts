import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { CodePerformanceRow } from "@/lib/queries/insights-rewards/affiliate/code-performance";

import { CH_DB, chDateTime, toNumber } from "../../_shared";

/**
 * ClickHouse twin of `getAffiliateCodePerformance`
 * (`src/lib/queries/insights-rewards/affiliate/code-performance.ts`).
 *
 * PARITY: per-code funnel — `affiliate_clicks` (top of funnel) vs
 * `affiliate_code_usages` (signups / depositors / wagerers / wager / accrued
 * commission). Top 25 codes by downstream wager (tie-break signups), exactly
 * like PG. The funnel conversion %s are derived in TS, identical to PG.
 *
 * SCOPE (mirrors PG EXACTLY): admin/support only `role NOT IN ('admin','support')`
 * (creators KEPT) + blacklist on the affiliate `user.id`.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0` on every mirror table,
 * `uniqExact`/`uniqExactIf` for distinct funnel-stage counts, money Decimal
 * (`toString(sum(...))`), `join_use_nulls = 1` so an unmatched click LEFT JOIN
 * yields a proper zero. `affiliate_clicks.created_at` is Nullable, so a NULL
 * timestamp drops out of the dated window (NULL `>=` cutoff → false) exactly as
 * in PG, and is counted in the lifetime view.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ROW_LIMIT = 25;

type Row = {
  code: string;
  affiliate_user_id: string;
  affiliate_username: string | null;
  clicks: string;
  signups: string;
  depositors: string;
  wagerers: string;
  total_wager: string;
  commission_accrued: string;
};

export async function getAffiliateCodePerformanceFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<CodePerformanceRow[]> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };
  let acuDate = "";
  let clickDate = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    acuDate = "AND acu.created_at >= {cutoff:DateTime64(6)}";
    clickDate = "AND ac.created_at >= {cutoff:DateTime64(6)}";
  }

  const rows = await clickhouseRead.query<Row>({
    queryName: "insights.affiliate.code-performance",
    sql: `
      WITH
        usage_agg AS (
          SELECT
            acu.code                                                       AS code,
            acu.affiliate_user_id                                          AS affiliate_user_id,
            uniqExact(acu.referred_user_id)                                AS signups,
            uniqExactIf(acu.referred_user_id, acu.deposit_amount_usd > 0)  AS depositors,
            uniqExactIf(acu.referred_user_id, acu.wager_amount_usd > 0)    AS wagerers,
            sum(acu.wager_amount_usd)                                      AS total_wager,
            sum(acu.referrer_cut_usd)                                      AS commission_accrued
          FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
          WHERE acu._peerdb_is_deleted = 0
            AND acu.status = 'completed'
            ${acuDate}
          GROUP BY acu.code, acu.affiliate_user_id
        ),
        click_agg AS (
          SELECT ac.code AS code, count() AS clicks
          FROM ${CH_DB}.public_affiliate_clicks AS ac FINAL
          WHERE ac._peerdb_is_deleted = 0
            ${clickDate}
          GROUP BY ac.code
        )
      SELECT
        ua.code                              AS code,
        ua.affiliate_user_id                 AS affiliate_user_id,
        u.username                           AS affiliate_username,
        toString(coalesce(ca.clicks, 0))     AS clicks,
        toString(ua.signups)                 AS signups,
        toString(ua.depositors)              AS depositors,
        toString(ua.wagerers)                AS wagerers,
        toString(ua.total_wager)             AS total_wager,
        toString(ua.commission_accrued)      AS commission_accrued
      FROM usage_agg AS ua
      LEFT JOIN click_agg AS ca ON ca.code = ua.code
      INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = ua.affiliate_user_id
      WHERE u._peerdb_is_deleted = 0
        AND u.role NOT IN ('admin','support')
        ${hasBlacklist ? "AND u.id NOT IN {blacklist:Array(String)}" : ""}
      ORDER BY ua.total_wager DESC, ua.signups DESC
      LIMIT ${ROW_LIMIT}
      SETTINGS join_use_nulls = 1`,
    params,
  });

  return rows.map((r) => {
    const clicks = Number(r.clicks);
    const signups = Number(r.signups);
    const depositors = Number(r.depositors);
    const wagerers = Number(r.wagerers);
    return {
      code: r.code,
      affiliateUserId: r.affiliate_user_id,
      affiliateUsername: r.affiliate_username,
      clicks,
      signups,
      depositors,
      wagerers,
      totalDownstreamWager: toNumber(r.total_wager),
      commissionAccrued: toNumber(r.commission_accrued),
      clickToSignupPct: clicks > 0 ? (signups / clicks) * 100 : null,
      signupToDepositPct: signups > 0 ? (depositors / signups) * 100 : null,
      depositToWagerPct: depositors > 0 ? (wagerers / depositors) * 100 : null,
    };
  });
}
