import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type {
  LifetimePrizesBreakdown,
  PrizeBudgetBreakdown,
} from "@/lib/queries/rewards-analytics-leaderboards";

import {
  getLifetimePrizesBreakdownFromClickHouse,
  getPrizeBudgetBreakdownFromClickHouse,
} from "../queries/rewards-analytics/extras";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the /rewards/analytics "extras" leg — the
 * lifetime-prizes-by-race-type breakdown + the prize-budget tier breakdown
 * (`daily` + `weekly`). No-op unless the `rewards_analytics_extras` surface is
 * in `comparison` mode. Diffs the lifetime total + prize-budget total within
 * half a cent; the lifetime claim count, race-type row count, and tier row
 * count exactly. Swallows every error so the served Postgres payload is never
 * affected.
 */

const MONEY_FIELDS = ["lifetimeTotal", "budgetTotal"] as const;

function flatten(
  lifetime: LifetimePrizesBreakdown,
  budget: PrizeBudgetBreakdown,
): Record<string, number> {
  return {
    lifetimeTotal: lifetime.total,
    lifetimeClaims: lifetime.claims,
    lifetimeRaceTypeCount: lifetime.byRaceType.length,
    budgetTotal: budget.total,
    budgetRowCount: budget.rows.length,
  };
}

export async function compareRewardsAnalyticsExtras(
  pgLifetime: LifetimePrizesBreakdown,
  pgBudget: PrizeBudgetBreakdown,
  budgetRaceTypes: string[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("rewards_analytics_extras");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      const [lifetime, budget] = await Promise.all([
        getLifetimePrizesBreakdownFromClickHouse(blacklist),
        getPrizeBudgetBreakdownFromClickHouse(budgetRaceTypes),
      ]);
      return { lifetime, budget };
    });

    const drift = computeDrift(
      flatten(pgLifetime, pgBudget),
      flatten(ch.lifetime, ch.budget),
      MONEY_FIELDS,
    );
    logComparison("rewards_analytics_extras", drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.rewards_analytics_extras",
      "comparison failed (ignored)",
      err,
    );
  }
}
