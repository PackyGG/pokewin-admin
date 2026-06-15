import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";

import { getUpgraderStatsFromClickHouse } from "../queries/dashboard/upgrader-stats";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the Dashboard "Upgrader Stats" panel
 * (`getUpgraderStats`). No-op unless the `dashboard_upgrader_stats` surface is
 * in `comparison` mode (forced off whenever ClickHouse is dormant). Swallows
 * every error — the served Postgres payload is never affected.
 *
 * Diffs the primitive lifetime figures (money: wager / payouts / pnl; counts:
 * bets / uniquePlayers / wins / losses). The derived display ratios
 * (edge / avgBet / hitRate) are NOT diffed — they are deterministic functions
 * of the primitives, so a primitive match implies them.
 */
export async function compareDashboardUpgraderStats(pgValues: {
  wager: number;
  payouts: number;
  pnl: number;
  bets: number;
  uniquePlayers: number;
  wins: number;
  losses: number;
}): Promise<void> {
  try {
    const mode = await getAdminReadMode("dashboard_upgrader_stats");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getUpgraderStatsFromClickHouse(blacklist);
    });
    const drift = computeDrift(
      {
        wager: pgValues.wager,
        payouts: pgValues.payouts,
        pnl: pgValues.pnl,
        bets: pgValues.bets,
        uniquePlayers: pgValues.uniquePlayers,
        wins: pgValues.wins,
        losses: pgValues.losses,
      },
      {
        wager: ch.wager,
        payouts: ch.payouts,
        pnl: ch.pnl,
        bets: ch.bets,
        uniquePlayers: ch.uniquePlayers,
        wins: ch.wins,
        losses: ch.losses,
      },
      ["wager", "payouts", "pnl"],
    );
    logComparison("dashboard.upgraderStats", drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.dashboard_upgrader_stats",
      "comparison failed (ignored)",
      err,
    );
  }
}
