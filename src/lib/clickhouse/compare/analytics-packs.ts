import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type {
  BattleModeStats,
  PackPopularityStats,
} from "@/lib/queries/analytics";
import type {
  PacksPeriod,
  PacksProfitData,
  TopPack24hRow,
} from "@/lib/queries/analytics-packs";

import {
  getPackProfitabilityFromClickHouse,
  getTopOpenedPacks24hFromClickHouse,
  getPackAndBattleStatsFromClickHouse,
} from "../queries/analytics/packs";
import type { PackBattlePeriod } from "../queries/analytics/_pack-battle-shared";
import { computeDrift, logComparison, timeCh } from "./_core";
import { flattenBattleStats, flattenPackStats } from "./analytics-overview";

/**
 * Fire-and-forget comparisons for the /analytics PACKS tab. Three independent
 * legs, each gating on its own surface flag (no-op unless `comparison` mode,
 * forced `off` while ClickHouse is dormant):
 *
 *   • analytics_packs_profitability → `getPackProfitability` deep-dive.
 *   • analytics_packs_top24h        → `getTopOpenedPacks24h` leaderboard.
 *   • analytics_packs_stats         → `getPackAndBattleStats` slim bundle.
 *
 * Counts must match exactly; money fields within half a cent. The exact per-row
 * top-N set/order (revenue / opens leaderboards) is the documented §5c caveat
 * over a tied-boundary population — row count + the summed fields ARE diffed.
 * Every error is swallowed so the served Postgres payload is never affected.
 */

const PROFIT_SURFACE = "analytics_packs_profitability";
const TOP24H_SURFACE = "analytics_packs_top24h";
const STATS_SURFACE = "analytics_packs_stats";

function flattenProfit(d: PacksProfitData): Record<string, number> {
  return {
    packsRows: d.packs.length,
    packsOpensSum: d.packs.reduce((a, r) => a + r.opens, 0),
    packsRevenueSum: d.packs.reduce((a, r) => a + r.revenue, 0),
    packsPayoutsSum: d.packs.reduce((a, r) => a + r.payouts, 0),
    packsTopRevenue: d.packs[0]?.revenue ?? 0,
    battlesRows: d.battles.length,
    battlesPlayedSum: d.battles.reduce((a, r) => a + r.battlesPlayed, 0),
    battlesRevenueSum: d.battles.reduce((a, r) => a + r.revenue, 0),
    battlesPayoutsSum: d.battles.reduce((a, r) => a + r.payouts, 0),
    battlesTopRevenue: d.battles[0]?.revenue ?? 0,
  };
}
const PROFIT_MONEY = [
  "packsRevenueSum",
  "packsPayoutsSum",
  "packsTopRevenue",
  "battlesRevenueSum",
  "battlesPayoutsSum",
  "battlesTopRevenue",
] as const;

export async function comparePackProfitability(
  period: PacksPeriod,
  pgData: PacksProfitData,
): Promise<void> {
  try {
    const mode = await getAdminReadMode(PROFIT_SURFACE);
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getPackProfitabilityFromClickHouse(period, blacklist);
    });
    const drift = computeDrift(
      flattenProfit(pgData),
      flattenProfit(ch),
      PROFIT_MONEY,
    );
    logComparison(`analytics_packs_profitability[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      `clickhouse.compare.${PROFIT_SURFACE}`,
      "comparison failed (ignored)",
      err,
    );
  }
}

function flattenTop24h(rows: TopPack24hRow[]): Record<string, number> {
  return {
    rowCount: rows.length,
    opensSum: rows.reduce((a, r) => a + r.opens, 0),
    topOpens: rows[0]?.opens ?? 0,
  };
}

export async function compareTopOpenedPacks24h(
  limit: number,
  pgRows: TopPack24hRow[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode(TOP24H_SURFACE);
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getTopOpenedPacks24hFromClickHouse(limit, blacklist);
    });
    const drift = computeDrift(flattenTop24h(pgRows), flattenTop24h(ch), []);
    logComparison(`analytics_packs_top24h[limit=${limit}]`, drift, durationMs);
  } catch (err) {
    logError(
      `clickhouse.compare.${TOP24H_SURFACE}`,
      "comparison failed (ignored)",
      err,
    );
  }
}

export async function comparePackAndBattleStats(
  period: PackBattlePeriod,
  pgData: { battleStats: BattleModeStats; packStats: PackPopularityStats },
): Promise<void> {
  try {
    const mode = await getAdminReadMode(STATS_SURFACE);
    if (mode !== "comparison") return;
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getPackAndBattleStatsFromClickHouse(period, blacklist);
    });
    const pg = {
      ...flattenBattleStats(pgData.battleStats),
      ...flattenPackStats(pgData.packStats),
    };
    const chFlat = {
      ...flattenBattleStats(ch.battleStats),
      ...flattenPackStats(ch.packStats),
    };
    const drift = computeDrift(pg, chFlat, []);
    logComparison(`analytics_packs_stats[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      `clickhouse.compare.${STATS_SURFACE}`,
      "comparison failed (ignored)",
      err,
    );
  }
}
