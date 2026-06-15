import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import type { CodePerformanceRow } from "@/lib/queries/insights-rewards/affiliate/code-performance";

import { getAffiliateCodePerformanceFromClickHouse } from "../queries/insights-rewards/affiliate/code-performance";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the affiliate Code-performance tab. No-op
 * unless the `insights_affiliate_code_perf` surface is in `comparison` mode. The
 * summed downstream wager + accrued commission are diffed within half a cent;
 * the row count + summed funnel counts (clicks / signups / depositors /
 * wagerers) exactly. (Top-25 membership can shift on a wager tie; the summed
 * aggregates are the robust fields.) Swallows every error so the served Postgres
 * payload is never affected.
 */
const MONEY_FIELDS = ["totalDownstreamWagerSum", "commissionAccruedSum"] as const;

function flatten(rows: CodePerformanceRow[]): Record<string, number> {
  return {
    rowCount: rows.length,
    clicksSum: rows.reduce((a, r) => a + r.clicks, 0),
    signupsSum: rows.reduce((a, r) => a + r.signups, 0),
    depositorsSum: rows.reduce((a, r) => a + r.depositors, 0),
    wagerersSum: rows.reduce((a, r) => a + r.wagerers, 0),
    totalDownstreamWagerSum: rows.reduce((a, r) => a + r.totalDownstreamWager, 0),
    commissionAccruedSum: rows.reduce((a, r) => a + r.commissionAccrued, 0),
  };
}

export async function compareAffiliateCodePerf(
  period: InsightsRewardsPeriod,
  pgValues: CodePerformanceRow[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_affiliate_code_perf");
    if (mode !== "comparison") return;

    const now = new Date();
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getAffiliateCodePerformanceFromClickHouse(period, blacklist, now);
    });

    const drift = computeDrift(flatten(pgValues), flatten(ch), MONEY_FIELDS);
    logComparison(`insights_affiliate_code_perf[${period}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_affiliate_code_perf",
      "comparison failed (ignored)",
      err,
    );
  }
}
