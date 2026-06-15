import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type {
  RaceTopWinner,
  RaceTopWinnersResult,
} from "@/lib/queries/insights-rewards/race/top-winners";

import { CH_DB, chDateTime, toNumber } from "../../_shared";
import { raceScopeCte } from "./_scope";

/**
 * ClickHouse twin of `getRaceInsightsTopWinners`
 * (`src/lib/queries/insights-rewards/race/top-winners.ts`).
 *
 * PARITY: top 25 winners by total race prize in the active window (with a
 * lifetime-total context column from an all-time SUM CTE) + top 25 all-time.
 * `race_count` = `uniqExact((race_type, race_period_start))`; `avgPrize` is
 * derived in TS identically to the PG twin.
 *
 * `ORDER BY total_prize DESC LIMIT 25` has no secondary tiebreaker on either
 * engine (mirrors PG), so the compare hook diffs the leaderboard aggregate
 * (Σ prize, Σ race_count, Σ lifetime, row count) which is stable whenever the
 * top-25 sums are distinct.
 *
 * SCOPE (mirrors PG EXACTLY): `role NOT IN ('admin','support')` (creators KEPT)
 * + blacklist — `raceScopeCte`.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0`, `uniqExact` for the exact
 * race count, money Decimal with scale-matched `toDecimal128(0, 2)` zero-branch.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_LIMIT = 25;

type PeriodRow = {
  user_id: string;
  username: string | null;
  race_count: string;
  total_prize: string;
  lifetime_total: string;
};

type LifetimeRow = {
  user_id: string;
  username: string | null;
  race_count: string;
  total_prize: string;
};

export async function getRaceInsightsTopWinnersFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RaceTopWinnersResult> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const scope = raceScopeCte(hasBlacklist);

  const params: Record<string, unknown> = { blacklist };
  let dateClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    dateClause = "AND rc.claimed_at >= {cutoff:DateTime64(6)}";
  }

  const [periodRows, lifetimeRows] = await Promise.all([
    clickhouseRead.query<PeriodRow>({
      queryName: "insights.rewards.race.top-winners.period",
      sql: `
        WITH
          ${scope},
          lifetime AS (
            SELECT rc.user_id AS user_id, sum(rc.prize_amount_usd) AS total
            FROM ${CH_DB}.public_race_claims AS rc FINAL
            WHERE rc._peerdb_is_deleted = 0
              AND rc.user_id IN (SELECT id FROM real_users)
            GROUP BY rc.user_id
          ),
          period_top AS (
            SELECT
              rc.user_id AS user_id,
              u.username AS username,
              uniqExact((rc.race_type, rc.race_period_start)) AS race_count,
              sum(rc.prize_amount_usd) AS total_prize
            FROM ${CH_DB}.public_race_claims AS rc FINAL
            INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = rc.user_id
            WHERE rc._peerdb_is_deleted = 0
              AND u._peerdb_is_deleted = 0
              AND rc.user_id IN (SELECT id FROM real_users)
              ${dateClause}
            GROUP BY rc.user_id, u.username
            HAVING sum(rc.prize_amount_usd) > 0
            ORDER BY sum(rc.prize_amount_usd) DESC
            LIMIT ${TOP_LIMIT}
          )
        SELECT
          p.user_id               AS user_id,
          p.username              AS username,
          toString(p.race_count)  AS race_count,
          toString(p.total_prize) AS total_prize,
          toString(coalesce(l.total, toDecimal128(0, 2))) AS lifetime_total
        FROM period_top AS p
        LEFT JOIN lifetime AS l ON l.user_id = p.user_id
        ORDER BY p.total_prize DESC`,
      params,
    }),
    clickhouseRead.query<LifetimeRow>({
      queryName: "insights.rewards.race.top-winners.lifetime",
      sql: `
        WITH ${scope}
        SELECT
          rc.user_id AS user_id,
          u.username AS username,
          toString(uniqExact((rc.race_type, rc.race_period_start))) AS race_count,
          toString(sum(rc.prize_amount_usd)) AS total_prize
        FROM ${CH_DB}.public_race_claims AS rc FINAL
        INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = rc.user_id
        WHERE rc._peerdb_is_deleted = 0
          AND u._peerdb_is_deleted = 0
          AND rc.user_id IN (SELECT id FROM real_users)
        GROUP BY rc.user_id, u.username
        HAVING sum(rc.prize_amount_usd) > 0
        ORDER BY sum(rc.prize_amount_usd) DESC
        LIMIT ${TOP_LIMIT}`,
      params,
    }),
  ]);

  const periodWinners: RaceTopWinner[] = periodRows.map((r) => {
    const totalPrize = toNumber(r.total_prize);
    const raceCount = Number(r.race_count ?? 0);
    return {
      userId: r.user_id,
      username: r.username,
      raceCount,
      totalPrize,
      avgPrize: raceCount > 0 ? totalPrize / raceCount : 0,
      lifetimeTotal: toNumber(r.lifetime_total),
    };
  });

  const lifetimeWinners: RaceTopWinner[] = lifetimeRows.map((r) => {
    const totalPrize = toNumber(r.total_prize);
    const raceCount = Number(r.race_count ?? 0);
    return {
      userId: r.user_id,
      username: r.username,
      raceCount,
      totalPrize,
      avgPrize: raceCount > 0 ? totalPrize / raceCount : 0,
      lifetimeTotal: totalPrize,
    };
  });

  return { period: periodWinners, lifetime: lifetimeWinners };
}
