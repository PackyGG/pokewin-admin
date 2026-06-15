import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { RakebackDailyPoint } from "@/lib/queries/insights-rewards/rakeback/daily";

import { CH_DB, chDateTime, customerScopeCte, toNumber } from "../../_shared";

/**
 * ClickHouse twin of `getRakebackDaily`
 * (`src/lib/queries/insights-rewards/rakeback/daily.ts`).
 *
 * PARITY: day-by-day breakdown over `public_rakeback_claims` (claimed_at
 * non-null) — claim count, rakeback volume, distinct claimants per UTC day,
 * sorted ASC. The per-claim average is derived in TS with the IDENTICAL
 * arithmetic the PG twin uses. `toDate` truncates the DateTime64 to the UTC
 * calendar day, mirroring the PG `DATE(claimed_at)` bucket (prod runs UTC).
 *
 * SCOPE (mirrors PG EXACTLY): wholesale customer scope
 * `role NOT IN ('admin','support','creator')` + blacklist — `customerScopeCte`.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0`, `uniqExact` for the exact
 * per-day distinct-claimant count, money Decimal (`toString(sum(...))` →
 * `toNumber`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

type DayRow = {
  date: string;
  cnt: string;
  volume: string;
  distinct_users: string;
};

export async function getRakebackDailyFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RakebackDailyPoint[]> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const scope = customerScopeCte({ hasBlacklist });

  const params: Record<string, unknown> = { blacklist };
  let dateClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    dateClause = "AND rc.claimed_at >= {cutoff:DateTime64(6)}";
  }

  const rows = await clickhouseRead.query<DayRow>({
    queryName: "insights.rewards.rakeback.daily",
    sql: `
      WITH ${scope}
      SELECT
        toString(toDate(rc.claimed_at))      AS date,
        toString(count())                    AS cnt,
        toString(sum(rc.rakeback_amount_usd)) AS volume,
        toString(uniqExact(rc.user_id))      AS distinct_users
      FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
      WHERE rc._peerdb_is_deleted = 0
        AND rc.claimed_at IS NOT NULL
        AND rc.user_id IN (SELECT id FROM real_users)
        ${dateClause}
      GROUP BY toDate(rc.claimed_at)
      ORDER BY date ASC`,
    params,
  });

  return rows.map((r) => {
    const count = Number(r.cnt);
    const volume = toNumber(r.volume);
    return {
      date: String(r.date).slice(0, 10),
      count,
      volume,
      avg: count > 0 ? volume / count : 0,
      distinctClaimants: Number(r.distinct_users),
    };
  });
}
