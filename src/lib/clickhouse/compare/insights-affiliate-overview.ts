import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { AffiliateOverview } from "@/lib/queries/insights-rewards/affiliate/overview";

import { getAffiliateOverviewFromClickHouse } from "../queries/insights-rewards/affiliate/overview";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the affiliate Overview tab. No-op unless the
 * `insights_affiliate_overview` surface is in `comparison` mode. Money figures
 * (commission, leaderboard prizes, downstream wager, ROI, daily series sums) are
 * diffed within half a cent; the headcounts / claim counts exactly. Swallows
 * every error so the served Postgres payload is never affected.
 */
const MONEY_FIELDS = [
  "totalCommissionPaid",
  "leaderboardPrizePaid",
  "totalAffiliateRewardCost",
  "downstreamWager",
  "avgCommissionPerAffiliate",
  "roiUsd",
  "commissionPctOfWager",
  "dailyCommissionSum",
  "dailyWagerSum",
] as const;

function flatten(o: AffiliateOverview): Record<string, number> {
  return {
    activeAffiliates: o.activeAffiliates,
    totalCommissionPaid: o.totalCommissionPaid,
    leaderboardPrizePaid: o.leaderboardPrizePaid,
    leaderboardPrizeCount: o.leaderboardPrizeCount,
    totalAffiliateRewardCost: o.totalAffiliateRewardCost,
    downstreamWager: o.downstreamWager,
    distinctReferredUsers: o.distinctReferredUsers,
    claimCount: o.claimCount,
    avgCommissionPerAffiliate: o.avgCommissionPerAffiliate,
    roiUsd: o.roiUsd,
    commissionPctOfWager: o.commissionPctOfWager ?? 0,
    dailyCommissionSum: o.dailyCommission.reduce((a, d) => a + d.commission, 0),
    dailyCommissionCountSum: o.dailyCommission.reduce((a, d) => a + d.count, 0),
    dailyWagerSum: o.dailyWager.reduce((a, d) => a + d.wager, 0),
  };
}

export async function compareAffiliateOverview(
  period: InsightsRewardsPeriod,
  pgValues: AffiliateOverview,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_affiliate_overview");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getAffiliateOverviewFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_affiliate_overview[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_affiliate_overview",
      "comparison failed (ignored)",
      err,
    );
  }
}
