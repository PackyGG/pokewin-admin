import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { RakebackRateDistribution } from "@/lib/queries/insights-rewards/rakeback/rate-distribution";

import { CH_DB, chDateTime, customerScopeCte, toNumber } from "../../_shared";

/**
 * ClickHouse twin of `getRakebackRateDistribution`
 * (`src/lib/queries/insights-rewards/rakeback/rate-distribution.ts`).
 *
 * PARITY: the CH leg fetches the SAME per-claimant aggregate the PG twin does —
 * one row per claimant with `SUM(rakeback)` + `SUM(wager)`, filtered to
 * `HAVING SUM(wager) > 0` — then runs the BYTE-IDENTICAL TS post-processing
 * (volume-weighted avg, per-user-ratio buckets, median, p95) so the cohort lens
 * matches by construction. Money stays Decimal in SQL → `toNumber` in TS.
 *
 * SCOPE (mirrors PG EXACTLY): `role NOT IN ('admin','support','creator')` +
 * blacklist — `customerScopeCte`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const BUCKET_DEFS = [
  { label: "0–1%", minPct: 0, maxPct: 1 },
  { label: "1–3%", minPct: 1, maxPct: 3 },
  { label: "3–5%", minPct: 3, maxPct: 5 },
  { label: "5–10%", minPct: 5, maxPct: 10 },
  { label: "10%+", minPct: 10, maxPct: Infinity },
] as const;

type UserRow = {
  user_id: string;
  total_rakeback: string;
  total_wager: string;
};

export async function getRakebackRateDistributionFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RakebackRateDistribution> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const scope = customerScopeCte({ hasBlacklist });

  const params: Record<string, unknown> = { blacklist };
  let dateClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    dateClause = "AND rc.claimed_at >= {cutoff:DateTime64(6)}";
  }

  const rows = await clickhouseRead.query<UserRow>({
    queryName: "insights.rewards.rakeback.rate-distribution",
    sql: `
      WITH ${scope}
      SELECT
        rc.user_id                            AS user_id,
        toString(sum(rc.rakeback_amount_usd)) AS total_rakeback,
        toString(sum(rc.wagered_amount_usd))  AS total_wager
      FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
      WHERE rc._peerdb_is_deleted = 0
        AND rc.claimed_at IS NOT NULL
        AND rc.user_id IN (SELECT id FROM real_users)
        ${dateClause}
      GROUP BY rc.user_id
      HAVING sum(rc.wagered_amount_usd) > 0`,
    params,
  });

  // Identical post-processing to the PG twin's computeRateDistribution.
  let sumRakeback = 0;
  let sumWager = 0;
  const userPcts: number[] = [];
  const buckets = BUCKET_DEFS.map((b) => ({ label: b.label, count: 0 }));

  for (const r of rows) {
    const rake = toNumber(r.total_rakeback);
    const wager = toNumber(r.total_wager);
    sumRakeback += rake;
    sumWager += wager;
    if (wager <= 0) continue;
    const pct = (rake / wager) * 100;
    if (!Number.isFinite(pct) || pct < 0) continue;
    userPcts.push(pct);
    let idx = BUCKET_DEFS.length - 1;
    for (let i = 0; i < BUCKET_DEFS.length; i++) {
      if (pct < BUCKET_DEFS[i].maxPct) {
        idx = i;
        break;
      }
    }
    buckets[idx].count += 1;
  }

  userPcts.sort((a, b) => a - b);
  const median =
    userPcts.length === 0
      ? 0
      : userPcts.length % 2 === 1
        ? userPcts[(userPcts.length - 1) / 2]
        : (userPcts[userPcts.length / 2 - 1] +
            userPcts[userPcts.length / 2]) /
          2;
  const p95Idx =
    userPcts.length === 0
      ? 0
      : Math.min(userPcts.length - 1, Math.floor(0.95 * userPcts.length));
  const p95 = userPcts.length === 0 ? 0 : userPcts[p95Idx];

  const cohortSize = userPcts.length;
  const avgPctOfWager = sumWager > 0 ? (sumRakeback / sumWager) * 100 : 0;

  return {
    avgPctOfWager,
    medianPctOfWager: median,
    p95PctOfWager: p95,
    cohortSize,
    buckets: buckets.map((b) => ({
      label: b.label,
      count: b.count,
      share: cohortSize > 0 ? (b.count / cohortSize) * 100 : 0,
    })),
  };
}
