import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { ClaimCadenceRow } from "@/lib/queries/insights-rewards/affiliate/claim-cadence";

import { getAffiliateClaimCadenceFromClickHouse } from "../queries/insights-rewards/affiliate/claim-cadence";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the affiliate Claim-cadence tab. No-op unless
 * the `insights_affiliate_cadence` surface is in `comparison` mode. The summed
 * money columns (total / mean / median claim amount) are diffed within half a
 * cent; the row count + summed claim count exactly.
 *
 * The GAP statistics (mean/median hours between claims) are intentionally NOT
 * compared: a gap depends on the ordering of equal-timestamp claims, which each
 * engine breaks independently, so diffing them would surface false drift. They
 * are present in the served Postgres payload either way.
 *
 * Swallows every error so the served Postgres payload is never affected.
 */
const MONEY_FIELDS = [
  "totalCommissionSum",
  "meanClaimAmountSum",
  "medianClaimAmountSum",
] as const;

function flatten(rows: ClaimCadenceRow[]): Record<string, number> {
  return {
    rowCount: rows.length,
    claimCountSum: rows.reduce((a, r) => a + r.claimCount, 0),
    totalCommissionSum: rows.reduce((a, r) => a + r.totalCommission, 0),
    meanClaimAmountSum: rows.reduce((a, r) => a + r.meanClaimAmount, 0),
    medianClaimAmountSum: rows.reduce((a, r) => a + r.medianClaimAmount, 0),
  };
}

export async function compareAffiliateCadence(
  period: InsightsRewardsPeriod,
  pgValues: ClaimCadenceRow[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_affiliate_cadence");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getAffiliateClaimCadenceFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_affiliate_cadence[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_affiliate_cadence",
      "comparison failed (ignored)",
      err,
    );
  }
}
