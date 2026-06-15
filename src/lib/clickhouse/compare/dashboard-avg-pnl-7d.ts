import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";

import { getWindowedPnlFromClickHouse } from "../queries/dashboard/windowed-pnl";
import { computeDrift, logComparison, timeCh } from "./_core";

const ROLLING_7D_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Fire-and-forget comparison for the Dashboard "Avg P&L 7d" snapshot box
 * (`getAvgPnl7d`). No-op unless the `dashboard_avg_pnl_7d` surface is in
 * `comparison` mode (forced off whenever ClickHouse is dormant). Swallows every
 * error — the served Postgres payload is never affected.
 *
 * The PG box is `calculateWindowedPnl({ since: now − 7d })` → `{ totalPnl7d =
 * pnl, avgDailyPnl = pnl/7 }`. The CH twin computes the SAME rolling 7d
 * windowed P&L and derives the two figures identically.
 */
export async function compareDashboardAvgPnl7d(pgValues: {
  totalPnl7d: number;
  avgDailyPnl: number;
}): Promise<void> {
  try {
    const mode = await getAdminReadMode("dashboard_avg_pnl_7d");
    if (mode !== "comparison") return;

    const since = new Date(Date.now() - ROLLING_7D_MS);
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getWindowedPnlFromClickHouse(since, blacklist);
    });
    const drift = computeDrift(
      { totalPnl7d: pgValues.totalPnl7d, avgDailyPnl: pgValues.avgDailyPnl },
      { totalPnl7d: ch.pnl, avgDailyPnl: ch.pnl / 7 },
      ["totalPnl7d", "avgDailyPnl"],
    );
    logComparison("dashboard.avgPnl7d", drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.dashboard_avg_pnl_7d",
      "comparison failed (ignored)",
      err,
    );
  }
}
