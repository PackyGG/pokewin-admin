import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { AffiliateGeoBreakdown } from "@/lib/queries/insights-rewards/affiliate/geo";

import { getAffiliateGeoBreakdownFromClickHouse } from "../queries/insights-rewards/affiliate/geo";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the affiliate Geo tab. No-op unless the
 * `insights_affiliate_geo` surface is in `comparison` mode. The grand totals +
 * the summed top-12 bucket totals are diffed within half a cent; the bucket
 * counts + summed distinct-user counts exactly. (Top-12 membership can shift on
 * a tie; the grand totals are the robust exact fields.) Swallows every error so
 * the served Postgres payload is never affected.
 */
const MONEY_FIELDS = [
  "totalCommission",
  "totalDownstreamWager",
  "affCommissionSum",
  "refWagerSum",
] as const;

function flatten(d: AffiliateGeoBreakdown): Record<string, number> {
  return {
    totalCommission: d.totalCommission,
    totalDownstreamWager: d.totalDownstreamWager,
    affCount: d.affiliateGeo.length,
    refCount: d.referredGeo.length,
    affCommissionSum: d.affiliateGeo.reduce((a, r) => a + r.commission, 0),
    refWagerSum: d.referredGeo.reduce((a, r) => a + r.downstreamWager, 0),
    affUserSum: d.affiliateGeo.reduce((a, r) => a + r.affiliateCount, 0),
    refUserSum: d.referredGeo.reduce((a, r) => a + r.referredUserCount, 0),
  };
}

export async function compareAffiliateGeo(
  period: InsightsRewardsPeriod,
  pgValues: AffiliateGeoBreakdown,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_affiliate_geo");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getAffiliateGeoBreakdownFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_affiliate_geo[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_affiliate_geo",
      "comparison failed (ignored)",
      err,
    );
  }
}
