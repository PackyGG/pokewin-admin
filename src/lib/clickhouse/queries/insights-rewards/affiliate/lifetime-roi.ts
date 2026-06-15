import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { LifetimeRoiRow } from "@/lib/queries/insights-rewards/affiliate/lifetime-roi";

import { CH_DB, toNumber } from "../../_shared";

/**
 * ClickHouse twin of `getAffiliateLifetimeRoi`
 * (`src/lib/queries/insights-rewards/affiliate/lifetime-roi.ts`).
 *
 * PARITY: top 25 affiliates by lifetime commission paid, read straight from the
 * `affiliate_accounts` denormalised counters (total_paid_out_usd, available_usd,
 * total_earned_usd, total_wager_volume_usd, total_referred). The ROI proxy +
 * commission % are derived in TS with the IDENTICAL arithmetic the PG twin uses.
 * Period-agnostic (lifetime), exactly like PG.
 *
 * SCOPE (mirrors PG EXACTLY — NOT the wholesale customer scope): admin/support
 * only `role NOT IN ('admin','support')` (creators KEPT) + dynamic blacklist on
 * the affiliate `user.id`. Written inline (NOT `customerScopeCte`, which would
 * also drop creators — a scope change).
 *
 * NOTE: `ORDER BY total_paid_out_usd DESC LIMIT 25` has no secondary tiebreaker
 * on either engine, so a tie straddling the 25th slot could pick a different row
 * set. The compare hook diffs the leaderboard AGGREGATE (Σ commission, Σ wager,
 * Σ earned, row count …) which is stable whenever the top-25 paid-out sums are
 * distinct.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0` on every mirror table, money
 * kept Decimal (`toString(...)` → `toNumber`, never Float).
 */

const ROW_LIMIT = 25;

type Row = {
  affiliate_user_id: string;
  username: string | null;
  total_referred: string;
  total_paid_out: string;
  available: string;
  total_earned: string;
  total_wager: string;
};

export async function getAffiliateLifetimeRoiFromClickHouse(
  blacklist: string[],
): Promise<LifetimeRoiRow[]> {
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };

  const rows = await clickhouseRead.query<Row>({
    queryName: "insights.affiliate.lifetime-roi",
    sql: `
      SELECT
        aa.user_id                          AS affiliate_user_id,
        u.username                          AS username,
        toString(aa.total_referred)         AS total_referred,
        toString(aa.total_paid_out_usd)     AS total_paid_out,
        toString(aa.available_usd)          AS available,
        toString(aa.total_earned_usd)       AS total_earned,
        toString(aa.total_wager_volume_usd) AS total_wager
      FROM ${CH_DB}.public_affiliate_accounts AS aa FINAL
      INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = aa.user_id
      WHERE aa._peerdb_is_deleted = 0
        AND u._peerdb_is_deleted = 0
        AND u.role NOT IN ('admin','support')
        ${hasBlacklist ? "AND u.id NOT IN {blacklist:Array(String)}" : ""}
        AND aa.total_paid_out_usd > 0
      ORDER BY aa.total_paid_out_usd DESC
      LIMIT ${ROW_LIMIT}`,
    params,
  });

  return rows.map((r) => {
    const totalEarned = toNumber(r.total_earned);
    const totalWager = toNumber(r.total_wager);
    return {
      affiliateUserId: r.affiliate_user_id,
      username: r.username,
      totalReferred: Number(r.total_referred),
      lifetimeCommissionPaid: toNumber(r.total_paid_out),
      lifetimeAccruedAvailable: toNumber(r.available),
      lifetimeEarnedGross: totalEarned,
      lifetimeDownstreamWager: totalWager,
      roiProxyUsd: totalWager - totalEarned,
      commissionPctOfWager:
        totalWager > 0 ? (totalEarned / totalWager) * 100 : null,
    };
  });
}
