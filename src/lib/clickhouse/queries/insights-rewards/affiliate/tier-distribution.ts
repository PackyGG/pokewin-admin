import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type {
  TierDistribution,
  TierDistributionRow,
} from "@/lib/queries/insights-rewards/affiliate/tier-distribution";

import { CH_DB, toNumber } from "../../_shared";

/**
 * ClickHouse twin of `getAffiliateTierDistribution`
 * (`src/lib/queries/insights-rewards/affiliate/tier-distribution.ts`).
 *
 * PARITY: every real affiliate's `affiliate_accounts.total_wager_volume_usd` is
 * bucketed to the highest configured level whose `threshold` it meets, then
 * aggregated per level against the full `affiliate_level_configs` ladder so every
 * configured level appears even with zero affiliates. PG's
 * `CROSS JOIN LATERAL (… ORDER BY threshold DESC, level DESC LIMIT 1)` is
 * reproduced with `argMax(level, (threshold, level))` over the qualifying configs
 * (the tuple tie-break matches PG's `threshold DESC, level DESC`). Threshold and
 * wager are both `Decimal(20,2)`, so `threshold <= wager` is an exact comparison
 * (no float drift). Share % is derived in TS, identical to PG. Period-agnostic.
 *
 * SCOPE (mirrors PG EXACTLY): admin/support only `role NOT IN ('admin','support')`
 * (creators KEPT) + dynamic blacklist on the affiliate `user.id`.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0` on every mirror table, money
 * Decimal (`toString(sum(...))`, scale-matched `toDecimal128(0, 2)` zero-branch).
 */

type Row = {
  level: number;
  label: string;
  commission_rate: string;
  threshold: string;
  affiliate_count: string;
  total_wager: string;
  total_paid_out: string;
};

export async function getAffiliateTierDistributionFromClickHouse(
  blacklist: string[],
): Promise<TierDistribution> {
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };

  const rows = await clickhouseRead.query<Row>({
    queryName: "insights.affiliate.tier-distribution",
    sql: `
      WITH
        scoped_affiliates AS (
          SELECT
            aa.user_id                  AS user_id,
            aa.total_wager_volume_usd   AS wager,
            aa.total_paid_out_usd       AS paid_out
          FROM ${CH_DB}.public_affiliate_accounts AS aa FINAL
          INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = aa.user_id
          WHERE aa._peerdb_is_deleted = 0
            AND u._peerdb_is_deleted = 0
            AND u.role NOT IN ('admin','support')
            ${hasBlacklist ? "AND u.id NOT IN {blacklist:Array(String)}" : ""}
        ),
        configs AS (
          SELECT level, label, commission_rate, threshold
          FROM ${CH_DB}.public_affiliate_level_configs FINAL
          WHERE _peerdb_is_deleted = 0
        ),
        assigned AS (
          SELECT
            sa.user_id                          AS user_id,
            any(sa.wager)                       AS wager,
            any(sa.paid_out)                    AS paid_out,
            argMax(c.level, (c.threshold, c.level)) AS level
          FROM scoped_affiliates AS sa
          CROSS JOIN configs AS c
          WHERE c.threshold <= sa.wager
          GROUP BY sa.user_id
        ),
        per_level AS (
          SELECT
            level,
            count()        AS cnt,
            sum(wager)     AS w,
            sum(paid_out)  AS p
          FROM assigned
          GROUP BY level
        )
      SELECT
        cfg.level                                          AS level,
        cfg.label                                          AS label,
        toString(cfg.commission_rate)                      AS commission_rate,
        toString(cfg.threshold)                            AS threshold,
        toString(coalesce(pl.cnt, 0))                      AS affiliate_count,
        toString(coalesce(pl.w, toDecimal128(0, 2)))       AS total_wager,
        toString(coalesce(pl.p, toDecimal128(0, 2)))       AS total_paid_out
      FROM configs AS cfg
      LEFT JOIN per_level AS pl ON pl.level = cfg.level
      ORDER BY cfg.level ASC
      SETTINGS join_use_nulls = 1`,
    params,
  });

  const counts = rows.map((r) => Number(r.affiliate_count));
  const totalAffiliates = counts.reduce((a, c) => a + c, 0);

  const out: TierDistributionRow[] = rows.map((r) => {
    const affiliateCount = Number(r.affiliate_count);
    return {
      level: Number(r.level),
      label: r.label,
      commissionRate: toNumber(r.commission_rate),
      threshold: toNumber(r.threshold),
      affiliateCount,
      sharePct:
        totalAffiliates > 0 ? (affiliateCount / totalAffiliates) * 100 : 0,
      totalReferredWager: toNumber(r.total_wager),
      totalCommissionPaid: toNumber(r.total_paid_out),
    };
  });

  return { rows: out, totalAffiliates };
}
