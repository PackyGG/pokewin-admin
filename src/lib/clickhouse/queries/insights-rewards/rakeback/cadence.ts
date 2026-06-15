import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { RakebackCadence } from "@/lib/queries/insights-rewards/rakeback/cadence";

import { CH_DB, chDateTime, customerScopeCte } from "../../_shared";

/**
 * ClickHouse twin of `getRakebackCadence`
 * (`src/lib/queries/insights-rewards/rakeback/cadence.ts`).
 *
 * PARITY: headline claim count + distinct claimants in window, plus the
 * gap-between-consecutive-claims distribution. The CH leg reproduces the PG
 * `LAG(claimed_at) OVER (PARTITION BY user_id ORDER BY claimed_at)` with
 * `lagInFrame` over the same physical-row frame, emitting one gap-hours row per
 * (user, consecutive-claim) pair (the first claim per user yields no row), then
 * runs the BYTE-IDENTICAL TS bucketing + median so the histogram matches by
 * construction. Gap hours use `(microsΔ) / 3.6e9`, the same value PG's
 * `EXTRACT(EPOCH FROM (claimed_at − prev)) / 3600` produces.
 *
 * SCOPE (mirrors PG EXACTLY): `role NOT IN ('admin','support','creator')` +
 * blacklist — `customerScopeCte`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const BUCKET_DEFS = [
  { label: "< 1h", minH: 0, maxH: 1 },
  { label: "1–24h", minH: 1, maxH: 24 },
  { label: "1–7d", minH: 24, maxH: 24 * 7 },
  { label: "7d+", minH: 24 * 7, maxH: Infinity },
] as const;

type HeadlineRow = { cnt: string; distinct_users: string };
type GapRow = { gap_h: string | number };

export async function getRakebackCadenceFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RakebackCadence> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const scope = customerScopeCte({ hasBlacklist });

  const params: Record<string, unknown> = { blacklist };
  let dateClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    dateClause = "AND rc.claimed_at >= {cutoff:DateTime64(6)}";
  }

  const [headlineRows, gapRows] = await Promise.all([
    clickhouseRead.query<HeadlineRow>({
      queryName: "insights.rewards.rakeback.cadence.headline",
      sql: `
        WITH ${scope}
        SELECT
          toString(count())               AS cnt,
          toString(uniqExact(rc.user_id)) AS distinct_users
        FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
        WHERE rc._peerdb_is_deleted = 0
          AND rc.claimed_at IS NOT NULL
          AND rc.user_id IN (SELECT id FROM real_users)
          ${dateClause}`,
      params,
    }),
    clickhouseRead.query<GapRow>({
      queryName: "insights.rewards.rakeback.cadence.gaps",
      sql: `
        WITH
          ${scope},
          ordered AS (
            SELECT
              assumeNotNull(rc.claimed_at) AS ca,
              lagInFrame(assumeNotNull(rc.claimed_at)) OVER (
                PARTITION BY rc.user_id ORDER BY rc.claimed_at
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              ) AS prev_ca,
              row_number() OVER (
                PARTITION BY rc.user_id ORDER BY rc.claimed_at
              ) AS rn
            FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
            WHERE rc._peerdb_is_deleted = 0
              AND rc.claimed_at IS NOT NULL
              AND rc.user_id IN (SELECT id FROM real_users)
              ${dateClause}
          )
        SELECT
          (toUnixTimestamp64Micro(ca) - toUnixTimestamp64Micro(prev_ca)) / 3600e6 AS gap_h
        FROM ordered
        WHERE rn > 1`,
      params,
    }),
  ]);

  const totalClaims = Number(headlineRows[0]?.cnt ?? 0);
  const distinctClaimants = Number(headlineRows[0]?.distinct_users ?? 0);
  const avgClaimsPerActiveUser =
    distinctClaimants > 0 ? totalClaims / distinctClaimants : 0;

  // Identical post-processing to the PG twin's computeCadence.
  const gaps = gapRows
    .map((r) => Number(r.gap_h))
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);
  const medianGapHours =
    gaps.length === 0
      ? 0
      : gaps.length % 2 === 1
        ? gaps[(gaps.length - 1) / 2]
        : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;

  const buckets = BUCKET_DEFS.map((b) => ({ label: b.label, count: 0 }));
  for (const h of gaps) {
    let idx = BUCKET_DEFS.length - 1;
    for (let i = 0; i < BUCKET_DEFS.length; i++) {
      if (h < BUCKET_DEFS[i].maxH) {
        idx = i;
        break;
      }
    }
    buckets[idx].count += 1;
  }
  const totalGapRows = gaps.length;

  return {
    totalClaims,
    distinctClaimants,
    avgClaimsPerActiveUser,
    medianGapHours,
    buckets: buckets.map((b) => ({
      label: b.label,
      count: b.count,
      share: totalGapRows > 0 ? (b.count / totalGapRows) * 100 : 0,
    })),
  };
}
