import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type {
  RewardCategoryBreakdown,
  RewardCategoryKey,
  RewardsPeriod,
} from "@/lib/queries/rewards-analytics";

import { getRewardCategoryBreakdownFromClickHouse } from "../queries/rewards-analytics/category-breakdown";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the /rewards/analytics per-category drilldown
 * leg (7 categories). No-op unless the `rewards_analytics_category` surface is
 * in `comparison` mode. For each category diffs the breakdown total within half
 * a cent and the row count + breakdown count exactly. Swallows every error so
 * the served Postgres payload is never affected.
 */

const MONEY_FIELDS = ["total"] as const;

function flatten(b: RewardCategoryBreakdown): Record<string, number> {
  return {
    total: b.total,
    count: b.count,
    rowCount: b.rows.length,
  };
}

export async function compareRewardsAnalyticsCategories(
  period: RewardsPeriod,
  pgBreakdownByCategory: Record<RewardCategoryKey, RewardCategoryBreakdown>,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("rewards_analytics_category");
    if (mode !== "comparison") return;

    const now = new Date();
    const blacklist = await getExcludedUserIds();
    const keys = Object.keys(pgBreakdownByCategory) as RewardCategoryKey[];

    for (const key of keys) {
      const { result: ch, durationMs } = await timeCh(() =>
        getRewardCategoryBreakdownFromClickHouse(period, key, blacklist, now),
      );
      const drift = computeDrift(
        flatten(pgBreakdownByCategory[key]),
        flatten(ch),
        MONEY_FIELDS,
      );
      logComparison(
        `rewards_analytics_category[${period}:${key}]`,
        drift,
        durationMs,
      );
    }
  } catch (err) {
    logError(
      "clickhouse.compare.rewards_analytics_category",
      "comparison failed (ignored)",
      err,
    );
  }
}
