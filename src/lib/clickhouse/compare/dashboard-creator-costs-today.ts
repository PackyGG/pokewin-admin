import "server-only";

import { logError } from "@/lib/errors/logger";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";

import { getCreatorCostsTodayFromClickHouse } from "../queries/dashboard/creator-costs-today";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the Dashboard "Creators Costs (today)" tile
 * (`getCreatorCostsToday`). No-op unless the `dashboard_creator_costs_today`
 * surface is in `comparison` mode (forced off whenever ClickHouse is dormant).
 * Swallows every error — the served Postgres payload is never affected.
 *
 * The CH twin reuses the SAME window start the PG path computed (today 00:00
 * UTC, carried as `dayStartIso`) so the two windows are identical. No blacklist
 * — the PG twin applies NO user scope (gross creator spend), so neither does
 * this comparison.
 */
export async function compareDashboardCreatorCostsToday(pgValues: {
  total: number;
  creatorWithdrawals: number;
  tips: number;
  leaderboardGross: number;
  dayStartIso: string;
}): Promise<void> {
  try {
    const mode = await getAdminReadMode("dashboard_creator_costs_today");
    if (mode !== "comparison") return;

    const since = new Date(pgValues.dayStartIso);
    const { result: ch, durationMs } = await timeCh(async () =>
      getCreatorCostsTodayFromClickHouse(since),
    );
    const drift = computeDrift(
      {
        total: pgValues.total,
        creatorWithdrawals: pgValues.creatorWithdrawals,
        tips: pgValues.tips,
        leaderboardGross: pgValues.leaderboardGross,
      },
      {
        total: ch.total,
        creatorWithdrawals: ch.creatorWithdrawals,
        tips: ch.tips,
        leaderboardGross: ch.leaderboardGross,
      },
      ["total", "creatorWithdrawals", "tips", "leaderboardGross"],
    );
    logComparison("dashboard.creatorCostsToday", drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.dashboard_creator_costs_today",
      "comparison failed (ignored)",
      err,
    );
  }
}
