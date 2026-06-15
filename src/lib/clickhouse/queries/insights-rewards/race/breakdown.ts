import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { RaceBreakdownRow } from "@/lib/queries/insights-rewards/race/breakdown";

import { CH_DB, chDateTime, toNumber } from "../../_shared";
import { raceScopeCte } from "./_scope";

/**
 * ClickHouse twin of `getRaceInsightsBreakdown`
 * (`src/lib/queries/insights-rewards/race/breakdown.ts`).
 *
 * PARITY: one row per (race_type, race_period_start) — prize pool, winner count
 * (prize lines), min/max position, and the top (lowest-position) winner's
 * user + prize, plus the per-race-type configured budget summed from
 * `public_race_prize_tiers`. `tierUtilisation` + `positionSpread` are derived in
 * TS identically to the PG twin. Rows are returned sorted by prize pool desc.
 *
 * The PG twin attaches the top winner via `DISTINCT ON ... ORDER BY position
 * ASC`; CH reproduces the lowest-position pick with `argMin(user_id, position)`
 * / `argMin(prize, position)`. On a position tie either engine may pick a
 * different user, so the compare hook diffs only the stable aggregates (Σ pool,
 * Σ winner_count, Σ min/max position, Σ top_prize — prize is fixed per position
 * tier — and Σ configured budget), never the per-race top-winner identity.
 *
 * SCOPE (mirrors PG EXACTLY): `role NOT IN ('admin','support')` (creators KEPT)
 * + blacklist — `raceScopeCte`.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0` on every mirror table, money
 * Decimal (`toString(sum(...))` → `toNumber`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

type RaceRow = {
  race_type: string;
  period_start: string;
  prize_pool: string;
  winner_count: string;
  top_position: string;
  max_position: string;
  top_prize: string;
  top_user_id: string;
  top_username: string | null;
};

type TierRow = { race_type: string; total: string };

export async function getRaceInsightsBreakdownFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RaceBreakdownRow[]> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const scope = raceScopeCte(hasBlacklist);

  const params: Record<string, unknown> = { blacklist };
  let dateClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    dateClause = "AND rc.claimed_at >= {cutoff:DateTime64(6)}";
  }

  const [races, tiers] = await Promise.all([
    clickhouseRead.query<RaceRow>({
      queryName: "insights.rewards.race.breakdown.races",
      sql: `
        WITH
          ${scope},
          per_race AS (
            SELECT
              rc.race_type           AS race_type,
              rc.race_period_start   AS period_start,
              sum(rc.prize_amount_usd) AS prize_pool,
              count()                AS winner_count,
              min(rc.position)       AS top_position,
              max(rc.position)       AS max_position,
              argMin(rc.user_id, rc.position)          AS top_user_id,
              argMin(rc.prize_amount_usd, rc.position) AS top_prize
            FROM ${CH_DB}.public_race_claims AS rc FINAL
            WHERE rc._peerdb_is_deleted = 0
              AND rc.user_id IN (SELECT id FROM real_users)
              ${dateClause}
            GROUP BY rc.race_type, rc.race_period_start
          )
        SELECT
          p.race_type                AS race_type,
          toString(p.period_start)   AS period_start,
          toString(p.prize_pool)     AS prize_pool,
          toString(p.winner_count)   AS winner_count,
          toString(p.top_position)   AS top_position,
          toString(p.max_position)   AS max_position,
          toString(p.top_prize)      AS top_prize,
          p.top_user_id              AS top_user_id,
          u.username                 AS top_username
        FROM per_race AS p
        INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = p.top_user_id
        WHERE u._peerdb_is_deleted = 0
        ORDER BY p.prize_pool DESC`,
      params,
    }),
    clickhouseRead.query<TierRow>({
      queryName: "insights.rewards.race.breakdown.tiers",
      sql: `
        SELECT
          t.race_type                AS race_type,
          toString(sum(t.prize_amount_usd)) AS total
        FROM ${CH_DB}.public_race_prize_tiers AS t FINAL
        WHERE t._peerdb_is_deleted = 0
        GROUP BY t.race_type`,
    }),
  ]);

  const budgetByType = new Map<string, number>();
  for (const t of tiers) budgetByType.set(t.race_type, toNumber(t.total));

  return races.map((r) => {
    const prizePool = toNumber(r.prize_pool);
    const configuredBudget = budgetByType.get(r.race_type) ?? null;
    const tierUtilisation =
      configuredBudget !== null && configuredBudget > 0
        ? prizePool / configuredBudget
        : null;
    const topPosition = Number(r.top_position);
    const maxPosition = Number(r.max_position);
    const positionSpread =
      Number.isFinite(topPosition) && Number.isFinite(maxPosition)
        ? maxPosition - topPosition + 1
        : 0;
    return {
      raceType: r.race_type,
      periodStart: r.period_start,
      prizePool,
      winnerCount: Number(r.winner_count),
      topPosition,
      topPrize: toNumber(r.top_prize),
      topUserId: r.top_user_id,
      topUsername: r.top_username,
      positionSpread,
      configuredBudget,
      tierUtilisation,
    };
  });
}
