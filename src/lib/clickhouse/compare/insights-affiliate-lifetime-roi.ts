import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { LifetimeRoiRow } from "@/lib/queries/insights-rewards/affiliate/lifetime-roi";

import { getAffiliateLifetimeRoiFromClickHouse } from "../queries/insights-rewards/affiliate/lifetime-roi";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the affiliate Lifetime-ROI tab. No-op unless
 * the `insights_affiliate_lifetime_roi` surface is in `comparison` mode.
 * Period-agnostic (lifetime). The summed lifetime money columns (commission
 * paid, accrued available, earned gross, downstream wager, ROI proxy) are diffed
 * within half a cent; the row count + summed referral count exactly. (Top-25
 * membership can shift on a payout tie; the summed aggregates are the robust
 * fields.) Swallows every error so the served Postgres payload is never
 * affected.
 */
const MONEY_FIELDS = [
  "lifetimeCommissionPaidSum",
  "lifetimeAccruedAvailableSum",
  "lifetimeEarnedGrossSum",
  "lifetimeDownstreamWagerSum",
  "roiProxySum",
] as const;

function flatten(rows: LifetimeRoiRow[]): Record<string, number> {
  return {
    rowCount: rows.length,
    totalReferredSum: rows.reduce((a, r) => a + r.totalReferred, 0),
    lifetimeCommissionPaidSum: rows.reduce((a, r) => a + r.lifetimeCommissionPaid, 0),
    lifetimeAccruedAvailableSum: rows.reduce((a, r) => a + r.lifetimeAccruedAvailable, 0),
    lifetimeEarnedGrossSum: rows.reduce((a, r) => a + r.lifetimeEarnedGross, 0),
    lifetimeDownstreamWagerSum: rows.reduce((a, r) => a + r.lifetimeDownstreamWager, 0),
    roiProxySum: rows.reduce((a, r) => a + r.roiProxyUsd, 0),
  };
}

export async function compareAffiliateLifetimeRoi(
  pgValues: LifetimeRoiRow[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_affiliate_lifetime_roi");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getAffiliateLifetimeRoiFromClickHouse(blacklist);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison("insights_affiliate_lifetime_roi", drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_affiliate_lifetime_roi",
      "comparison failed (ignored)",
      err,
    );
  }
}
