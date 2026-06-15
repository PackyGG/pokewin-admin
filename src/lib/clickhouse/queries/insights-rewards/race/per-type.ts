import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { RacePerTypeRow } from "@/lib/queries/insights-rewards/race/per-type";

import { CH_DB, chDateTime, toNumber } from "../../_shared";
import { raceScopeCte } from "./_scope";

/**
 * ClickHouse twin of `getRaceInsightsPerType`
 * (`src/lib/queries/insights-rewards/race/per-type.ts`).
 *
 * PARITY: per race_type (daily / weekly / monthly) — a claim rollup
 * (distinct races, prize pool, prize lines, distinct winners) from
 * `public_race_claims`, an entrant rollup (distinct races, total entries,
 * distinct entrants) from `public_race_leaderboard_snapshots`, and the
 * configured per-race budget from `public_race_prize_tiers`. All derived fields
 * (`tierBudgetForWindow`, `avgPrizePerRace`, `avgEntrantsPerRace`,
 * `conversionRate`, `tierUtilisation`) are computed in TS with the IDENTICAL
 * arithmetic the PG twin uses.
 *
 * Window edges mirror the PG twin EXACTLY: claims filter on
 * `claimed_at >= NOW() - INTERVAL 'N days'` (timestamp); snapshots filter on
 * `period_start >= (NOW() - INTERVAL 'N days')::date` (a DATE) — so the two
 * cutoffs are bound separately.
 *
 * SCOPE (mirrors PG EXACTLY): `role NOT IN ('admin','support')` (creators KEPT)
 * + blacklist — `raceScopeCte`.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0`, `uniqExact` for distinct
 * counts, money Decimal (`toString(sum(...))` → `toNumber`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const RACE_TYPES: Array<"daily" | "weekly" | "monthly"> = [
  "daily",
  "weekly",
  "monthly",
];

type ClaimRow = {
  race_type: string;
  distinct_races: string;
  prize_pool: string;
  winner_count: string;
  distinct_winners: string;
};

type EntrantRow = {
  race_type: string;
  distinct_races: string;
  total_entries: string;
  distinct_entrants: string;
};

type TierRow = { race_type: string; total: string };

export async function getRaceInsightsPerTypeFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RacePerTypeRow[]> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const scope = raceScopeCte(hasBlacklist);

  const params: Record<string, unknown> = { blacklist };
  let dateClaims = "";
  let dateSnapshots = "";
  if (days !== null) {
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    params.cutoff = chDateTime(cutoff);
    params.cutoffDate = cutoff.toISOString().slice(0, 10);
    dateClaims = "AND rc.claimed_at >= {cutoff:DateTime64(6)}";
    dateSnapshots = "AND rls.period_start >= {cutoffDate:Date}";
  }

  const [claimRows, entrantRows, tierRows] = await Promise.all([
    clickhouseRead.query<ClaimRow>({
      queryName: "insights.rewards.race.per-type.claims",
      sql: `
        WITH ${scope}
        SELECT
          rc.race_type                            AS race_type,
          toString(uniqExact(rc.race_period_start)) AS distinct_races,
          toString(sum(rc.prize_amount_usd))      AS prize_pool,
          toString(count())                       AS winner_count,
          toString(uniqExact(rc.user_id))         AS distinct_winners
        FROM ${CH_DB}.public_race_claims AS rc FINAL
        WHERE rc._peerdb_is_deleted = 0
          AND rc.user_id IN (SELECT id FROM real_users)
          ${dateClaims}
        GROUP BY rc.race_type`,
      params,
    }),
    clickhouseRead.query<EntrantRow>({
      queryName: "insights.rewards.race.per-type.entrants",
      sql: `
        WITH ${scope}
        SELECT
          rls.race_type                       AS race_type,
          toString(uniqExact(rls.period_start)) AS distinct_races,
          toString(count())                   AS total_entries,
          toString(uniqExact(rls.user_id))    AS distinct_entrants
        FROM ${CH_DB}.public_race_leaderboard_snapshots AS rls FINAL
        WHERE rls._peerdb_is_deleted = 0
          AND rls.user_id IN (SELECT id FROM real_users)
          ${dateSnapshots}
        GROUP BY rls.race_type`,
      params,
    }),
    clickhouseRead.query<TierRow>({
      queryName: "insights.rewards.race.per-type.tiers",
      sql: `
        SELECT
          t.race_type                       AS race_type,
          toString(sum(t.prize_amount_usd)) AS total
        FROM ${CH_DB}.public_race_prize_tiers AS t FINAL
        WHERE t._peerdb_is_deleted = 0
        GROUP BY t.race_type`,
    }),
  ]);

  const claimByType = new Map<
    string,
    {
      distinctRaces: number;
      prizePool: number;
      winnerCount: number;
      distinctWinners: number;
    }
  >();
  for (const r of claimRows) {
    claimByType.set(r.race_type, {
      distinctRaces: Number(r.distinct_races ?? 0),
      prizePool: toNumber(r.prize_pool),
      winnerCount: Number(r.winner_count ?? 0),
      distinctWinners: Number(r.distinct_winners ?? 0),
    });
  }
  const entrantByType = new Map<
    string,
    { distinctRaces: number; totalEntries: number; distinctEntrants: number }
  >();
  for (const r of entrantRows) {
    entrantByType.set(r.race_type, {
      distinctRaces: Number(r.distinct_races ?? 0),
      totalEntries: Number(r.total_entries ?? 0),
      distinctEntrants: Number(r.distinct_entrants ?? 0),
    });
  }
  const budgetByType = new Map<string, number>();
  for (const r of tierRows) budgetByType.set(r.race_type, toNumber(r.total));

  return RACE_TYPES.map((t) => {
    const claims = claimByType.get(t) ?? {
      distinctRaces: 0,
      prizePool: 0,
      winnerCount: 0,
      distinctWinners: 0,
    };
    const entrants = entrantByType.get(t) ?? {
      distinctRaces: 0,
      totalEntries: 0,
      distinctEntrants: 0,
    };
    const configuredBudget = budgetByType.get(t) ?? 0;
    const tierBudgetForWindow = configuredBudget * claims.distinctRaces;
    const tierUtilisation =
      tierBudgetForWindow > 0 ? claims.prizePool / tierBudgetForWindow : null;
    const avgPrizePerRace =
      claims.distinctRaces > 0 ? claims.prizePool / claims.distinctRaces : 0;
    const avgEntrantsPerRace =
      entrants.distinctRaces > 0
        ? entrants.totalEntries / entrants.distinctRaces
        : 0;
    const conversionRate =
      entrants.distinctEntrants > 0
        ? claims.distinctWinners / entrants.distinctEntrants
        : null;
    return {
      raceType: t,
      distinctRaces: claims.distinctRaces,
      prizePoolTotal: claims.prizePool,
      winnerCount: claims.winnerCount,
      distinctWinners: claims.distinctWinners,
      avgPrizePerRace,
      configuredBudget,
      tierBudgetForWindow,
      tierUtilisation,
      avgEntrantsPerRace,
      conversionRate,
    };
  });
}
