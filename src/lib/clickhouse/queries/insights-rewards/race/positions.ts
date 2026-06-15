import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { RacePositionBucket } from "@/lib/queries/insights-rewards/race/positions";

import { CH_DB, chDateTime, toNumber } from "../../_shared";
import { raceScopeCte } from "./_scope";

/**
 * ClickHouse twin of `getRaceInsightsPositions`
 * (`src/lib/queries/insights-rewards/race/positions.ts`).
 *
 * PARITY: buckets prize claims by finishing position into five fixed tiers —
 * 1st / 2–3 / 4–10 / 11–25 / 26+ — each carrying count + USD volume + avg prize.
 * The PG twin pulls every (position, prize) row and buckets in JS; the CH twin
 * buckets in SQL with the IDENTICAL boundaries (`multiIf`) and sums money as
 * Decimal. Both drop non-positive positions. `avgPrize` is derived in TS
 * identically.
 *
 * SCOPE (mirrors PG EXACTLY): `role NOT IN ('admin','support')` (creators KEPT)
 * + blacklist — `raceScopeCte`.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0`, money Decimal
 * (`toString(sum(...))` → `toNumber`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET_LABELS = ["1st", "2–3", "4–10", "11–25", "26+"];

type BucketRow = { idx: string; cnt: string; volume: string };

export async function getRaceInsightsPositionsFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RacePositionBucket[]> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const scope = raceScopeCte(hasBlacklist);

  const params: Record<string, unknown> = { blacklist };
  let dateClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    dateClause = "AND rc.claimed_at >= {cutoff:DateTime64(6)}";
  }

  const rows = await clickhouseRead.query<BucketRow>({
    queryName: "insights.rewards.race.positions",
    sql: `
      WITH ${scope}
      SELECT
        multiIf(rc.position = 1, 0, rc.position <= 3, 1, rc.position <= 10, 2, rc.position <= 25, 3, 4) AS idx,
        toString(count())                  AS cnt,
        toString(sum(rc.prize_amount_usd)) AS volume
      FROM ${CH_DB}.public_race_claims AS rc FINAL
      WHERE rc._peerdb_is_deleted = 0
        AND rc.user_id IN (SELECT id FROM real_users)
        AND rc.position > 0
        ${dateClause}
      GROUP BY idx`,
    params,
  });

  const buckets: RacePositionBucket[] = BUCKET_LABELS.map((label) => ({
    label,
    count: 0,
    volume: 0,
    avgPrize: 0,
  }));
  for (const r of rows) {
    const idx = Number(r.idx);
    if (idx < 0 || idx > 4) continue;
    buckets[idx].count = Number(r.cnt);
    buckets[idx].volume = toNumber(r.volume);
  }
  for (const b of buckets) {
    b.avgPrize = b.count > 0 ? b.volume / b.count : 0;
  }
  return buckets;
}
