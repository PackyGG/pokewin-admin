import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { DepositBonusRatioDistribution } from "@/lib/queries/insights-rewards/deposit-bonus/cohort";

import { CH_DB, toNumber } from "../../_shared";
import { depositBonusCappedCutoff, depositBonusScopeCte } from "./_shared";

/**
 * ClickHouse twin of the bonus/deposit ratio distribution
 * (`getDepositBonusRatioDistribution` → `computeRatioDistribution` in
 * `src/lib/queries/insights-rewards/deposit-bonus/cohort.ts`).
 *
 * Pairs every non-zero completed deposit (CAPPED window) to its FIRST matching
 * deposit_bonus (canonical balance_before = balance_after, < 30s, earliest via
 * `argMin`), computes ratio = bonus/deposit, and buckets into the 5 PG bands
 * (0–5 / 5–15 / 15–30 / 30–60 / 60%+). Per-bucket COUNT + Decimal Σ volume are
 * cent/count-exact and gated; bucket boundaries are evaluated in INTEGER CENTS
 * (e.g. `100·bonus < 5·deposit`) so there is zero float boundary drift.
 *
 * `meanRatio` (global mean) and `medianRatio` (interpolated quantile) are
 * returned for shape parity but NOT gated by the drift check — PG computes them
 * with `numeric` AVG / `PERCENTILE_CONT`, which CH cannot reproduce bit-exactly
 * (Float64 quantile). 2-role customer scope + blacklist.
 */

const RATIO_LABELS = ["0–5%", "5–15%", "15–30%", "30–60%", "60%+"] as const;

export async function getDepositBonusRatioDistributionFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusRatioDistribution> {
  const hasBlacklist = blacklist.length > 0;
  const scope = depositBonusScopeCte(hasBlacklist);
  const cutoff = depositBonusCappedCutoff(period, now);
  const params: Record<string, unknown> = { blacklist, cutoff };

  const pairedCte = `
    ${scope},
    dep_rows AS (
      SELECT d.id AS id, d.user_id AS user_id, abs(d.amount) AS deposit_usd,
             d.balance_after AS bal_after, d.created_at AS created_at
      FROM ${CH_DB}.public_ledger_transactions AS d FINAL
      WHERE d._peerdb_is_deleted = 0
        AND d.status = 'completed'
        AND d.type = 'deposit'
        AND d.user_id IN (SELECT id FROM real_users)
        AND d.amount != 0
        AND d.created_at >= {cutoff:DateTime64(6)}
    ),
    bon_rows AS (
      SELECT b.user_id AS user_id, b.balance_before AS bal_before,
             abs(b.amount) AS bonus_usd, b.created_at AS created_at
      FROM ${CH_DB}.public_ledger_transactions AS b FINAL
      WHERE b._peerdb_is_deleted = 0
        AND b.status = 'completed'
        AND b.type = 'deposit_bonus'
        AND b.created_at >= {cutoff:DateTime64(6)}
    ),
    paired AS (
      SELECT
        d.deposit_usd AS deposit_usd,
        argMin(b.bonus_usd, b.created_at) AS bonus_usd
      FROM dep_rows AS d
      INNER JOIN bon_rows AS b ON b.user_id = d.user_id AND b.bal_before = d.bal_after
      WHERE b.created_at >= d.created_at
        AND b.created_at < d.created_at + INTERVAL 30 SECOND
      GROUP BY d.id, d.deposit_usd
    )`;

  const [bucketRows, statRows] = await Promise.all([
    clickhouseRead.query<{ bucket: string; cnt: string; volume: string }>({
      queryName: "insights.deposit_bonus.ratio_distribution.buckets",
      sql: `
        WITH ${pairedCte},
        binned AS (
          SELECT
            multiIf(
              100 * toInt64(round(bonus_usd * 100)) <  5 * toInt64(round(deposit_usd * 100)), 0,
              100 * toInt64(round(bonus_usd * 100)) < 15 * toInt64(round(deposit_usd * 100)), 1,
              100 * toInt64(round(bonus_usd * 100)) < 30 * toInt64(round(deposit_usd * 100)), 2,
              100 * toInt64(round(bonus_usd * 100)) < 60 * toInt64(round(deposit_usd * 100)), 3,
              4
            ) AS bucket,
            bonus_usd
          FROM paired
        )
        SELECT toString(bucket) AS bucket, toString(count()) AS cnt, toString(sum(bonus_usd)) AS volume
        FROM binned
        GROUP BY bucket
        ORDER BY bucket`,
      params,
    }),
    clickhouseRead.query<{ mean_ratio: string | null; median_ratio: string | null; total: string }>({
      queryName: "insights.deposit_bonus.ratio_distribution.stats",
      sql: `
        WITH ${pairedCte}
        SELECT
          toString(avg(toFloat64(bonus_usd) / toFloat64(deposit_usd)))                       AS mean_ratio,
          toString(quantileExactInclusive(0.5)(toFloat64(bonus_usd) / toFloat64(deposit_usd))) AS median_ratio,
          toString(count())                                            AS total
        FROM paired`,
      params,
    }),
  ]);

  const ratioBuckets = RATIO_LABELS.map((label) => ({ label, count: 0, volume: 0 }));
  let totalPaired = 0;
  for (const r of bucketRows) {
    const idx = Number(r.bucket);
    const cnt = Number(r.cnt ?? 0);
    totalPaired += cnt;
    if (idx >= 0 && idx < ratioBuckets.length) {
      ratioBuckets[idx].count = cnt;
      ratioBuckets[idx].volume = toNumber(r.volume);
    }
  }

  return {
    totalDeposits: totalPaired,
    ratioBuckets,
    meanRatio: statRows[0]?.mean_ratio != null ? toNumber(statRows[0].mean_ratio) : 0,
    medianRatio: statRows[0]?.median_ratio != null ? toNumber(statRows[0].median_ratio) : 0,
  };
}
