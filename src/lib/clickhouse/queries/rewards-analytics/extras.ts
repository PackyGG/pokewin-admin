import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { toNumber } from "@/lib/utils/decimal";
import type {
  LifetimePrizesBreakdown,
  LifetimePrizesByRaceType,
  PrizeBudgetBreakdown,
  PrizeBudgetTierRow,
} from "@/lib/queries/rewards-analytics-leaderboards";

import { CH_DB, customerScopeCte } from "../_shared";

/**
 * ClickHouse twins of the /rewards/analytics "extras" leg:
 *   • `getLifetimePrizesBreakdown` — per-race-type lifetime prize payout
 *     (Σ `race_claims.prize_amount_usd` + claim count), scoped to real
 *     customers (`role NOT IN ('admin','support','creator')` + blacklist).
 *   • `getPrizeBudgetBreakdown` — every `race_prize_tiers` row for the
 *     requested race types (catalog table — NO user scope).
 *
 * SCOPE (mirrors PG EXACTLY): lifetime-prizes uses the wholesale customer scope
 * (`customerScopeCte`); prize-budget reads the tier catalog unscoped.
 * Money Decimal end-to-end; sorting replicated in TS exactly like the PG twin.
 */

type LifetimeRow = { race_type: string; total: string; claims: string };

export async function getLifetimePrizesBreakdownFromClickHouse(
  blacklist: string[],
): Promise<LifetimePrizesBreakdown> {
  const hasBlacklist = blacklist.length > 0;
  const scope = customerScopeCte({ hasBlacklist });

  const rows = await clickhouseRead.query<LifetimeRow>({
    queryName: "rewards.analytics.extras.lifetime-prizes",
    sql: `
      WITH ${scope}
      SELECT
        rc.race_type                          AS race_type,
        toString(sum(rc.prize_amount_usd))    AS total,
        toString(count())                     AS claims
      FROM ${CH_DB}.public_race_claims AS rc FINAL
      WHERE rc._peerdb_is_deleted = 0
        AND rc.user_id IN (SELECT id FROM real_users)
      GROUP BY rc.race_type`,
    params: { blacklist },
  });

  const byRaceType: LifetimePrizesByRaceType[] = rows
    .map((r) => ({
      raceType: r.race_type,
      total: toNumber(r.total),
      claims: Number(r.claims),
    }))
    .sort((a, b) => b.total - a.total);
  const total = byRaceType.reduce((a, r) => a + r.total, 0);
  const claims = byRaceType.reduce((a, r) => a + r.claims, 0);
  return { byRaceType, total, claims };
}

type TierRow = { race_type: string; position: string; prize: string };

export async function getPrizeBudgetBreakdownFromClickHouse(
  raceTypes: string[],
): Promise<PrizeBudgetBreakdown> {
  const rows = await clickhouseRead.query<TierRow>({
    queryName: "rewards.analytics.extras.prize-budget",
    sql: `
      SELECT
        t.race_type               AS race_type,
        toString(t.position)      AS position,
        toString(t.prize_amount_usd) AS prize
      FROM ${CH_DB}.public_race_prize_tiers AS t FINAL
      WHERE t._peerdb_is_deleted = 0
        AND t.race_type IN {raceTypes:Array(String)}
      ORDER BY t.race_type ASC, t.position ASC`,
    params: { raceTypes },
  });

  const tierRows: PrizeBudgetTierRow[] = rows.map((r) => ({
    raceType: r.race_type,
    position: Number(r.position),
    prizeAmountUsd: toNumber(r.prize),
  }));
  const total = tierRows.reduce((a, r) => a + r.prizeAmountUsd, 0);
  return { rows: tierRows, total };
}
