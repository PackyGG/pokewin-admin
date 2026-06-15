import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type {
  RaceLeaderboardSummary,
  RewardsLeaderboardsData,
} from "@/lib/queries/rewards-analytics-leaderboards";

import { getRewardsLeaderboardsFromClickHouse } from "../queries/rewards-analytics/leaderboards";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the /rewards/analytics platform-leaderboards
 * leg. No-op unless the `rewards_analytics_leaderboards` surface is in
 * `comparison` mode. Diffs the deterministic aggregates — lifetime prizes paid
 * + per-race prize pools within half a cent; lifetime claim count + tier
 * positions exactly — plus the top-5-winner aggregate (summed prize + summed
 * wagered within half a cent, winner count exactly). The active-period winner
 * projection is the volatile sub-leg (live snapshots × tier amounts), so its
 * aggregate is CDC-lag/live sensitive while the ended-period aggregate is
 * settled (§5c). Swallows every error so the served Postgres payload is never
 * affected.
 */

const MONEY_FIELDS = [
  "lifetimePrizesPaid",
  "dailyPrizePool",
  "dailyTopPrizeSum",
  "dailyTopWageredSum",
  "weeklyPrizePool",
  "weeklyTopPrizeSum",
  "weeklyTopWageredSum",
] as const;

function summaryFields(
  prefix: string,
  s: RaceLeaderboardSummary,
): Record<string, number> {
  return {
    [`${prefix}PrizePool`]: s.prizePool,
    [`${prefix}PrizePositions`]: s.prizePositions,
    [`${prefix}TopCount`]: s.topWinners.length,
    [`${prefix}TopPrizeSum`]: s.topWinners.reduce(
      (a, w) => a + w.prizeAmountUsd,
      0,
    ),
    [`${prefix}TopWageredSum`]: s.topWinners.reduce(
      (a, w) => a + w.wageredUsd,
      0,
    ),
  };
}

function flatten(data: RewardsLeaderboardsData): Record<string, number> {
  return {
    lifetimePrizesPaid: data.lifetimePrizesPaid,
    lifetimeClaimsCount: data.lifetimeClaimsCount,
    ...summaryFields("daily", data.daily),
    ...summaryFields("weekly", data.weekly),
  };
}

export async function compareRewardsAnalyticsLeaderboards(
  pgValues: RewardsLeaderboardsData,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("rewards_analytics_leaderboards");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRewardsLeaderboardsFromClickHouse(blacklist);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison("rewards_analytics_leaderboards", drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.rewards_analytics_leaderboards",
      "comparison failed (ignored)",
      err,
    );
  }
}
