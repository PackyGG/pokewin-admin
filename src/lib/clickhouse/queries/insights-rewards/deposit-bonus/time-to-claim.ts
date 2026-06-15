import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { DepositBonusTimeToClaim } from "@/lib/queries/insights-rewards/deposit-bonus/behavior";

import { CH_DB, toNumber } from "../../_shared";
import { depositBonusCappedCutoff, depositBonusScopeCte } from "./_shared";

/**
 * ClickHouse twin of the deposit-bonus time-to-claim latency distribution
 * (`getDepositBonusTimeToClaim` → `computeTimeToClaim` in
 * `src/lib/queries/insights-rewards/deposit-bonus/behavior.ts`).
 *
 * Pairs each CAPPED-window deposit to its FIRST matching deposit_bonus
 * (canonical balance pairing) and measures latency seconds. The 6 latency
 * buckets (<1 / 1–2 / 2–5 / 5–10 / 10–30 / 30s+) COUNTS + totalPaired are
 * count-exact and gated; latency is computed in fractional microseconds
 * (`toUnixTimestamp64Micro`) so the integer bucket boundaries match PG's
 * `EXTRACT(EPOCH …)` exactly. The median/p95/p99/mean/max latency stats are
 * returned for shape parity but NOT gated (PG `PERCENTILE_CONT`/`AVG` vs CH
 * Float64 quantile cannot be bit-exact). 2-role customer scope + blacklist.
 */

const TIME_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "< 1s", min: 0, max: 1 },
  { label: "1–2s", min: 1, max: 2 },
  { label: "2–5s", min: 2, max: 5 },
  { label: "5–10s", min: 5, max: 10 },
  { label: "10–30s", min: 10, max: 30 },
  { label: "30s+", min: 30, max: 999_999 },
];

const DELTA = "(toUnixTimestamp64Micro(b.created_at) - toUnixTimestamp64Micro(d.created_at)) / 1000000.0";

export async function getDepositBonusTimeToClaimFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<DepositBonusTimeToClaim> {
  const hasBlacklist = blacklist.length > 0;
  const scope = depositBonusScopeCte(hasBlacklist);
  const cutoff = depositBonusCappedCutoff(period, now);
  const params: Record<string, unknown> = { blacklist, cutoff };

  const pairedCte = `
    ${scope},
    dep_rows AS (
      SELECT d.id AS id, d.user_id AS user_id, d.balance_after AS bal_after, d.created_at AS created_at
      FROM ${CH_DB}.public_ledger_transactions AS d FINAL
      WHERE d._peerdb_is_deleted = 0
        AND d.status = 'completed'
        AND d.type = 'deposit'
        AND d.user_id IN (SELECT id FROM real_users)
        AND d.created_at >= {cutoff:DateTime64(6)}
    ),
    bon_rows AS (
      SELECT b.user_id AS user_id, b.balance_before AS bal_before, b.created_at AS created_at
      FROM ${CH_DB}.public_ledger_transactions AS b FINAL
      WHERE b._peerdb_is_deleted = 0
        AND b.status = 'completed'
        AND b.type = 'deposit_bonus'
        AND b.created_at >= {cutoff:DateTime64(6)}
    ),
    paired AS (
      SELECT min(${DELTA}) AS delta_s
      FROM dep_rows AS d
      INNER JOIN bon_rows AS b ON b.user_id = d.user_id AND b.bal_before = d.bal_after
      WHERE b.created_at >= d.created_at
        AND b.created_at < d.created_at + INTERVAL 30 SECOND
      GROUP BY d.id
    )`;

  const [bucketRows, statRows] = await Promise.all([
    clickhouseRead.query<{ bucket: string; cnt: string }>({
      queryName: "insights.deposit_bonus.time_to_claim.buckets",
      sql: `
        WITH ${pairedCte}
        SELECT
          toString(multiIf(delta_s < 1, 0, delta_s < 2, 1, delta_s < 5, 2, delta_s < 10, 3, delta_s < 30, 4, 5)) AS bucket,
          toString(count()) AS cnt
        FROM paired
        GROUP BY bucket
        ORDER BY bucket`,
      params,
      timeoutMs: 30_000,
    }),
    clickhouseRead.query<{
      median_s: string | null;
      p95_s: string | null;
      p99_s: string | null;
      mean_s: string | null;
      max_s: string | null;
    }>({
      queryName: "insights.deposit_bonus.time_to_claim.stats",
      sql: `
        WITH ${pairedCte}
        SELECT
          toString(quantileExactInclusive(0.5)(delta_s))  AS median_s,
          toString(quantileExactInclusive(0.95)(delta_s)) AS p95_s,
          toString(quantileExactInclusive(0.99)(delta_s)) AS p99_s,
          toString(avg(delta_s))                          AS mean_s,
          toString(max(delta_s))                          AS max_s
        FROM paired`,
      params,
      timeoutMs: 30_000,
    }),
  ]);

  const buckets = TIME_BUCKETS.map((b) => ({
    label: b.label,
    minSeconds: b.min,
    maxSeconds: b.max === 999_999 ? Number.POSITIVE_INFINITY : b.max,
    count: 0,
  }));
  let totalPaired = 0;
  for (const r of bucketRows) {
    const idx = Number(r.bucket);
    const cnt = Number(r.cnt ?? 0);
    if (idx >= 0 && idx < buckets.length) buckets[idx].count = cnt;
    totalPaired += cnt;
  }

  const s = statRows[0];
  return {
    buckets,
    totalPaired,
    medianSeconds: s?.median_s != null ? toNumber(s.median_s) : 0,
    p95Seconds: s?.p95_s != null ? toNumber(s.p95_s) : 0,
    p99Seconds: s?.p99_s != null ? toNumber(s.p99_s) : 0,
    meanSeconds: s?.mean_s != null ? toNumber(s.mean_s) : 0,
    maxSeconds: s?.max_s != null ? toNumber(s.max_s) : 0,
  };
}
