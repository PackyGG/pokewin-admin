import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type {
  RaceRepeatWinner,
  RaceRepeatFrequencyBucket,
  RaceRepeatWinnersResult,
} from "@/lib/queries/insights-rewards/race/repeat-winners";

import { CH_DB, chDateTime, toNumber } from "../../_shared";
import { raceScopeCte } from "./_scope";

/**
 * ClickHouse twin of `getRaceInsightsRepeatWinners`
 * (`src/lib/queries/insights-rewards/race/repeat-winners.ts`).
 *
 * PARITY: per-user race count = `uniqExact((race_type, race_period_start))` and
 * cumulative prize over `public_race_claims`, keeping only users with > 1 race
 * (the repeat winners). Returns the top 10 by cumulative prize (with username),
 * the frequency-bucket distribution (2 / 3 / 4–5 / 6–10 / 11+) over ALL repeat
 * winners, and the repeat-winner head count. `avgPrize` is derived in TS
 * identically to the PG twin.
 *
 * The top-10 list has no secondary tiebreaker on either engine (mirrors PG), so
 * the compare hook diffs only the FULL-population stable aggregates (head count,
 * Σ race_count, Σ prize, the 5 bucket counts + bucket prize) — never the top-10
 * row identities.
 *
 * SCOPE (mirrors PG EXACTLY): `role NOT IN ('admin','support')` (creators KEPT)
 * + blacklist — `raceScopeCte`.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0`, `uniqExact` for the exact
 * per-user race count, money Decimal (`toString(sum(...))` → `toNumber`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

type TopRow = {
  user_id: string;
  username: string | null;
  race_count: string;
  total_prize: string;
};

type AllRow = { race_count: string; total_prize: string };

export async function getRaceInsightsRepeatWinnersFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RaceRepeatWinnersResult> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const scope = raceScopeCte(hasBlacklist);

  const params: Record<string, unknown> = { blacklist };
  let dateClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    dateClause = "AND rc.claimed_at >= {cutoff:DateTime64(6)}";
  }

  const perUserCte = `
    per_user AS (
      SELECT
        rc.user_id AS user_id,
        uniqExact((rc.race_type, rc.race_period_start)) AS race_count,
        sum(rc.prize_amount_usd) AS total_prize
      FROM ${CH_DB}.public_race_claims AS rc FINAL
      WHERE rc._peerdb_is_deleted = 0
        AND rc.user_id IN (SELECT id FROM real_users)
        ${dateClause}
      GROUP BY rc.user_id
      HAVING uniqExact((rc.race_type, rc.race_period_start)) > 1
    )`;

  const [topRows, allRows] = await Promise.all([
    clickhouseRead.query<TopRow>({
      queryName: "insights.rewards.race.repeat.top",
      sql: `
        WITH
          ${scope},
          ${perUserCte}
        SELECT
          pu.user_id              AS user_id,
          u.username              AS username,
          toString(pu.race_count) AS race_count,
          toString(pu.total_prize) AS total_prize
        FROM per_user AS pu
        INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = pu.user_id
        WHERE u._peerdb_is_deleted = 0
        ORDER BY pu.total_prize DESC
        LIMIT 10`,
      params,
    }),
    clickhouseRead.query<AllRow>({
      queryName: "insights.rewards.race.repeat.all",
      sql: `
        WITH
          ${scope},
          ${perUserCte}
        SELECT
          toString(pu.race_count)  AS race_count,
          toString(pu.total_prize) AS total_prize
        FROM per_user AS pu`,
      params,
    }),
  ]);

  const topRepeatWinners: RaceRepeatWinner[] = topRows.map((r) => {
    const raceCount = Number(r.race_count ?? 0);
    const totalPrize = toNumber(r.total_prize);
    return {
      userId: r.user_id,
      username: r.username,
      raceCount,
      totalPrize,
      avgPrize: raceCount > 0 ? totalPrize / raceCount : 0,
    };
  });

  const BUCKET_LABELS = [
    { label: "2 races", min: 2, max: 2 },
    { label: "3 races", min: 3, max: 3 },
    { label: "4–5", min: 4, max: 5 },
    { label: "6–10", min: 6, max: 10 },
    { label: "11+", min: 11, max: Number.POSITIVE_INFINITY },
  ];
  const buckets: RaceRepeatFrequencyBucket[] = BUCKET_LABELS.map((b) => ({
    label: b.label,
    userCount: 0,
    totalPrize: 0,
  }));
  for (const r of allRows) {
    const rc = Number(r.race_count);
    if (!Number.isFinite(rc) || rc < 2) continue;
    const prize = toNumber(r.total_prize);
    const idx = BUCKET_LABELS.findIndex((b) => rc >= b.min && rc <= b.max);
    if (idx === -1) continue;
    buckets[idx].userCount += 1;
    buckets[idx].totalPrize += prize;
  }

  return {
    totalRepeatWinners: allRows.length,
    topRepeatWinners,
    frequencyBuckets: buckets,
  };
}
