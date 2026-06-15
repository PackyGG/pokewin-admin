import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { InactiveAffiliateRow } from "@/lib/queries/insights-rewards/affiliate/inactive";

import { CH_DB, chDateTime, toNumber } from "../../_shared";

/**
 * ClickHouse twin of `getInactiveAffiliates`
 * (`src/lib/queries/insights-rewards/affiliate/inactive.ts`).
 *
 * PARITY: `affiliate_accounts` rows with lifetime referrals (`total_referred > 0`)
 * that had NO `affiliate_claim` ledger row in the active window, joined to their
 * lifetime last-claim / last-usage timestamps + in-window downstream wager. Top
 * 25 by lifetime payout (tie-break total_referred), exactly like PG.
 *
 * SCOPE (mirrors PG EXACTLY): admin/support only `role NOT IN ('admin','support')`
 * (creators KEPT) + blacklist on the affiliate `user.id`.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0` on every mirror table, money
 * Decimal (`toString(...)`), `join_use_nulls = 1` so unmatched LEFT JOIN rows
 * yield NULL (the `has_window_usage` / last-seen timestamps resolve correctly,
 * the in-window wager coalesces to a proper zero). The compare hook diffs the
 * row-set AGGREGATE (Σ referred, Σ payout, Σ wager, has-usage count, row count).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ROW_LIMIT = 25;

type Row = {
  affiliate_user_id: string;
  username: string | null;
  total_referred: string;
  total_paid_out_lifetime: string;
  last_claim_at: string | null;
  last_usage_at: string | null;
  window_wager: string;
  has_window_usage: boolean | number;
};

function toIso(v: string | null): string | null {
  if (!v) return null;
  const d = new Date(`${v.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function getInactiveAffiliatesFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<InactiveAffiliateRow[]> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };
  let ltDate = "";
  let acuDate = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    ltDate = "AND lt.created_at >= {cutoff:DateTime64(6)}";
    acuDate = "AND acu.created_at >= {cutoff:DateTime64(6)}";
  }

  const rows = await clickhouseRead.query<Row>({
    queryName: "insights.affiliate.inactive",
    sql: `
      WITH
        paid_in_window AS (
          SELECT DISTINCT lt.user_id AS user_id
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'affiliate_claim'
            ${ltDate}
        ),
        lifetime_claim AS (
          SELECT lt.user_id AS user_id, max(lt.created_at) AS last_at
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'affiliate_claim'
          GROUP BY lt.user_id
        ),
        lifetime_usage AS (
          SELECT acu.affiliate_user_id AS affiliate_user_id, max(acu.created_at) AS last_at
          FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
          WHERE acu._peerdb_is_deleted = 0
            AND acu.status = 'completed'
          GROUP BY acu.affiliate_user_id
        ),
        window_usage AS (
          SELECT acu.affiliate_user_id AS affiliate_user_id, sum(acu.wager_amount_usd) AS wager
          FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
          WHERE acu._peerdb_is_deleted = 0
            AND acu.status = 'completed'
            ${acuDate}
          GROUP BY acu.affiliate_user_id
        )
      SELECT
        aa.user_id                                       AS affiliate_user_id,
        u.username                                       AS username,
        toString(aa.total_referred)                      AS total_referred,
        toString(aa.total_paid_out_usd)                  AS total_paid_out_lifetime,
        toString(lc.last_at)                             AS last_claim_at,
        toString(lu.last_at)                             AS last_usage_at,
        toString(coalesce(wu.wager, toDecimal128(0, 2))) AS window_wager,
        (wu.affiliate_user_id IS NOT NULL)               AS has_window_usage
      FROM ${CH_DB}.public_affiliate_accounts AS aa FINAL
      INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = aa.user_id
      LEFT JOIN lifetime_claim AS lc ON lc.user_id = aa.user_id
      LEFT JOIN lifetime_usage AS lu ON lu.affiliate_user_id = aa.user_id
      LEFT JOIN window_usage AS wu ON wu.affiliate_user_id = aa.user_id
      WHERE aa._peerdb_is_deleted = 0
        AND u._peerdb_is_deleted = 0
        AND aa.total_referred > 0
        AND u.role NOT IN ('admin','support')
        ${hasBlacklist ? "AND u.id NOT IN {blacklist:Array(String)}" : ""}
        AND aa.user_id NOT IN (SELECT user_id FROM paid_in_window)
      ORDER BY aa.total_paid_out_usd DESC, aa.total_referred DESC
      LIMIT ${ROW_LIMIT}
      SETTINGS join_use_nulls = 1`,
    params,
  });

  return rows.map((r) => ({
    affiliateUserId: r.affiliate_user_id,
    username: r.username,
    totalReferred: Number(r.total_referred),
    totalPaidOutLifetime: toNumber(r.total_paid_out_lifetime),
    lastClaimAt: toIso(r.last_claim_at),
    lastUsageAt: toIso(r.last_usage_at),
    windowDownstreamWager: toNumber(r.window_wager),
    hasWindowUsage: Boolean(Number(r.has_window_usage)),
  }));
}
