import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriodCapped,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { RaffleForecastBaseline } from "@/lib/queries/insights-rewards/raffle/overview";
import { toNumber } from "@/lib/utils/decimal";

import { CH_DB, chDateTime } from "../../_shared";

/**
 * ClickHouse twin of `getRaffleForecastBaseline`
 * (`src/lib/queries/insights-rewards/raffle/overview.ts`) — the REAL baseline
 * that anchors the raffle forecast tab on /insights/rewards/raffle (and the
 * unified forecast hub). Phase 2B comparison-mode read from the prod game mirror
 * (`packy_prod`, PeerDB CDC).
 *
 * RECONSTRUCTED PRIZE VALUE (the raffle footgun): raffle prizes are NOT a
 * `ledger_transactions` money leg — each `raffles` row carries a `prizes` JSON
 * array (`[{ type:'pack'|'card', id, quantity? }]`) and the cost has to be
 * REBUILT by valuing each line at the LIVE item price (`packs.price` /
 * `cards.price` × quantity), exactly as the PG `buildRafflePrizeValuator` does.
 * Here that is reproduced with `JSONExtractArrayRaw` + `ARRAY JOIN` over the
 * prize lines, joined to `public_packs` / `public_cards` FINAL for the price.
 * Empirically cent-exact against PG on the settled (lifetime/365d) window. The
 * value references LIVE prices, so a pack/card price change not yet replicated
 * by CDC can transiently shift a historical raffle's value until the
 * packs/cards mirror catches up — that is replication lag, not a definition bug.
 *
 * SCOPE (mirrors the PG twin EXACTLY — NOT the wholesale customer scope):
 *   `role NOT IN ('admin','support')` (creators are KEPT, exactly as the PG
 *   raffle baseline does) + the dynamic `excluded_users` blacklist. Applied to
 *   BOTH the raffle WINNER (which raffles count) and the entrant (which entries
 *   feed participants / points), mirroring the PG winner-join + entrant-join.
 *
 * The window cutoff uses `daysForInsightsPeriodCapped` (lifetime → 365d, the
 * same bound the PG twin applies) derived from a single caller-supplied `now`,
 * matching the PG `NOW() - INTERVAL 'N days'` arithmetic (prod runs UTC). Money
 * stays Decimal end-to-end (`toString(sum(...))` in SQL → `toNumber()` in TS,
 * never Float). The per-raffle rows are aggregated in TS with the IDENTICAL
 * loop the PG twin uses, so totals / max / daily buckets / winner set match
 * byte-for-byte. The blacklist is passed IN by the caller so this module never
 * imports a Postgres/Prisma client (directly or transitively).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** One in-scope completed raffle with its reconstructed prize cost. */
type RaffleCostRow = {
  raffle_id: string;
  /** 'YYYY-MM-DD' (UTC) — `toDate(completed_at)`, matching PG completed_at UTC date. */
  date: string;
  winner: string | null;
  total_entries: number;
  /** Σ(price × qty) over valid prize lines, Decimal string ('0' when none). */
  cost: string;
};

type EntryRollupRow = {
  participants: string;
  entries: string;
  points: string;
};

/** 2-role scope CTE (creators KEPT) + optional blacklist — mirrors the PG twin. */
function realUsersCte(hasBlacklist: boolean): string {
  return `real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;
}

/** The in-scope completed-raffle filter (winner is an in-scope customer). */
const RAFFLE_FILTER = `r._peerdb_is_deleted = 0
        AND r.status = 'completed'
        AND r.completed_at IS NOT NULL
        AND r.completed_at >= {cutoff:DateTime64(6)}
        AND r.winner_user_id IN (SELECT id FROM real_users)`;

export async function getRaffleForecastBaselineFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RaffleForecastBaseline> {
  const days = daysForInsightsPeriodCapped(period);
  const hasBlacklist = blacklist.length > 0;
  const cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
  const params: Record<string, unknown> = { cutoff, blacklist };
  const scope = realUsersCte(hasBlacklist);

  const [costRows, entryRows] = await Promise.all([
    clickhouseRead.query<RaffleCostRow>({
      queryName: "insights.rewards.raffle.baseline.costs",
      sql: `
        WITH ${scope},
        in_scope AS (
          SELECT
            r.id                            AS raffle_id,
            toString(toDate(r.completed_at)) AS date,
            r.winner_user_id                AS winner,
            r.total_entries                 AS total_entries
          FROM ${CH_DB}.public_raffles AS r FINAL
          WHERE ${RAFFLE_FILTER}
        ),
        costs AS (
          SELECT raffle_id, sum(qty * price) AS cost
          FROM (
            SELECT
              r.id AS raffle_id,
              multiIf(JSONExtractInt(line, 'quantity') > 0, JSONExtractInt(line, 'quantity'), 1) AS qty,
              ifNull(
                if(JSONExtractString(line, 'type') = 'pack', pk.price, cd.price),
                toDecimal128(0, 2)
              ) AS price
            FROM ${CH_DB}.public_raffles AS r FINAL
            ARRAY JOIN JSONExtractArrayRaw(r.prizes) AS line
            LEFT JOIN (
              SELECT toString(id) AS id, price
              FROM ${CH_DB}.public_packs FINAL
              WHERE _peerdb_is_deleted = 0
            ) AS pk ON JSONExtractString(line, 'type') = 'pack' AND pk.id = JSONExtractString(line, 'id')
            LEFT JOIN (
              SELECT toString(id) AS id, price
              FROM ${CH_DB}.public_cards FINAL
              WHERE _peerdb_is_deleted = 0
            ) AS cd ON JSONExtractString(line, 'type') = 'card' AND cd.id = JSONExtractString(line, 'id')
            WHERE ${RAFFLE_FILTER}
              AND JSONExtractString(line, 'type') IN ('pack', 'card')
              AND JSONExtractString(line, 'id') != ''
          )
          GROUP BY raffle_id
        )
        SELECT
          toString(in_scope.raffle_id)                       AS raffle_id,
          in_scope.date                                      AS date,
          in_scope.winner                                    AS winner,
          in_scope.total_entries                             AS total_entries,
          toString(ifNull(costs.cost, toDecimal128(0, 2)))   AS cost
        FROM in_scope
        LEFT JOIN costs ON costs.raffle_id = in_scope.raffle_id`,
      params,
    }),
    clickhouseRead.query<EntryRollupRow>({
      queryName: "insights.rewards.raffle.baseline.entries",
      sql: `
        WITH ${scope},
        in_scope_raffles AS (
          SELECT r.id AS id
          FROM ${CH_DB}.public_raffles AS r FINAL
          WHERE ${RAFFLE_FILTER}
        )
        SELECT
          toString(uniqExact(re.user_id))   AS participants,
          toString(count())                 AS entries,
          toString(sum(re.points_spent))    AS points
        FROM ${CH_DB}.public_raffle_entries AS re FINAL
        WHERE re._peerdb_is_deleted = 0
          AND re.raffle_id IN (SELECT id FROM in_scope_raffles)
          AND re.user_id IN (SELECT id FROM real_users)`,
      params,
    }),
  ]);

  // No completed raffles in-window → same all-zero / null shape the PG twin
  // returns from its early exit.
  if (costRows.length === 0) {
    return {
      totalPrizeCost: 0,
      raffleCount: 0,
      uniqueWinners: 0,
      participants: 0,
      claimProbability: null,
      avgPrizePerRaffle: 0,
      avgPrizePerWinner: 0,
      maxRafflePrizeUsd: 0,
      avgEntriesPerRaffle: 0,
      avgPointsPerEntry: 0,
      dailyPrizes: [],
    };
  }

  // Replicate the PG twin's TS aggregation loop exactly.
  let totalPrizeCost = 0;
  let maxRafflePrizeUsd = 0;
  let totalEntries = 0;
  const winners = new Set<string>();
  const dailyMap = new Map<string, { cost: number; count: number }>();

  for (const row of costRows) {
    const cost = toNumber(row.cost);
    totalPrizeCost += cost;
    if (cost > maxRafflePrizeUsd) maxRafflePrizeUsd = cost;
    if (row.winner) winners.add(row.winner);
    totalEntries += Number(row.total_entries ?? 0);

    const bucket = dailyMap.get(row.date) ?? { cost: 0, count: 0 };
    bucket.cost += cost;
    bucket.count += 1;
    dailyMap.set(row.date, bucket);
  }

  const raffleCount = costRows.length;
  const uniqueWinners = winners.size;

  const entryAgg = entryRows[0];
  const participants = Number(entryAgg?.participants ?? 0);
  const entriesCounted = Number(entryAgg?.entries ?? 0);
  const pointsSpent = toNumber(entryAgg?.points);

  const claimProbability =
    participants > 0 ? Math.min(1, Math.max(0, uniqueWinners / participants)) : null;
  const avgPrizePerRaffle = raffleCount > 0 ? totalPrizeCost / raffleCount : 0;
  const avgPrizePerWinner = uniqueWinners > 0 ? totalPrizeCost / uniqueWinners : 0;
  const avgEntriesPerRaffle =
    raffleCount > 0 ? (entriesCounted > 0 ? entriesCounted : totalEntries) / raffleCount : 0;
  const avgPointsPerEntry = entriesCounted > 0 ? pointsSpent / entriesCounted : 0;

  const dailyPrizes = [...dailyMap.entries()]
    .map(([date, v]) => ({ date, cost: v.cost, count: v.count }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    totalPrizeCost,
    raffleCount,
    uniqueWinners,
    participants,
    claimProbability,
    avgPrizePerRaffle,
    avgPrizePerWinner,
    maxRafflePrizeUsd,
    avgEntriesPerRaffle,
    avgPointsPerEntry,
    dailyPrizes,
  };
}
