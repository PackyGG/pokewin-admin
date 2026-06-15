import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type {
  RaceOverviewKpis,
  RacePrizeDailyPoint,
} from "@/lib/queries/insights-rewards/race/overview";

import { CH_DB, chDateTime, toNumber } from "../../_shared";
import { raceScopeCte } from "./_scope";

/**
 * ClickHouse twin of `getRaceInsightsOverview`
 * (`src/lib/queries/insights-rewards/race/overview.ts`).
 *
 * PARITY: source is `public_race_claims` — one rollup (total prize, distinct
 * races = `uniqExact((race_type, race_period_start))`, distinct winners, prize
 * lines) plus a per-`toDate(claimed_at)` daily series, both scoped to the active
 * window. The averages (per race / per winner) are derived in TS with the
 * IDENTICAL arithmetic the PG twin uses.
 *
 * SCOPE (mirrors PG EXACTLY): `role NOT IN ('admin','support')` (creators KEPT)
 * + blacklist — `raceScopeCte`.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0`, `uniqExact` for the exact
 * distinct counts, money kept Decimal (`toString(sum(...))` → `toNumber`). The
 * window cutoff is derived from a single caller-supplied `now` via
 * `daysForInsightsPeriod`, matching the PG `NOW() - INTERVAL 'N days'`
 * arithmetic (prod runs UTC).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

type RollupRow = {
  total: string;
  distinct_races: string;
  distinct_winners: string;
  winner_count: string;
};

type DailyRow = { date: string; total: string; cnt: string };

export async function getRaceInsightsOverviewFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RaceOverviewKpis> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const scope = raceScopeCte(hasBlacklist);

  const params: Record<string, unknown> = { blacklist };
  let dateClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    dateClause = "AND rc.claimed_at >= {cutoff:DateTime64(6)}";
  }

  const [rollupRows, dailyRows] = await Promise.all([
    clickhouseRead.query<RollupRow>({
      queryName: "insights.rewards.race.overview.rollup",
      sql: `
        WITH ${scope}
        SELECT
          toString(sum(rc.prize_amount_usd))                  AS total,
          toString(uniqExact((rc.race_type, rc.race_period_start))) AS distinct_races,
          toString(uniqExact(rc.user_id))                     AS distinct_winners,
          toString(count())                                   AS winner_count
        FROM ${CH_DB}.public_race_claims AS rc FINAL
        WHERE rc._peerdb_is_deleted = 0
          AND rc.user_id IN (SELECT id FROM real_users)
          ${dateClause}`,
      params,
    }),
    clickhouseRead.query<DailyRow>({
      queryName: "insights.rewards.race.overview.daily",
      sql: `
        WITH ${scope}
        SELECT
          toString(toDate(rc.claimed_at))    AS date,
          toString(sum(rc.prize_amount_usd)) AS total,
          toString(count())                  AS cnt
        FROM ${CH_DB}.public_race_claims AS rc FINAL
        WHERE rc._peerdb_is_deleted = 0
          AND rc.user_id IN (SELECT id FROM real_users)
          ${dateClause}
        GROUP BY toDate(rc.claimed_at)
        ORDER BY date ASC`,
      params,
    }),
  ]);

  const r = rollupRows[0];
  const totalPrizePaid = toNumber(r?.total);
  const distinctRaces = Number(r?.distinct_races ?? 0);
  const distinctWinners = Number(r?.distinct_winners ?? 0);
  const winnerCount = Number(r?.winner_count ?? 0);
  const avgPrizePerRace =
    distinctRaces > 0 ? totalPrizePaid / distinctRaces : 0;
  const avgPrizePerWinner =
    distinctWinners > 0 ? totalPrizePaid / distinctWinners : 0;

  const dailyPrizes: RacePrizeDailyPoint[] = dailyRows.map((row) => ({
    date: row.date,
    total: toNumber(row.total),
    count: Number(row.cnt),
  }));

  return {
    totalPrizePaid,
    distinctRaces,
    distinctWinners,
    winnerCount,
    avgPrizePerRace,
    avgPrizePerWinner,
    dailyPrizes,
  };
}
