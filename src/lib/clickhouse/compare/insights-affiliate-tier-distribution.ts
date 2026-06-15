import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { TierDistribution } from "@/lib/queries/insights-rewards/affiliate/tier-distribution";

import { getAffiliateTierDistributionFromClickHouse } from "../queries/insights-rewards/affiliate/tier-distribution";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the affiliate Tier-distribution tab. No-op
 * unless the `insights_affiliate_tier_distribution` surface is in `comparison`
 * mode. Period-agnostic (lifetime). Per-level wager + commission are diffed
 * within half a cent; the total + per-level affiliate counts exactly. Swallows
 * every error so the served Postgres payload is never affected.
 */
function flatten(d: TierDistribution): Record<string, number> {
  const rec: Record<string, number> = {
    totalAffiliates: d.totalAffiliates,
    levelCount: d.rows.length,
  };
  for (const r of d.rows) {
    rec[`lvl${r.level}_count`] = r.affiliateCount;
    rec[`lvl${r.level}_wager`] = r.totalReferredWager;
    rec[`lvl${r.level}_paid`] = r.totalCommissionPaid;
  }
  return rec;
}

export async function compareAffiliateTierDistribution(
  pgValues: TierDistribution,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_affiliate_tier_distribution");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getAffiliateTierDistributionFromClickHouse(blacklist);
    });

    const pg = flatten(pgValues);
    const moneyFields = Object.keys(pg).filter(
      (k) => k.endsWith("_wager") || k.endsWith("_paid"),
    );
    const drift = computeDrift(pg, flatten(ch), moneyFields);
    logComparison("insights_affiliate_tier_distribution", drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_affiliate_tier_distribution",
      "comparison failed (ignored)",
      err,
    );
  }
}
