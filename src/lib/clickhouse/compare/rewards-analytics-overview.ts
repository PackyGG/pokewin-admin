import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type {
  RewardCategoryKey,
  RewardsAnalyticsData,
  RewardsPeriod,
} from "@/lib/queries/rewards-analytics";

import { getRewardsAnalyticsFromClickHouse } from "../queries/rewards-analytics/overview";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the /rewards/analytics Overview leg. No-op
 * unless the `rewards_analytics_overview` surface is in `comparison` mode.
 * Diffs the window aggregate — total reward cost + every per-category total
 * within half a cent; total count, every per-category count, the day count, and
 * the top-recipient aggregate (row count + summed reward + summed payout count)
 * exactly. The top-25 recipient aggregate is stable whenever the 25th-slot sum
 * is distinct (deterministic `total DESC, user_id ASC` tie-break — §5c).
 * Swallows every error so the served Postgres payload is never affected.
 */

const CATEGORY_KEYS: readonly RewardCategoryKey[] = [
  "bonuses",
  "rakeback",
  "affiliate",
  "rainRace",
  "signupPack",
  "waitlist",
  "houseCredits",
];

const MONEY_FIELDS = [
  "totalCost",
  ...CATEGORY_KEYS.map((k) => `${k}Total`),
  "recipientTotalSum",
] as const;

function flatten(data: RewardsAnalyticsData): Record<string, number> {
  const byKey = new Map(data.categories.map((c) => [c.key, c] as const));
  const out: Record<string, number> = {
    totalCost: data.totalCost,
    totalCount: data.totalCount,
    dayCount: data.daily.length,
    recipientCount: data.topRecipients.length,
    recipientTotalSum: data.topRecipients.reduce((a, r) => a + r.total, 0),
    recipientCountSum: data.topRecipients.reduce((a, r) => a + r.count, 0),
  };
  for (const key of CATEGORY_KEYS) {
    const c = byKey.get(key);
    out[`${key}Total`] = c?.total ?? 0;
    out[`${key}Count`] = c?.count ?? 0;
  }
  return out;
}

export async function compareRewardsAnalyticsOverview(
  period: RewardsPeriod,
  pgValues: RewardsAnalyticsData,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("rewards_analytics_overview");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRewardsAnalyticsFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`rewards_analytics_overview[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.rewards_analytics_overview",
      "comparison failed (ignored)",
      err,
    );
  }
}
