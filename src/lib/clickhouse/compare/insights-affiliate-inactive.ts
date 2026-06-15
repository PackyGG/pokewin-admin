import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { InactiveAffiliateRow } from "@/lib/queries/insights-rewards/affiliate/inactive";

import { getInactiveAffiliatesFromClickHouse } from "../queries/insights-rewards/affiliate/inactive";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the affiliate Inactive tab. No-op unless the
 * `insights_affiliate_inactive` surface is in `comparison` mode. The summed
 * lifetime payout + in-window downstream wager are diffed within half a cent;
 * the row count + summed referrals + has-window-usage count exactly. (Top-25
 * membership can shift on a payout tie; the summed aggregates are the robust
 * fields.) Swallows every error so the served Postgres payload is never
 * affected.
 */
const MONEY_FIELDS = [
  "totalPaidOutLifetimeSum",
  "windowDownstreamWagerSum",
] as const;

function flatten(rows: InactiveAffiliateRow[]): Record<string, number> {
  return {
    rowCount: rows.length,
    totalReferredSum: rows.reduce((a, r) => a + r.totalReferred, 0),
    totalPaidOutLifetimeSum: rows.reduce((a, r) => a + r.totalPaidOutLifetime, 0),
    windowDownstreamWagerSum: rows.reduce((a, r) => a + r.windowDownstreamWager, 0),
    hasWindowUsageCount: rows.reduce((a, r) => a + (r.hasWindowUsage ? 1 : 0), 0),
  };
}

export async function compareAffiliateInactive(
  period: InsightsRewardsPeriod,
  pgValues: InactiveAffiliateRow[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_affiliate_inactive");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getInactiveAffiliatesFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_affiliate_inactive[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_affiliate_inactive",
      "comparison failed (ignored)",
      err,
    );
  }
}
