import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { HeatmapData, HeatmapPeriod } from "@/lib/queries/analytics-heatmap";

import { getActivityHeatmapFromClickHouse } from "../queries/analytics/heatmap";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the /analytics HEATMAP tab. No-op unless the
 * `analytics_heatmap` surface is in `comparison` mode. Diffs the grid's
 * aggregate signals (total + max wager $, total + max deposit counts, and the
 * count of non-empty cells) — per-cell exactness is proven by the parity
 * harness. Money fields pass within half a cent; counts must match exactly.
 */
function signals(d: {
  cells: ReadonlyArray<{ wager: number; deposits: number }>;
  totalWager: number;
  totalDeposits: number;
  maxWager: number;
  maxDeposits: number;
}): Record<string, number> {
  return {
    totalWager: d.totalWager,
    totalDeposits: d.totalDeposits,
    maxWager: d.maxWager,
    maxDeposits: d.maxDeposits,
    nonZeroCells: d.cells.filter((c) => c.wager > 0 || c.deposits > 0).length,
  };
}

export async function compareAnalyticsHeatmap(
  period: HeatmapPeriod,
  pg: HeatmapData,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("analytics_heatmap");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getActivityHeatmapFromClickHouse(period, blacklist);
    });

    const drift = computeDrift(signals(pg), signals(ch), [
      "totalWager",
      "maxWager",
    ]);
    logComparison(`analytics.heatmap[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.analytics_heatmap",
      "comparison failed (ignored)",
      err,
    );
  }
}
