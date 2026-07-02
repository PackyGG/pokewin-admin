import "server-only";

import { logError } from "@/lib/errors/logger";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

import { getCreatorCostsTodayFromClickHouse } from "../queries/dashboard/creator-costs-today";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the Dashboard "Creators Costs (today)" tile
 * (`getCreatorCostsToday`). No-op unless the `dashboard_creator_costs_today`
 * surface is in `comparison` mode (forced off whenever ClickHouse is dormant).
 * Swallows every error — the served Postgres payload is never affected.
 *
 * The CH twin reuses the SAME window start the PG path computed (today 00:00
 * UTC, carried as `dayStartIso`) so the two windows are identical. It also
 * threads the SAME `excluded_users` BLACKLIST the PG path applies (staff/creator
 * roles are NOT dropped — creators are the subject), so the parity comparison
 * stays apples-to-apples. Compares all four money figures including
 * `affiliate` (`affiliate_claim`, moved wholesale here from Reward Costs,
 * owner 2026-07-02).
 */
export async function compareDashboardCreatorCostsToday(pgValues: {
  total: number;
  creatorWithdrawals: number;
  tips: number;
  leaderboardGross: number;
  affiliate: number;
  dayStartIso: string;
}): Promise<void> {
  try {
    const mode = await getAdminReadMode("dashboard_creator_costs_today");
    if (mode !== "comparison") return;

    const since = new Date(pgValues.dayStartIso);
    const excludedIds = await getExcludedUserIds();
    const { result: ch, durationMs } = await timeCh(async () =>
      getCreatorCostsTodayFromClickHouse(since, excludedIds),
    );
    const drift = computeDrift(
      {
        total: pgValues.total,
        creatorWithdrawals: pgValues.creatorWithdrawals,
        tips: pgValues.tips,
        leaderboardGross: pgValues.leaderboardGross,
        affiliate: pgValues.affiliate,
      },
      {
        total: ch.total,
        creatorWithdrawals: ch.creatorWithdrawals,
        tips: ch.tips,
        leaderboardGross: ch.leaderboardGross,
        affiliate: ch.affiliate,
      },
      ["total", "creatorWithdrawals", "tips", "leaderboardGross", "affiliate"],
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
